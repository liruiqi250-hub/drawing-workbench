param([string]$DownloadCache,[switch]$Offline)
$ErrorActionPreference='Stop'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
$appDirectory=Split-Path -Parent $PSScriptRoot
if(-not [Environment]::Is64BitOperatingSystem){throw '桌面安装包构建需要 Windows x64。'}
$backendManifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
$desktopManifest=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'desktop-runtime-manifest.json') -Raw -Encoding UTF8|ConvertFrom-Json
$version=(Get-Content -LiteralPath (Join-Path $appDirectory 'package.json') -Raw -Encoding UTF8|ConvertFrom-Json).version
if($version -ne $desktopManifest.version){throw '源码与桌面依赖清单版本不符。'}
if(-not $DownloadCache){$DownloadCache=Join-Path $appDirectory '.downloads/desktop'}
$DownloadCache=[IO.Path]::GetFullPath($DownloadCache)
New-Item -ItemType Directory -Force -Path $DownloadCache|Out-Null
function Get-VerifiedArchive($item){
    $file=Join-Path $DownloadCache $item.file
    if(-not (Test-Path -LiteralPath $file)){
        if($Offline){throw ('缺少离线构建组件：'+$item.file)}
        Write-Host ('下载并校验 '+$item.file)
        $temporary=$file+'.part'
        Invoke-WebRequest -Uri $item.url -OutFile $temporary -UseBasicParsing
        if((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ine $item.sha256){throw ('下载校验失败：'+$item.file)}
        Move-Item -LiteralPath $temporary -Destination $file
    }
    if((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine $item.sha256){throw ('组件校验失败：'+$item.file)}
    return $file
}
$nodeArchive=Get-VerifiedArchive $backendManifest.node
$pythonArchive=Get-VerifiedArchive $backendManifest.python
$wheels=@($backendManifest.wheels|ForEach-Object {Get-VerifiedArchive $_})
$electronArchive=Get-VerifiedArchive $desktopManifest.electron
$stage=Join-Path $appDirectory ('.test-tmp/desktop-build-'+[Guid]::NewGuid().ToString('N'))
$stage=[IO.Path]::GetFullPath($stage)
if(-not $stage.StartsWith([IO.Path]::GetFullPath((Join-Path $appDirectory '.test-tmp'))+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw '构建临时目录越界。'}
New-Item -ItemType Directory -Force -Path $stage|Out-Null
$backend=Join-Path $stage 'backend'
$runtime=Join-Path $backend 'runtime'
New-Item -ItemType Directory -Force -Path $runtime|Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Expand-VerifiedArchive([string]$archive,[string]$target){
    $target=[IO.Path]::GetFullPath($target)
    if(-not $target.StartsWith($stage+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw '解压目录越界。'}
    New-Item -ItemType Directory -Force -Path $target|Out-Null
    $zip=[IO.Compression.ZipFile]::OpenRead($archive)
    try {foreach($entry in $zip.Entries){$candidate=[IO.Path]::GetFullPath((Join-Path $target $entry.FullName));if(-not $candidate.StartsWith($target+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw '组件归档包含越界路径。'}}} finally {$zip.Dispose()}
    [IO.Compression.ZipFile]::ExtractToDirectory($archive,$target)
}
Expand-VerifiedArchive $nodeArchive (Join-Path $stage 'unpack-node')
$nodeSource=Join-Path $stage ('unpack-node/node-v'+$backendManifest.node.version+'-win-x64')
$nodeDestination=Join-Path $runtime 'node'
foreach($target in @($nodeSource,$nodeDestination)){if(-not ([IO.Path]::GetFullPath($target)).StartsWith($stage+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw '运行时移动路径越界。'}}
Move-Item -LiteralPath $nodeSource -Destination $nodeDestination
Expand-VerifiedArchive $pythonArchive (Join-Path $runtime 'python')
$sitePackages=Join-Path $runtime 'python/Lib/site-packages'
foreach($wheel in $wheels){Expand-VerifiedArchive $wheel $sitePackages}
[IO.File]::WriteAllText((Join-Path $runtime 'python/python313._pth'),"python313.zip`n.`nLib\site-packages`nimport site`n",[Text.Encoding]::ASCII)
$runtimeFiles=@(Get-ChildItem -LiteralPath $runtime -File -Recurse|Sort-Object FullName|ForEach-Object {[pscustomobject]@{path=$_.FullName.Substring($backend.Length+1).Replace('\','/');sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLower()}})
$bundle=[pscustomobject]@{version=$version;platform='windows-x64';provenance=@($backendManifest.node,$backendManifest.python)+@($backendManifest.wheels);files=$runtimeFiles}
[IO.File]::WriteAllText((Join-Path $backend 'bundled-runtime.json'),($bundle|ConvertTo-Json -Depth 8),[Text.UTF8Encoding]::new($false))
$coreFiles=@('package.json','server.js','启动图纸工作台.ps1','停止图纸工作台.ps1','README.md','第三方组件说明.md')
foreach($folder in @('src','public')){$coreFiles+=@(Get-ChildItem -LiteralPath (Join-Path $appDirectory $folder) -Recurse -File|ForEach-Object {$_.FullName.Substring($appDirectory.Length+1)})}
$coreFiles+=@('credential_vault.py','index_pdf.py','locate_file.py','preview_file.py','run-server.js','watch_directories.py','windows_ocr.ps1')|ForEach-Object {'tools/'+$_}
foreach($name in $coreFiles){
    if($name -match '(?i)\.(pdf|dwg|sqlite|dpapi\.json)$' -or $name -match '(^|[\\/])(data|logs|cache|backups|node_modules)([\\/]|$)'){throw '后端清单包含私人数据或构建缓存。'}
    $destination=Join-Path $backend $name
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination)|Out-Null
    Copy-Item -LiteralPath (Join-Path $appDirectory $name) -Destination $destination
}
$electron=Join-Path $stage 'electron'
Expand-VerifiedArchive $electronArchive $electron
$node=Join-Path $runtime 'node/node.exe'
$npm=Join-Path $runtime 'node/node_modules/npm/bin/npm-cli.js'
$desktop=Join-Path $appDirectory 'desktop'
$builder=Join-Path $desktop 'node_modules/electron-builder/cli.js'
$previousPath=$env:PATH
$previousBuilderCache=$env:ELECTRON_BUILDER_CACHE
$previousSigningDiscovery=$env:CSC_IDENTITY_AUTO_DISCOVERY
try {
    $env:PATH=(Split-Path -Parent $node)+';'+$env:PATH
    if(-not (Test-Path -LiteralPath $builder)){
        if($Offline){throw '缺少 electron-builder 构建依赖，请先执行锁定版本的 npm ci，或取消 Offline。'}
        Push-Location $desktop
        try {& $node $npm ci --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org --cache (Join-Path $DownloadCache 'npm');if($LASTEXITCODE -ne 0){throw '桌面构建工具安装失败。'}} finally {Pop-Location}
    }
    $builderVersion=(Get-Content -LiteralPath (Join-Path $desktop 'node_modules/electron-builder/package.json') -Raw|ConvertFrom-Json).version
    if($builderVersion -ne $desktopManifest.electronBuilder){throw 'electron-builder 版本不符。'}
    $config=Get-Content -LiteralPath (Join-Path $desktop 'electron-builder.json') -Raw -Encoding UTF8|ConvertFrom-Json
    $config|Add-Member -NotePropertyName electronDist -NotePropertyValue $electron -Force
    $config.extraResources[0].from=$backend
    $config.directories.output=Join-Path $appDirectory 'dist/desktop'
    $configPath=Join-Path $stage 'electron-builder.json'
    [IO.File]::WriteAllText($configPath,($config|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
    $env:ELECTRON_BUILDER_CACHE=Join-Path $DownloadCache 'electron-builder'
    $env:CSC_IDENTITY_AUTO_DISCOVERY='false'
    Push-Location $desktop
    try {& $node $builder --win nsis zip --x64 --config $configPath;if($LASTEXITCODE -ne 0){throw '桌面 EXE 构建失败。'}} finally {Pop-Location}
    Write-Host ('桌面发行包已生成：'+$config.directories.output)
    Write-Host '未提供签名证书时，构建不会声称带有发布者代码签名。私人数据未加入构建清单。'
} finally {
    $env:PATH=$previousPath
    $env:ELECTRON_BUILDER_CACHE=$previousBuilderCache
    $env:CSC_IDENTITY_AUTO_DISCOVERY=$previousSigningDiscovery
}
