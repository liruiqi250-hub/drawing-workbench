$ErrorActionPreference='Stop'
$appDirectory=Split-Path -Parent $PSScriptRoot
$manifestPath=Join-Path $appDirectory 'bundled-runtime.json'
if(-not (Test-Path -LiteralPath $manifestPath)){throw '当前目录没有离线运行时校验清单。'}
$bundle=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$runtimeRoot=[IO.Path]::GetFullPath((Join-Path $appDirectory 'runtime'))
if($bundle.version -ne '0.6.0' -or -not $bundle.files.Count){throw '离线运行时清单版本不符或为空。'}
$expected=New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
foreach($item in $bundle.files){
    $target=[IO.Path]::GetFullPath((Join-Path $appDirectory $item.path))
    if(-not $target.StartsWith($runtimeRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw '运行时清单包含越界路径。'}
    if($item.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $expected.ContainsKey($target)){throw '运行时清单包含无效校验值或重复路径。'}
    $expected.Add($target,[string]$item.sha256)
}
# Enumerate one directory at a time: reject junctions before following them.
$directories=New-Object 'System.Collections.Generic.Stack[string]'
$directories.Push($runtimeRoot)
$actual=New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
while($directories.Count){
    $directory=$directories.Pop()
    $entry=Get-Item -LiteralPath $directory -Force
    if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){throw '离线运行时包含重解析目录，未运行任何组件。'}
    foreach($entry in Get-ChildItem -LiteralPath $directory -Force){
        if($entry.Attributes -band [IO.FileAttributes]::ReparsePoint){throw '离线运行时包含重解析点，未运行任何组件。'}
        if($entry.PSIsContainer){$directories.Push($entry.FullName);continue}
        if(-not $expected.ContainsKey($entry.FullName)){throw ('离线运行时包含清单外文件：'+$entry.Name+'；未运行任何组件。')}
        $null=$actual.Add($entry.FullName)
    }
}
if($actual.Count -ne $expected.Count){throw '离线运行时缺少清单中的文件，未运行任何组件。'}
foreach($target in $actual){
    if((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ine $expected[$target]){throw ('离线组件校验失败：'+[IO.Path]::GetFileName($target)+'；未运行该组件，请重新下载离线包。')}
}
Write-Host ('离线组件 SHA256 与完整文件清单校验通过：'+$expected.Count+' 个文件。')
