@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "bundled-runtime.json" (
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File ".\scripts\install-windows.ps1" -Offline
) else (
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File ".\scripts\install-windows.ps1"
)
if errorlevel 1 pause
