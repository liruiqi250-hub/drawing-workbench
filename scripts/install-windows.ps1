param(
    [switch]$NoLaunch,
    [switch]$NoShortcut,
    [switch]$Offline,
    [string]$DownloadCache
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$appDirectory = Split-Path -Parent $PSScriptRoot
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
    throw '此版本仅支持 Windows 10/11 x64。'
}
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $DownloadCache) { $DownloadCache = Join-Path $appDirectory '.downloads' }
New-Item -ItemType Directory -Force -Path $DownloadCache | Out-Null
$DownloadCache = (Resolve-Path -LiteralPath $DownloadCache).Path

function Get-VerifiedPackage($item) {
    $destination = Join-Path $DownloadCache $item.file
    if ((Test-Path -LiteralPath $destination) -and ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ine $item.sha256)) {
        throw ('缓存文件校验不一致，请移走该文件后重试：' + $destination)
    }
    if (-not (Test-Path -LiteralPath $destination)) {
        if ($Offline) { throw ('离线包缺少运行组件：' + $item.file + '。请重新下载完整离线包，或联网运行源码安装。') }
        Write-Host ('下载 ' + $item.file)
        $temporary = $destination + '.part'
        Invoke-WebRequest -Uri $item.url -OutFile $temporary -UseBasicParsing
        if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ine $item.sha256) { throw ('下载校验失败：' + $item.file) }
        Move-Item -LiteralPath $temporary -Destination $destination -Force
    }
    return $destination
}

$runtime = Join-Path $appDirectory 'runtime'
$node = Join-Path $runtime 'node\node.exe'
$python = Join-Path $runtime 'python\python.exe'
$ready = $false
if (Test-Path -LiteralPath (Join-Path $appDirectory 'bundled-runtime.json')) {
    & (Join-Path $PSScriptRoot 'verify-bundled-runtime.ps1')
}
if ((Test-Path -LiteralPath $node) -and (Test-Path -LiteralPath $python)) {
    try {
        $nodeVersion = & $node --version
        $pythonVersion = & $python -B -c "import sys, PIL, pypdfium2; print('.'.join(map(str,sys.version_info[:3])))"
        $ready = $LASTEXITCODE -eq 0 -and $nodeVersion -eq ('v' + $manifest.node.version) -and $pythonVersion -eq $manifest.python.version
    } catch { $ready = $false }
}
if (-not $ready) {
    # 下载完整并校验后再安装；不修改系统 PATH，不替换已有的系统 Node/Python。
    $nodeArchive = Get-VerifiedPackage $manifest.node
    $pythonArchive = Get-VerifiedPackage $manifest.python
    $wheelArchives = @($manifest.wheels | ForEach-Object { Get-VerifiedPackage $_ })
    $staging = Join-Path $appDirectory ('.runtime-staging-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    Expand-Archive -LiteralPath $nodeArchive -DestinationPath (Join-Path $staging 'unpack-node')
    Move-Item -LiteralPath (Join-Path $staging ('unpack-node\node-v' + $manifest.node.version + '-win-x64')) -Destination (Join-Path $staging 'node')
    Expand-Archive -LiteralPath $pythonArchive -DestinationPath (Join-Path $staging 'python')
    $sitePackages = Join-Path $staging 'python\Lib\site-packages'
    New-Item -ItemType Directory -Force -Path $sitePackages | Out-Null
    foreach ($wheel in $wheelArchives) {
        $wheelZip = Join-Path $staging ((Split-Path -Leaf $wheel) + '.zip')
        Copy-Item -LiteralPath $wheel -Destination $wheelZip
        Expand-Archive -LiteralPath $wheelZip -DestinationPath $sitePackages -Force
    }
    Set-Content -LiteralPath (Join-Path $staging 'python\python313._pth') -Value "python313.zip`n.`nLib\site-packages`nimport site" -Encoding ASCII
    & (Join-Path $staging 'python\python.exe') -B -c "import PIL, pypdfium2; print('PDF runtime OK')"
    if ($LASTEXITCODE -ne 0) { throw 'Python 预览环境检查失败，原安装未替换。' }
    if (Test-Path -LiteralPath $runtime) {
        & (Join-Path $appDirectory '停止图纸工作台.ps1')
        # 故障环境保留，以便排错；不递归删除用户目录。
        Move-Item -LiteralPath $runtime -Destination ($runtime + '.previous-' + [Guid]::NewGuid().ToString('N'))
    }
    New-Item -ItemType Directory -Path $runtime | Out-Null
    Move-Item -LiteralPath (Join-Path $staging 'node') -Destination $runtime
    Move-Item -LiteralPath (Join-Path $staging 'python') -Destination $runtime
}
& $node (Join-Path $PSScriptRoot 'sync-startup.js')
if ($LASTEXITCODE -ne 0) { throw '无法同步自动启动入口，请查看上方错误。原配置和索引保留。' }
if (-not $NoShortcut) {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $shortcutPath = Join-Path $desktop '图纸工作台.lnk'
    $shell = New-Object -ComObject WScript.Shell
    if (Test-Path -LiteralPath $shortcutPath) {
        $existing = $shell.CreateShortcut($shortcutPath)
        if ($existing.Arguments -notlike ('*' + $appDirectory + '*')) {
            $shortcutPath = Join-Path $desktop '图纸工作台 V0.6.0.lnk'
        }
    }
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = Join-Path $PSHOME 'powershell.exe'
    $shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $appDirectory '启动图纸工作台.ps1') + '"'
    $shortcut.WorkingDirectory = $appDirectory
    $shortcut.WindowStyle = 7
    $shortcut.Description = '图纸工作台 V0.6.0'
    $shortcut.Save()
    Write-Host ('已创建桌面快捷方式：' + $shortcutPath)
}
Write-Host 'V0.6.0 环境配置完成。个人索引保存在 %LOCALAPPDATA%\DrawingWorkbench\data。'
& (Join-Path $appDirectory 'tools\windows_ocr.ps1') -Probe
if (-not $NoLaunch) { & (Join-Path $appDirectory '启动图纸工作台.ps1') }
