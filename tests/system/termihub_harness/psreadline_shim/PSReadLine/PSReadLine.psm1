# Test-harness PSReadLine shim (#5055). Never used outside the system-test lane.
#
# The harness puts this folder first on the test app's PSModulePath, so every
# PowerShell the app under test starts imports this module where it would
# import PSReadLine. It loads the real PSReadLine (the next one on
# PSModulePath) and then points it at the history file named by
# TERMIHUB_TEST_PSREADLINE_HISTORY, private to that app instance, with
# history-based predictions off. Two test apps then never share or recall each
# other's history. See termihub_harness/psreadline.py.

$shimRoot = Split-Path -Parent $PSScriptRoot
$real = Get-Module -ListAvailable -Name PSReadLine |
    Where-Object { -not $_.ModuleBase.StartsWith($shimRoot, [StringComparison]::OrdinalIgnoreCase) } |
    Select-Object -First 1
if ($null -eq $real) { return }
Import-Module -Name $real.Path -Global

$history = $env:TERMIHUB_TEST_PSREADLINE_HISTORY
if ($history) {
    Set-PSReadLineOption -HistorySavePath $history
}
if ((Get-Command Set-PSReadLineOption).Parameters.ContainsKey('PredictionSource')) {
    Set-PSReadLineOption -PredictionSource None
}
