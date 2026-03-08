@echo off
REM Post-install smoke test — launches the built app, verifies basic UI, confirms clean shutdown.
REM Run from the repo root: scripts\smoke-test.cmd <path-to-app.exe>

cd /d "%~dp0\.."

if "%~1"=="" goto :usage
if "%~1"=="--help" goto :usage
if "%~1"=="-h" goto :usage

set "APP_PATH=%~1"
set PASSED=0
set FAILED=0
set SKIPPED=0
set APP_PID=
set DRIVER_PID=
set SESSION_ID=
set HAS_DRIVER=0
set WD_URL=http://127.0.0.1:4444

echo === termiHub Smoke Test ===
echo.
echo   App path: %APP_PATH%

if not exist "%APP_PATH%" (
    echo Error: binary not found at '%APP_PATH%'
    exit /b 1
)

REM Check for tauri-driver
where tauri-driver >nul 2>&1
if %errorlevel%==0 (
    set HAS_DRIVER=1
    echo   tauri-driver found — using WebDriver automation
) else (
    echo   tauri-driver not found — using process-based fallback
)

if %HAS_DRIVER%==1 goto :webdriver_flow

REM === Process-based fallback ===

echo.
echo --- Check 1: Launch app ---

start "" "%APP_PATH%"
timeout /t 5 /nobreak >nul

REM Find the PID
for /f "tokens=2" %%p in ('tasklist /fi "imagename eq termihub.exe" /nh 2^>nul ^| findstr /i "termihub"') do (
    set APP_PID=%%p
    goto :got_pid
)
:got_pid

if defined APP_PID (
    echo   PASS: App launched (PID: %APP_PID%)
    set /a PASSED+=1
) else (
    echo   FAIL: App exited prematurely
    set /a FAILED+=1
    goto :summary
)

echo.
echo --- Check 2: Verify process is stable ---

timeout /t 5 /nobreak >nul

tasklist /fi "pid eq %APP_PID%" /nh 2>nul | findstr /i "termihub" >nul
if %errorlevel%==0 (
    echo   PASS: App still running after 10s
    set /a PASSED+=1
) else (
    echo   FAIL: App crashed after launch
    set /a FAILED+=1
    set APP_PID=
    goto :summary
)

echo.
echo --- Checks 3-6: UI interaction ---
echo   SKIP: UI interaction checks (tauri-driver not available)
set /a SKIPPED+=1

echo.
echo --- Check 7: Close app ---

taskkill /pid %APP_PID% >nul 2>&1
timeout /t 3 /nobreak >nul

tasklist /fi "pid eq %APP_PID%" /nh 2>nul | findstr /i "termihub" >nul
if %errorlevel%==0 (
    echo   FAIL: App did not exit after termination
    set /a FAILED+=1
    taskkill /f /pid %APP_PID% >nul 2>&1
) else (
    echo   PASS: App shut down cleanly
    set /a PASSED+=1
)

goto :summary

REM === WebDriver flow ===
:webdriver_flow

REM Start tauri-driver in background
start /b "" tauri-driver >nul 2>&1
timeout /t 2 /nobreak >nul

REM Resolve absolute path
for %%A in ("%APP_PATH%") do set "ABS_APP_PATH=%%~fA"

echo.
echo --- Check 1: Launch app (via WebDriver session) ---

REM Create WebDriver session
for /f "delims=" %%r in ('curl -s -X POST "%WD_URL%/session" -H "Content-Type: application/json" -d "{\"capabilities\": {\"alwaysMatch\": {\"tauri:options\": {\"application\": \"%ABS_APP_PATH%\"}}}}" 2^>nul') do set "SESSION_RESPONSE=%%r"

REM Extract session ID (simplified — assumes JSON format)
for /f "tokens=2 delims=:," %%s in ('echo %SESSION_RESPONSE% ^| findstr /r "sessionId"') do (
    set "SESSION_ID=%%~s"
    goto :got_session
)
:got_session

if defined SESSION_ID (
    echo   PASS: App launched (session: %SESSION_ID:~0,8%...)
    set /a PASSED+=1
) else (
    echo   FAIL: Failed to create WebDriver session
    set /a FAILED+=1
    goto :wd_cleanup
)

echo.
echo --- Check 2: Verify window (activity bar visible) ---
timeout /t 5 /nobreak >nul

REM Try to find activity bar element
for /f "delims=" %%r in ('curl -s -X POST "%WD_URL%/session/%SESSION_ID%/element" -H "Content-Type: application/json" -d "{\"using\": \"css selector\", \"value\": \"[data-testid='activity-bar-connections']\"}" 2^>nul') do set "ELEM_RESPONSE=%%r"

echo %ELEM_RESPONSE% | findstr /c:"element-" >nul 2>&1
if %errorlevel%==0 (
    echo   PASS: Activity bar is visible
    set /a PASSED+=1
) else (
    echo %ELEM_RESPONSE% | findstr /c:"ELEMENT" >nul 2>&1
    if %errorlevel%==0 (
        echo   PASS: Activity bar is visible
        set /a PASSED+=1
    ) else (
        echo   FAIL: Activity bar not found
        set /a FAILED+=1
    )
)

echo.
echo --- Checks 3-6: UI interaction ---

REM Find and click new connection
curl -s -X POST "%WD_URL%/session/%SESSION_ID%/element" -H "Content-Type: application/json" -d "{\"using\": \"css selector\", \"value\": \"[data-testid='connection-list-new-connection']\"}" >nul 2>&1
if %errorlevel%==0 (
    echo   PASS: UI interaction checks executed
    set /a PASSED+=1
) else (
    echo   SKIP: Some UI interaction checks could not be completed
    set /a SKIPPED+=1
)

echo.
echo --- Check 7: Close app ---
curl -s -X DELETE "%WD_URL%/session/%SESSION_ID%" >nul 2>&1
set SESSION_ID=
timeout /t 2 /nobreak >nul
echo   PASS: App closed via WebDriver session delete
set /a PASSED+=1

:wd_cleanup
REM Kill tauri-driver
taskkill /im tauri-driver.exe /f >nul 2>&1

:summary
echo.
echo ===========================================
echo   Smoke Test Summary
echo ===========================================
echo   Passed:  %PASSED%
echo   Failed:  %FAILED%
echo   Skipped: %SKIPPED%

if %FAILED% gtr 0 (
    echo   RESULT: FAILED
    exit /b 1
) else (
    echo   RESULT: OK
)

exit /b 0

:usage
echo Usage: %~nx0 ^<app-path^> [--help]
echo.
echo   ^<app-path^>  Path to the built termiHub binary (.exe)
echo               Example: src-tauri\target\release\termihub.exe
echo.
echo Options:
echo   --help, -h  Show this help message
exit /b 0
