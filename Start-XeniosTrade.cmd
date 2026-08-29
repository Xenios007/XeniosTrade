@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-XeniosTrade.ps1" %*
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
  echo XeniosTrade launcher failed. Check launcher logs in c:\Web\trade\launcher-logs.
  pause
)

exit /b %EXITCODE%
