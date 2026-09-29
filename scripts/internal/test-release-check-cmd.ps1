#Requires -Version 7.0
<#
.SYNOPSIS
    Windows CI harness for the release gates in scripts\release-check.cmd (#3753).

.DESCRIPTION
    The integration-lane gate, the TODO/FIXME/HACK scan and the bundle build +
    smoke test in release-check.cmd (#3750) are batch-specific code paths
    (`for /f` over `gh auth token` / `git branch -r --contains`, the installer
    glob, the smoke-test call). The .sh half is exercised on macOS/Linux; this
    harness executes the .cmd half on a real Windows host, one section at a time
    via `release-check.cmd --only <section>`, and asserts that every scenario
    ends with the expected exit code and a clear PASS/FAIL line:

      markers      clean tree -> PASS; an injected `// TODO` in src\ -> FAIL
                   naming the file.
      integration  gh missing from PATH, gh logged out, HEAD on no remote
                   branch, and no green runs for HEAD (a real API call) -> each
                   a FAIL with its own message (the last with the dispatch
                   command).
      bundle       build.cmd / smoke-test.cmd replaced by stubs: installer glob
                   hit, no installer, failed build, failed smoke test, and the
                   exact smoke-test.cmd argument.
      bundle-real  (-RealBundle) the real build.cmd + smoke-test.cmd; slow, run
                   by the workflow only on workflow_dispatch.

    It writes into the checkout (a scratch file under src\, stubbed scripts,
    fake artifacts under target\release\, an empty commit it resets away), so
    it runs only on a CI runner unless -Force is given. Everything it changes
    is restored in `finally` blocks.

    Run from the repo root:
        pwsh scripts/internal/test-release-check-cmd.ps1 [-RealBundle] [-Force]

    GH_TOKEN must be set for the "no green runs" scenario (the workflow passes
    github.token); without it that scenario is skipped with a warning.
#>
param(
    [switch]$RealBundle,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

if (-not $IsWindows) {
    throw 'test-release-check-cmd.ps1 drives release-check.cmd and needs Windows.'
}
if (-not $Force -and $env:GITHUB_ACTIONS -ne 'true') {
    throw 'This harness modifies the checkout; run it on CI or pass -Force.'
}

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $RepoRoot

$script:Failures = 0

# Run release-check.cmd, streaming each line as it arrives (so a hung or
# timed-out build still leaves its log) and collecting it for the assertions.
function Invoke-Raw([string]$Arguments) {
    Write-Host ""
    Write-Host ">>>>> release-check.cmd $Arguments"
    $lines = & cmd.exe /d /c "scripts\release-check.cmd $Arguments" 2>&1 |
        ForEach-Object { $line = "$_"; Write-Host $line; $line }
    return [pscustomobject]@{ Code = $LASTEXITCODE; Text = ($lines -join "`n") }
}

function Invoke-ReleaseCheck {
    param([string]$Section, [hashtable]$Env = @{}, [string[]]$Unset = @())
    $saved = @{}
    foreach ($name in @($Env.Keys) + $Unset) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name)
    }
    try {
        foreach ($name in $Unset) { [Environment]::SetEnvironmentVariable($name, $null) }
        foreach ($name in $Env.Keys) { [Environment]::SetEnvironmentVariable($name, $Env[$name]) }
        return Invoke-Raw "--only $Section"
    } finally {
        foreach ($name in $saved.Keys) { [Environment]::SetEnvironmentVariable($name, $saved[$name]) }
    }
}

function Assert-Result {
    param(
        [string]$Name,
        $Result,
        [int]$ExpectCode,
        [string[]]$Expect = @(),
        [string[]]$Reject = @()
    )
    Write-Host "----- $Name (exit $($Result.Code)) -----"
    $problems = @()
    if ($Result.Code -ne $ExpectCode) {
        $problems += "exit code $($Result.Code), expected $ExpectCode"
    }
    foreach ($needle in $Expect) {
        if (-not $Result.Text.Contains($needle)) { $problems += "missing: '$needle'" }
    }
    foreach ($needle in $Reject) {
        if ($Result.Text.Contains($needle)) { $problems += "unexpected: '$needle'" }
    }
    if ($problems.Count -eq 0) {
        Write-Host "HARNESS PASS: $Name"
    } else {
        foreach ($p in $problems) { Write-Host "::error title=release-check.cmd: $Name::$p" }
        Write-Host "HARNESS FAIL: $Name"
        $script:Failures++
    }
}

function Write-Stub {
    param([string]$Path, [string[]]$Lines)
    # Batch files must be CRLF; Set-Content on Windows writes CRLF.
    Set-Content -LiteralPath $Path -Value $Lines -Encoding ascii
}

$HeadSha = (git rev-parse HEAD).Trim()

if ($RealBundle) {
    # ---------------------------------------------------------------- bundle-real
    $r = Invoke-ReleaseCheck 'bundle'
    Assert-Result 'bundle-real: build.cmd + smoke-test.cmd' $r 0 `
        -Expect @('PASS: Bundle build produced target\release\bundle\', 'PASS: Smoke test passed against target\release\termihub.exe', 'RESULT: READY') `
        -Reject @('FAIL:')
} else {
    # -------------------------------------------------------------------- usage
    Assert-Result 'usage: unknown --only section' (Invoke-Raw '--only bogus') 2 `
        -Expect @('error: --only needs one of: integration, markers, bundle')

    # ----------------------------------------------------------------- versions
    # Not one of the #3750 gates, but every mode parses the argument block and
    # this is the mode the release workflow runs; with and without the flag.
    # '  tauri (' is the drift checker's per-crate line ("ok" or, without
    # node_modules, "skip"): proof it ran rather than exiting 0 silently.
    $version = (Get-Content -Raw package.json | ConvertFrom-Json).version
    Assert-Result 'versions-only' (Invoke-Raw '--versions-only') 0 `
        -Expect @("PASS: All 5 files agree on version $version", '  tauri (', 'RESULT: version checks passed') `
        -Reject @('FAIL:')
    Assert-Result 'versions-only --expect-version v<ver>' (Invoke-Raw "--versions-only --expect-version v$version") 0 `
        -Expect @("matches the expected version $version", 'RESULT: version checks passed') -Reject @('FAIL:')
    Assert-Result 'versions-only --expect-version mismatch' (Invoke-Raw '--versions-only --expect-version 0.0.0-harness') 1 `
        -Expect @("does not match the expected version '0.0.0-harness'", 'RESULT: version checks FAILED')

    # ------------------------------------------------------------------ markers
    $r = Invoke-ReleaseCheck 'markers'
    Assert-Result 'markers: clean tree' $r 0 `
        -Expect @('PASS: No un-allowlisted TODO/FIXME/HACK markers', 'RESULT: READY') -Reject @('FAIL:')

    $injected = Join-Path $RepoRoot 'src\releaseCheckHarnessInjected.ts'
    try {
        Set-Content -LiteralPath $injected -Value @('// TODO: injected by test-release-check-cmd.ps1', 'export {};')
        $r = Invoke-ReleaseCheck 'markers'
        Assert-Result 'markers: injected TODO' $r 1 `
            -Expect @('releaseCheckHarnessInjected.ts', 'FAIL: TODO/FIXME/HACK markers block the release', 'RESULT: NOT READY') `
            -Reject @('PASS: No un-allowlisted')
    } finally {
        Remove-Item -LiteralPath $injected -Force -ErrorAction SilentlyContinue
    }

    # -------------------------------------------------------------- integration
    $noGhPath = ($env:PATH -split ';' | Where-Object { $_ -and -not (Test-Path (Join-Path $_ 'gh.exe')) }) -join ';'
    $r = Invoke-ReleaseCheck 'integration' -Env @{ PATH = $noGhPath }
    Assert-Result 'integration: gh not installed' $r 1 `
        -Expect @('FAIL: gh CLI not installed', 'RESULT: NOT READY')

    $emptyGhConfig = Join-Path ([IO.Path]::GetTempPath()) "release-check-gh-$PID"
    New-Item -ItemType Directory -Force -Path $emptyGhConfig | Out-Null
    $r = Invoke-ReleaseCheck 'integration' -Env @{ GH_CONFIG_DIR = $emptyGhConfig } `
        -Unset @('GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN')
    Assert-Result 'integration: gh logged out' $r 1 `
        -Expect @('FAIL: gh CLI not logged in', 'gh auth login', 'RESULT: NOT READY') `
        -Reject @('PASS: Integration lanes green')

    if (-not $env:GH_TOKEN) {
        Write-Host '::warning::GH_TOKEN not set: skipping the authenticated integration scenarios'
    } else {
        # A local-only commit: no remote branch contains it, so no CI run can exist.
        git -c user.name=harness -c user.email=harness@example.invalid `
            commit --allow-empty --no-verify -q -m 'chore: release-check harness local-only commit'
        try {
            $localSha = (git rev-parse HEAD).Trim()
            $r = Invoke-ReleaseCheck 'integration'
            Assert-Result 'integration: HEAD on no remote branch' $r 1 `
                -Expect @("FAIL: HEAD $localSha is on no remote branch", 'gh workflow run release-candidate.yml --repo ', 'RESULT: NOT READY') `
                -Reject @('PASS: Integration lanes green')
        } finally {
            git reset --soft -q $HeadSha
        }

        # The pushed CI commit has no Release Candidate run: the gate itself must
        # reach the API, report the missing lane and FAIL with the dispatch command.
        $r = Invoke-ReleaseCheck 'integration'
        Assert-Result 'integration: no green runs for HEAD' $r 1 `
            -Expect @(
                "Release integration gate for ",
                'release-candidate.yml): no workflow_dispatch run on this commit',
                "FAIL: Integration lanes not green on $HeadSha - run: gh workflow run release-candidate.yml --repo ",
                'RESULT: NOT READY'
            ) `
            -Reject @('PASS: Integration lanes green', 'GitHub API error')
    }

    # ------------------------------------------------------------------- bundle
    # build.cmd / smoke-test.cmd are swapped for stubs so the section's own logic
    # (errorlevel handling, installer glob, SMOKE_APP path, smoke-test call) runs
    # in seconds; the real build runs under -RealBundle on workflow_dispatch.
    $buildCmd = Join-Path $RepoRoot 'scripts\build.cmd'
    $smokeCmd = Join-Path $RepoRoot 'scripts\smoke-test.cmd'
    $bundleDir = Join-Path $RepoRoot 'target\release\bundle'
    $appExe = Join-Path $RepoRoot 'target\release\termihub.exe'
    $smokeArgs = Join-Path $RepoRoot 'target\release-check-smoke-args.txt'
    $buildBackup = Get-Content -LiteralPath $buildCmd -Raw
    $smokeBackup = Get-Content -LiteralPath $smokeCmd -Raw
    if ((Test-Path $bundleDir) -or (Test-Path $appExe)) {
        throw 'target\release already holds a build; refusing to overwrite it with stub artifacts.'
    }

    function Set-BuildStub([int]$Exit, [string[]]$Installers) {
        $lines = @('@echo off', 'echo [stub build.cmd]', 'cd /d "%~dp0\.."')
        $lines += 'if not exist target\release mkdir target\release'
        $lines += 'echo stub> target\release\termihub.exe'
        foreach ($i in $Installers) {
            $dir = Split-Path $i -Parent
            $lines += "if not exist `"$dir`" mkdir `"$dir`""
            $lines += "echo stub> `"$i`""
        }
        $lines += "exit /b $Exit"
        Write-Stub $buildCmd $lines
    }
    function Set-SmokeStub([int]$Exit) {
        Write-Stub $smokeCmd @(
            '@echo off',
            'echo [stub smoke-test.cmd] %*',
            "echo %~1> `"$smokeArgs`"",
            "exit /b $Exit"
        )
    }
    function Reset-Artifacts {
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $bundleDir, $appExe, $smokeArgs
    }

    try {
        Reset-Artifacts
        Set-BuildStub 0 @('target\release\bundle\msi\termiHub_0.0.0_x64_en-US.msi', 'target\release\bundle\nsis\termiHub_0.0.0_x64-setup.exe')
        Set-SmokeStub 0
        $r = Invoke-ReleaseCheck 'bundle'
        Assert-Result 'bundle (stub): msi + nsis produced, smoke passes' $r 0 `
            -Expect @('[stub build.cmd]', 'PASS: Bundle build produced target\release\bundle\', '[stub smoke-test.cmd] "target\release\termihub.exe"', 'PASS: Smoke test passed against target\release\termihub.exe', 'RESULT: READY') `
            -Reject @('FAIL:')
        $passed = if (Test-Path $smokeArgs) { (Get-Content -LiteralPath $smokeArgs -Raw).Trim() } else { '<not called>' }
        if ($passed -ne 'target\release\termihub.exe') {
            Write-Host "::error title=release-check.cmd: bundle (stub)::smoke-test.cmd got '$passed'"
            $script:Failures++
        }

        Reset-Artifacts
        Set-BuildStub 0 @('target\release\bundle\msi\termiHub_0.0.0_x64_en-US.msi')
        $r = Invoke-ReleaseCheck 'bundle'
        Assert-Result 'bundle (stub): msi only' $r 0 `
            -Expect @('PASS: Bundle build produced target\release\bundle\msi\termiHub_0.0.0_x64_en-US.msi') -Reject @('FAIL:')

        Reset-Artifacts
        Set-BuildStub 0 @('target\release\bundle\nsis\termiHub_0.0.0_x64-setup.exe')
        $r = Invoke-ReleaseCheck 'bundle'
        Assert-Result 'bundle (stub): nsis only' $r 0 `
            -Expect @('PASS: Bundle build produced target\release\bundle\nsis\termiHub_0.0.0_x64-setup.exe') -Reject @('FAIL:')

        Reset-Artifacts
        Set-BuildStub 0 @()
        $r = Invoke-ReleaseCheck 'bundle'
        Assert-Result 'bundle (stub): no installer' $r 1 `
            -Expect @('FAIL: Bundle build produced no installer', 'RESULT: NOT READY') -Reject @('PASS: Bundle build produced')

        Reset-Artifacts
        Set-BuildStub 1 @()
        $r = Invoke-ReleaseCheck 'bundle'
        Assert-Result 'bundle (stub): build fails' $r 1 `
            -Expect @('FAIL: Release bundle build failed', 'RESULT: NOT READY') -Reject @('[stub smoke-test.cmd]', 'PASS:')

        Reset-Artifacts
        Set-BuildStub 0 @('target\release\bundle\msi\termiHub_0.0.0_x64_en-US.msi')
        Set-SmokeStub 1
        $r = Invoke-ReleaseCheck 'bundle'
        Assert-Result 'bundle (stub): smoke test fails' $r 1 `
            -Expect @('FAIL: Smoke test failed against target\release\termihub.exe', 'RESULT: NOT READY') -Reject @('PASS: Smoke test passed')
    } finally {
        Set-Content -LiteralPath $buildCmd -Value $buildBackup -NoNewline
        Set-Content -LiteralPath $smokeCmd -Value $smokeBackup -NoNewline
        Reset-Artifacts
    }
}

Write-Host ""
if ($script:Failures -gt 0) {
    Write-Host "release-check.cmd harness: $($script:Failures) scenario(s) FAILED"
    exit 1
}
Write-Host 'release-check.cmd harness: all scenarios passed'
exit 0
