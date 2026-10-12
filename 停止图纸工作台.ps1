$ErrorActionPreference = 'Stop'
$dataDirectory = if ($env:DRAWING_WORKBENCH_DATA) { $env:DRAWING_WORKBENCH_DATA } else { Join-Path $env:LOCALAPPDATA 'DrawingWorkbench\data' }
$port = if ($env:DRAWING_WORKBENCH_PORT) { [int]$env:DRAWING_WORKBENCH_PORT } else { 17863 }
$appUrl = 'http://127.0.0.1:' + $port
try { $health = Invoke-RestMethod "$appUrl/api/health" -TimeoutSec 2 } catch { Write-Host '对应服务未运行。'; return }
if ($health.application -ne 'DrawingWorkbench' -or $health.appDirectory -ne $PSScriptRoot) { throw '端口由其他程序或其他版本占用，未停止它。' }
# 使用同源校验接口正常关闭数据库和目录监听，不按端口强杀其他进程。
Invoke-RestMethod "$appUrl/api/system/shutdown" -Method POST -Headers @{'Origin'=$appUrl;'X-Requested-With'='DrawingWorkbench'} -ContentType 'application/json' -Body '{}' | Out-Null
for ($attempt=0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    try { $null = Invoke-RestMethod "$appUrl/api/health" -TimeoutSec 1 } catch { Write-Host '已停止。图纸和个人索引已保留。'; return }
}
throw '服务尚未退出，请检查日志。未强杀其他程序。'
