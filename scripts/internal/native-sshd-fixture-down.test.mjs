// Tests for the Windows native sshd fixture's teardown (#6074): a session that
// outlived its sshd held sshd.log, and `down` failed a lane whose tests had all
// passed. The functions are taken out of native-sshd-fixture.ps1 (its top level
// needs Windows) and run on a local pwsh with the process cmdlets replaced.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "native-sshd-fixture.ps1");
const HAS_PWSH = spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"]).status === 0;

/** Define the named functions of the fixture, then run `body`. */
function run(functions, body) {
  const script = `
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile('${FIXTURE}', [ref]$tokens, [ref]$errors)
foreach ($name in @(${functions.map((f) => `'${f}'`).join(",")})) {
    $fn = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
    Invoke-Expression $fn.Extent.Text
}
function Write-FixtureLog([string]$Message) { Write-Output "LOG $Message" }
${body}
`;
  return spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 60_000,
  });
}

describe.skipIf(!HAS_PWSH)("Remove-FixtureDir", () => {
  let root;
  let dir;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "native-sshd-down-"));
    dir = path.join(root, "fixture");
    mkdirSync(path.join(dir, "agent"), { recursive: true });
    for (const name of ["sshd.log", "password", "agent/termihub-agent.exe"])
      writeFileSync(path.join(dir, name), "x");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Remove-FixtureDir, with `file` in use for the first `attempts` deletions. */
  const remove = (file, attempts, seconds = 1) =>
    run(
      ["Remove-FixtureDir"],
      `
$Dir = '${dir}'
$script:refusals = ${attempts}
function Get-CimInstance { [pscustomobject]@{ Name = 'sshd.exe'; ProcessId = 7; ParentProcessId = 1; CommandLine = 'sshd -E' } }
function Remove-Item {
    param($LiteralPath, [switch]$Recurse, [switch]$Force)
    process {
        $target = if ($LiteralPath) { $LiteralPath } else { $_.FullName }
        if ((Split-Path -Leaf $target) -eq '${file}' -and $script:refusals-- -gt 0) { return }
        Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $target -Recurse:$Recurse -Force:$Force
    }
}
Remove-FixtureDir -Seconds ${seconds}
`.replace(
        "param($LiteralPath",
        "[CmdletBinding()] param([Parameter(ValueFromPipeline)]$Item, $LiteralPath"
      )
    );

  it("removes the directory", () => {
    const r = remove("none", 0);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect(r.stdout).toContain("removed)");
  });

  it("waits for a file that is briefly in use", () => {
    const r = remove("sshd.log", 2, 15);
    expect(r.status).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  it("passes with a warning, and names the sshd processes, when only a log stays in use", () => {
    const r = remove("sshd.log", 1000);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("WARNING");
    expect(r.stdout).toContain("sshd.log");
    expect(r.stdout).toContain("still running: sshd.exe 7 (parent 1): sshd -E");
    expect(readdirSync(dir)).not.toContain("password");
    expect(existsSync(path.join(dir, "agent", "termihub-agent.exe"))).toBe(false);
  });

  it("fails when anything but a log stays behind", () => {
    const r = remove("password", 1000);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("could not remove");
    expect(r.stderr).toContain("password");
  });
});

describe.skipIf(!HAS_PWSH)("Stop-FixtureLeftover", () => {
  it("stops the test user's processes and the fixture's own sshd, and no other", () => {
    const r = run(
      ["Stop-FixtureLeftover", "Wait-FixtureProcess"],
      String.raw`
$env:COMPUTERNAME = 'HOST'
$TestUser = 'termihubssh'
$Config = 'C:\fx\sshd_config'; $JumpConfig = 'C:\fx\jump_sshd_config'
$LogFile = 'C:\fx\sshd.log'; $JumpLogFile = 'C:\fx\jump_sshd.log'
function Proc($Id, $ProcessName, $UserName) { [pscustomobject]@{ Id = $Id; ProcessName = $ProcessName; UserName = $UserName } }
function Get-CimInstance {
    [pscustomobject]@{ ProcessId = 10; Name = 'sshd-session.exe'; CommandLine = 'sshd-session.exe -E c:\FX\sshd.log -R' }
    [pscustomobject]@{ ProcessId = 11; Name = 'sshd.exe'; CommandLine = 'C:\Windows\System32\OpenSSH\sshd.exe' }
    [pscustomobject]@{ ProcessId = 12; Name = 'sshd.exe'; CommandLine = $null }
    [pscustomobject]@{ ProcessId = 13; Name = 'notepad.exe'; CommandLine = 'notepad C:\fx\sshd.log' }
}
function Get-Process {
    Proc 10 'sshd-session' 'NT AUTHORITY\SYSTEM'
    Proc 11 'sshd' 'NT AUTHORITY\SYSTEM'
    Proc 12 'sshd' 'NT AUTHORITY\SYSTEM'
    Proc 13 'notepad' 'HOST\runner'
    Proc 20 'bash' 'host\termihubssh'
    Proc 21 'bash' 'OTHER\termihubssh'
    Proc 22 'bash' 'HOST\termihubssh2'
    Proc 23 'idle' $null
}
function Stop-Process($InputObject, [switch]$Force) { Write-Output "STOP $($InputObject.Id)" }
function Wait-Process($InputObject, $Timeout) { Write-Output "WAIT $($InputObject.Id)" }
Stop-FixtureLeftover
`
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const lines = r.stdout.split(/\r?\n/);
    expect(lines.filter((l) => l.startsWith("STOP"))).toEqual(["STOP 10", "STOP 20"]);
    expect(lines.filter((l) => l.startsWith("WAIT"))).toEqual(["WAIT 10", "WAIT 20"]);
  });
});
