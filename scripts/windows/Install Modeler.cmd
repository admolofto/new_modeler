@echo off
rem Installs Modeler on this PC: double-click this file. It downloads the app, adds a "Modeler"
rem shortcut to the desktop and opens it. The shortcut fetches the latest version every time.
title Installing Modeler
set "ROOT=%LOCALAPPDATA%\Modeler"
if not exist "%ROOT%" mkdir "%ROOT%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = 'Tls12'; $ProgressPreference = 'SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/admolofto/new_modeler/main/scripts/windows/modeler.ps1' -OutFile '%ROOT%\modeler.ps1'"
if errorlevel 1 (
  echo.
  echo Couldn't download Modeler. Check the internet connection and try again.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\modeler.ps1" -Install
if errorlevel 1 pause
