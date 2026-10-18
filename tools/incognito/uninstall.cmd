@echo off
rem Removes the capynote-incognito: protocol registered by install.cmd (HKCU only).
reg delete "HKCU\Software\Classes\capynote-incognito" /f >nul 2>&1
echo Removed capynote-incognito: protocol for the current user.
