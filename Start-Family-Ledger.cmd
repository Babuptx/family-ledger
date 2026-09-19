@echo off
setlocal

rem Double-click this file to start the local Family Ledger server.
rem The PowerShell script keeps the server running until its window is closed.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Family-Ledger.ps1"

if errorlevel 1 (
  echo.
  echo Family Ledger did not start. Read the message above, then press any key to close.
  pause >nul
)
