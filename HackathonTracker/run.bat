@echo off
rem Double-click to run the tracker. Pass extra options straight through, e.g.
rem   run.bat --days 60 --scope national
setlocal
cd /d "%~dp0"

set PY=python
if exist "%~dp0.venv\Scripts\python.exe" set PY="%~dp0.venv\Scripts\python.exe"

set PYTHONIOENCODING=utf-8
%PY% "%~dp0hackathon_tracker.py" %*
set CODE=%ERRORLEVEL%

if "%1"=="" pause
exit /b %CODE%
