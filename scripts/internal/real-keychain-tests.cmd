@echo off
REM Run the opt-in real-keychain tests of the deferred backup-restore
REM credential import (#4659, src-tauri\src\backup\tests_real_keychain.rs)
REM against the Windows Credential Manager, and fail unless every one of them
REM ran. Windows twin of scripts/internal/real-keychain-tests.sh (whose
REM macOS and Linux branches use a throwaway keychain / Secret Service).
REM
REM Windows has no throwaway credential store: the tests only use run-unique
REM service names (never the real termiHub / termiHub-backup-restore entries)
REM and a drop guard deletes every entry they write, even on failure. They
REM touch the store only with TERMIHUB_REAL_KEYCHAIN_TESTS=1, set here.
REM
REM Usage: scripts\internal\real-keychain-tests.cmd [--help]
setlocal

if "%~1"=="--help" goto help
if "%~1"=="-h" goto help
if not "%~1"=="" (
    echo Unknown argument: %~1 ^(see --help^) 1>&2
    exit /b 1
)

set "FILTER=backup::tests_real_keychain::"
set "EXPECTED=2"
REM Same package selection and features as the CI "Run Rust tests" step, so
REM the already-built lib test binaries are reused.
set "CARGO_ARGS=--workspace --all-features --lib"

pushd "%~dp0..\.." || exit /b 1

echo Building the test binary...
cargo test %CARGO_ARGS% --no-run
if errorlevel 1 goto fail

set "LOG=%TEMP%\termihub-real-keychain-tests-%RANDOM%%RANDOM%.log"
set "TERMIHUB_REAL_KEYCHAIN_TESTS=1"
cargo test %CARGO_ARGS% -- %FILTER% --test-threads=1 > "%LOG%" 2>&1
set "RC=%ERRORLEVEL%"
type "%LOG%"
if not "%RC%"=="0" (
    del "%LOG%" 2>nul
    goto fail
)

REM A filter that matches nothing passes silently; require every test to
REM have run and passed.
set "RAN=0"
for /f %%n in ('findstr /R /C:"^test %FILTER%[a-z_]* \.\.\. ok" "%LOG%" ^| find /c /v ""') do set "RAN=%%n"
del "%LOG%" 2>nul
if not "%RAN%"=="%EXPECTED%" (
    echo error: expected %EXPECTED% real-keychain tests to pass, %RAN% did 1>&2
    goto fail
)
echo All %EXPECTED% real-keychain tests passed against the real OS credential store.
popd
exit /b 0

:fail
popd
exit /b 1

:help
echo Run the opt-in real-keychain tests of the deferred backup-restore
echo credential import (#4659) against the Windows Credential Manager, and
echo fail unless every one of them ran. Entries use run-unique service names
echo and are deleted by the tests, even on failure.
echo.
echo Usage: scripts\internal\real-keychain-tests.cmd [--help]
exit /b 0
