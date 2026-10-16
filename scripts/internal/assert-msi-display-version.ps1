<#
.SYNOPSIS
    Assert an installed MSI's DisplayVersion equals the mapped MSI version (#4441).

.DESCRIPTION
    release.yml builds the Windows MSI with bundle.windows.wix.version set from
    scripts/internal/msi-version.mjs (PKG2-003, #4283): X.Y.Z-beta.N maps to
    X.Y.Z.(10000 + N), -rc.N to X.Y.Z.(20000 + N) and a final X.Y.Z to
    X.Y.Z.30000. The installed "Add/Remove Programs" entry's DisplayVersion is
    the MSI ProductVersion, so release-windows-smoke.yml passes it here with the
    mapped version and this fails unless they are equal. A missing or wrong
    wix.version override (DisplayVersion X.Y.Z, X.Y.Z.0 or another revision) is
    caught; a prefix match is not enough.

    Both values are trimmed first: PowerShell output and registry values can
    carry padding (#4879 hit " 0.0.0.10001 "). Nothing else is normalised.

    Pure string logic, so it runs on any pwsh (scripts/internal/msi-version.test.mjs
    exercises it). Always ends with an explicit exit code: 0 on a match, 1 on a
    mismatch or an empty value.

.PARAMETER Actual
    The installed entry's DisplayVersion.

.PARAMETER Expected
    The mapped MSI version, e.g. 0.2.0.10001 (msi-version.mjs output).

.EXAMPLE
    ./scripts/internal/assert-msi-display-version.ps1 -Actual $entry.DisplayVersion -Expected 0.2.0.10001
#>
param(
    [AllowEmptyString()][AllowNull()][string]$Actual = '',
    [AllowEmptyString()][AllowNull()][string]$Expected = ''
)

$actualTrimmed = "$Actual".Trim()
$expectedTrimmed = "$Expected".Trim()

if ($expectedTrimmed -eq '') {
    Write-Output "::error::no expected MSI version given (msi-version.mjs produced nothing?)"
    exit 1
}
if ($actualTrimmed -eq '') {
    Write-Output "::error::installed DisplayVersion is empty, expected '$expectedTrimmed'"
    exit 1
}
# -ceq: versions are digits and dots, so a case-sensitive exact compare is the
# strictest form of "equal".
if (-not ($actualTrimmed -ceq $expectedTrimmed)) {
    Write-Output ("::error::installed DisplayVersion is '$actualTrimmed', expected " +
        "'$expectedTrimmed' (the mapped wix.version from msi-version.mjs)")
    exit 1
}
Write-Output "installed DisplayVersion matches the mapped MSI version $expectedTrimmed"
exit 0
