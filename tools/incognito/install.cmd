@echo off
rem capynote "open in incognito": registers the capynote-incognito: protocol for the
rem current user (HKCU, no admin needed) and points it at open-incognito.ps1 next to
rem this file. Run once per PC; run uninstall.cmd to remove. ASCII only (cmd codepage).
setlocal
set "PS1=%~dp0open-incognito.ps1"
if not exist "%PS1%" (
  echo open-incognito.ps1 not found next to this script.
  exit /b 1
)
reg add "HKCU\Software\Classes\capynote-incognito" /ve /d "URL:capynote incognito" /f >nul
reg add "HKCU\Software\Classes\capynote-incognito" /v "URL Protocol" /d "" /f >nul
reg add "HKCU\Software\Classes\capynote-incognito\shell\open\command" /ve /d "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"%PS1%\" \"%%1\"" /f >nul
if errorlevel 1 (
  echo Failed to write the registry keys.
  exit /b 1
)
echo Registered capynote-incognito: -^> %PS1%
echo.
echo Next: in capynote's video page turn on the incognito toggle next to the sort box.
echo The first time you press "open link" Chrome asks once whether to open
echo capynote-incognito links; tick "always allow" and confirm.
