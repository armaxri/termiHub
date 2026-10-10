<#
.SYNOPSIS
    Fail if a locally built agent carries test-only artifacts (#4554).

.DESCRIPTION
    The PowerShell twin of the two bash guards CI runs on every agent build, for
    scripts\build-agents.cmd on a Windows box that may have no bash:

      * scripts/internal/assert-no-test-signing-key.sh (#4083): the binary must not
        embed the TEST-ONLY update-signing key (the base64 body of
        agent/keys/test-only/update-signing-TEST-ONLY.pub.pem, compiled in only by
        `--features test-hooks`), and agent/keys/update-signing.pub.pem must not
        list it;
      * scripts/internal/assert-no-agent-test-hooks.sh (#4362): the binary must not
        contain the env-var names that arm the agent's test hooks (compiled in by
        test-hooks and by every debug build). Skipped with -SkipTestHooks, which
        build-agents.cmd passes for --dev builds. The names are read from their
        Rust definitions, with the same patterns as the bash guard, so the check
        cannot drift from the code: a definition that moved fails with exit 2.

    Plain .NET only, no cmdlets: run from pwsh, powershell.exe inherits pwsh's
    PSModulePath and module autoload breaks (#4029). Also runs on macOS/Linux
    with pwsh (tests/system/tests/test_build_agents_artifact_guard.py does).

    Exit status: 0 = clean, 1 = a test-only artifact found, 2 = usage / missing
    file / a definition the guard cannot find.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\internal\assert-no-agent-test-artifacts.ps1 -Binary target\x86_64-pc-windows-msvc\release\termihub-agent.exe
#>
param(
    [Parameter(Mandatory = $true)][string]$Binary,
    [switch]$SkipTestHooks
)

$ErrorActionPreference = 'Stop'

try {
    $repoRoot = [IO.Path]::GetFullPath([IO.Path]::Combine($PSScriptRoot, '..', '..'))
    $testPub = [IO.Path]::Combine($repoRoot, 'agent', 'keys', 'test-only', 'update-signing-TEST-ONLY.pub.pem')
    $releasePub = [IO.Path]::Combine($repoRoot, 'agent', 'keys', 'update-signing.pub.pem')
    $agentSrc = [IO.Path]::Combine($repoRoot, 'agent', 'src')

    if (-not [IO.File]::Exists($Binary)) {
        [Console]::Error.WriteLine("assert-no-agent-test-artifacts: no such file: $Binary")
        exit 2
    }

    # The base64 body line(s) of the PEM block -- exactly what include_str! embeds.
    $keyLines = @()
    $inside = $false
    foreach ($raw in [IO.File]::ReadAllLines($testPub)) {
        $line = $raw.Trim()
        if ($line -eq '-----BEGIN PUBLIC KEY-----') { $inside = $true; continue }
        if ($line -eq '-----END PUBLIC KEY-----') { $inside = $false; continue }
        if ($inside -and $line.Length -gt 0) { $keyLines += $line }
    }
    if ($keyLines.Count -eq 0) {
        [Console]::Error.WriteLine("assert-no-agent-test-artifacts: no key found in $testPub")
        exit 2
    }

    # <file under agent/src> <regex whose group 1 is the name>: same definitions
    # as assert-no-agent-test-hooks.sh. \x22 is a double quote.
    $hookNames = @()
    if (-not $SkipTestHooks) {
        $defs = @(
            @('test_parent_watchdog.rs', '^pub const PARENT_PID_ENV: &str = \x22(.*)\x22;$'),
            @('io/tcp.rs', '^ *if let Some\(ms\) = std::env::var\(\x22(TERMIHUB_TEST_[A-Z_]*)\x22\)$'),
            @('update/test_hook.rs', '^pub const TEST_PENDING_UPDATE_ENV: &str = \x22(.*)\x22;$')
        )
        foreach ($def in $defs) {
            $name = $null
            foreach ($line in [IO.File]::ReadAllLines([IO.Path]::Combine($agentSrc, $def[0]))) {
                $m = [Text.RegularExpressions.Regex]::Match($line.TrimEnd("`r"), $def[1])
                if ($m.Success) { $name = $m.Groups[1].Value; break }
            }
            if (-not $name) {
                [Console]::Error.WriteLine("assert-no-agent-test-artifacts: test-hook env name not found in agent/src/$($def[0])")
                exit 2
            }
            $hookNames += $name
        }
    }

    $found = $false
    $releaseText = [IO.File]::ReadAllText($releasePub)
    foreach ($needle in $keyLines) {
        if ($releaseText.IndexOf($needle, [StringComparison]::Ordinal) -ge 0) {
            [Console]::Error.WriteLine("ERROR: $releasePub trusts the TEST-ONLY update-signing key -- remove it")
            $found = $true
        }
    }

    # Latin-1 maps every byte to one char, so an ASCII needle matches byte-wise.
    $data = [Text.Encoding]::GetEncoding(28591).GetString([IO.File]::ReadAllBytes($Binary))
    foreach ($needle in $keyLines) {
        if ($data.IndexOf($needle, [StringComparison]::Ordinal) -ge 0) {
            [Console]::Error.WriteLine("ERROR: $Binary embeds the TEST-ONLY update-signing key: it was built with the test-hooks feature and must never ship (see agent/keys/test-only/README.md)")
            $found = $true
            break
        }
    }
    foreach ($name in $hookNames) {
        if ($data.IndexOf($name, [StringComparison]::Ordinal) -ge 0) {
            [Console]::Error.WriteLine("ERROR: $Binary contains the test-hook env var ${name}: it was built with debug assertions or the test-hooks feature and must never ship")
            $found = $true
        }
    }

    if ($found) { exit 1 }
    if ($SkipTestHooks) {
        [Console]::Out.WriteLine("ok: $Binary does not embed the TEST-ONLY update-signing key")
    } else {
        [Console]::Out.WriteLine("ok: $Binary embeds no TEST-ONLY update-signing key and no env-armed agent test hooks")
    }
    exit 0
} catch {
    [Console]::Error.WriteLine("assert-no-agent-test-artifacts: $($_.Exception.Message)")
    exit 2
}
