<#
.SYNOPSIS
    Fail on an assignment to a PowerShell parameter spelled in a different case.

.DESCRIPTION
    PowerShell variable names are case-insensitive, so inside

        function Register-SshdTask([hashtable]$Sshd) { $sshd = 'C:\...\sshd.exe' }

    `$sshd` is the `[hashtable]$Sshd` parameter, not a new local: the string is
    converted to the parameter's type and the call throws at run time ("Cannot
    convert ... to type System.Collections.Hashtable"). That broke the Windows
    native sshd fixture on every leg of the post-merge Windows SSH Host lane
    (#5506), a lane no PR runs. Parsing alone does not catch it, so this walks
    the AST: for every function (and the script's own param block) it flags an
    assignment, in that scope, whose target matches a parameter's name
    case-insensitively but not exactly. Nested function definitions are their
    own scope and are checked separately.

    Parse-only: nothing in the checked scripts runs. Usage:

        pwsh -NoProfile -NonInteractive -File scripts/internal/check-ps1-param-case.ps1 [file ...]

    Without arguments it checks every *.ps1 under scripts/ (git ls-files).
#>
[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Paths = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if ($Paths.Count -eq 0) {
    $Paths = @(git -C $repoRoot ls-files -- 'scripts/*.ps1' 'scripts/**/*.ps1' |
            Sort-Object -Unique | ForEach-Object { Join-Path $repoRoot $_ })
}

function Get-ScopeParameterName([System.Management.Automation.Language.Ast]$Scope) {
    # The parameters a function or script declares: `function F($a)` form or
    # a param() block in its body.
    $names = [Collections.Generic.List[string]]::new()
    if ($Scope -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
        if ($null -ne $Scope.Parameters) {
            $Scope.Parameters | ForEach-Object { $names.Add($_.Name.VariablePath.UserPath) }
        }
        $body = $Scope.Body
    } else {
        $body = $Scope
    }
    if ($null -ne $body.ParamBlock) {
        $body.ParamBlock.Parameters | ForEach-Object { $names.Add($_.Name.VariablePath.UserPath) }
    }
    return $names.ToArray()
}

function Get-AssignedVariable([System.Management.Automation.Language.Ast]$Target) {
    # The variable(s) an assignment target names: `$x`, `[int]$x`, `$a, $b`.
    if ($Target -is [System.Management.Automation.Language.VariableExpressionAst]) {
        return @($Target)
    }
    if ($Target -is [System.Management.Automation.Language.ConvertExpressionAst] -or
        $Target -is [System.Management.Automation.Language.AttributedExpressionAst]) {
        return @(Get-AssignedVariable $Target.Child)
    }
    if ($Target -is [System.Management.Automation.Language.ArrayLiteralAst]) {
        return @($Target.Elements | ForEach-Object { Get-AssignedVariable $_ })
    }
    return @()
}

function Test-InScope([System.Management.Automation.Language.Ast]$Node, [System.Management.Automation.Language.Ast]$Scope) {
    # True when the nearest enclosing function of $Node is $Scope (or, for the
    # script scope, when no function encloses it).
    $parent = $Node.Parent
    while ($null -ne $parent) {
        if ($parent -is [System.Management.Automation.Language.FunctionDefinitionAst]) {
            return [object]::ReferenceEquals($parent, $Scope)
        }
        $parent = $parent.Parent
    }
    return -not ($Scope -is [System.Management.Automation.Language.FunctionDefinitionAst])
}

$findings = [Collections.Generic.List[string]]::new()
foreach ($path in $Paths) {
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)
    foreach ($err in @($errors)) {
        if ($null -ne $err) {
            $findings.Add(("{0}:{1}: parse error: {2}" -f $path, $err.Extent.StartLineNumber, $err.Message))
        }
    }
    $scopes = @($ast) + @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true))
    $assignments = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true))
    foreach ($scope in $scopes) {
        $params = @(Get-ScopeParameterName $scope)
        if ($params.Count -eq 0) {
            continue
        }
        foreach ($assignment in $assignments) {
            if (-not (Test-InScope $assignment $scope)) {
                continue
            }
            foreach ($var in @(Get-AssignedVariable $assignment.Left)) {
                $name = $var.VariablePath.UserPath
                foreach ($param in $params) {
                    if ($name -ieq $param -and $name -cne $param) {
                        $findings.Add(("{0}:{1}: `${2} is the parameter `${3} (PowerShell names are case-insensitive); rename the local" -f
                                $path, $var.Extent.StartLineNumber, $name, $param))
                    }
                }
            }
        }
    }
}

if ($findings.Count -gt 0) {
    $findings | ForEach-Object { Write-Output $_ }
    Write-Output "check-ps1-param-case: $($findings.Count) finding(s) in $($Paths.Count) file(s)"
    exit 1
}
Write-Output "check-ps1-param-case: checked $($Paths.Count) file(s), no findings"
