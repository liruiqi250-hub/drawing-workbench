param([switch]$BackgroundOnly)
$ErrorActionPreference = 'Stop'
try {
    $appDirectory = $PSScriptRoot
    $version = (Get-Content -LiteralPath (Join-Path $appDirectory 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
    $dataDirectory = if ($env:DRAWING_WORKBENCH_DATA) { $env:DRAWING_WORKBENCH_DATA } else { Join-Path $env:LOCALAPPDATA 'DrawingWorkbench\data' }
    $logDirectory = Join-Path $dataDirectory 'logs'
    New-Item -ItemType Directory -Force -Path $dataDirectory,$logDirectory | Out-Null
    $port = if ($env:DRAWING_WORKBENCH_PORT) { [int]$env:DRAWING_WORKBENCH_PORT } else { 17863 }
    $appUrl = 'http://127.0.0.1:' + $port
    $health = $null
    try { $health = Invoke-RestMethod "$appUrl/api/health" -TimeoutSec 2 } catch {}
    if ($health -and ($health.application -ne 'DrawingWorkbench' -or $health.version -ne $version -or $health.appDirectory -ne $appDirectory)) {
        throw '本机端口正在运行另一个版本或程序。请先停止旧版，再启动此版本；原数据不会被自动覆盖或导入。'
    }
    $healthy = $health -and $health.application -eq 'DrawingWorkbench' -and $health.appDirectory -eq $appDirectory
    if (-not $healthy) {
        $nodePath = Join-Path $appDirectory 'runtime\node\node.exe'
        if (-not (Test-Path -LiteralPath $nodePath)) { throw '请先让 AI 执行 scripts\install-windows.ps1 配置环境。' }
        $serverPath = Join-Path $appDirectory 'tools\run-server.js'
        $launchInfo = New-Object System.Diagnostics.ProcessStartInfo
        $launchInfo.FileName = $nodePath
        $launchInfo.Arguments = '"' + $serverPath + '"'
        $launchInfo.WorkingDirectory = $appDirectory
        $launchInfo.UseShellExecute = $true
        $launchInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
        $taskProcess = [System.Diagnostics.Process]::Start($launchInfo)
        for ($attempt=0; $attempt -lt 60; $attempt++) {
            Start-Sleep -Milliseconds 250
            try {
                $health = Invoke-RestMethod "$appUrl/api/health" -TimeoutSec 2
                if ($health.application -eq 'DrawingWorkbench' -and $health.version -eq $version -and $health.appDirectory -eq $appDirectory) { $healthy=$true; break }
            } catch {}
            if ($taskProcess.HasExited) { break }
        }
    }
    if (-not $healthy) { throw ('启动未完成，请检查 ' + (Join-Path $logDirectory 'server.error.log')) }
    if (-not $BackgroundOnly) { Start-Process $appUrl }
} catch {
    if (-not $BackgroundOnly -and -not $env:DRAWING_WORKBENCH_HEADLESS) {
        Add-Type -AssemblyName System.Windows.Forms
        [Windows.Forms.MessageBox]::Show($_.Exception.Message,'图纸工作台启动提示') | Out-Null
    }
    Write-Error $_
    exit 1
}
