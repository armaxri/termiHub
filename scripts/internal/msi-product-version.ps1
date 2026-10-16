<#
.SYNOPSIS
    Print an MSI's ProductVersion and, with -Expected, assert it (#4442).

.DESCRIPTION
    Tauri's WiX bundler takes the MSI ProductVersion from
    bundle.windows.wix.version when it is set, and release.yml sets it from
    scripts/internal/msi-version.mjs (PKG2-003, #4283): X.Y.Z-beta.N maps to
    X.Y.Z.(10000 + N), -rc.N to X.Y.Z.(20000 + N) and a final X.Y.Z to
    X.Y.Z.30000. This script reads the Property table of a built MSI through
    the WindowsInstaller COM API (read-only: nothing is installed) and prints
    its ProductVersion, ProductName and ProductCode. With -Expected it fails
    unless ProductVersion equals the expected version exactly, so a fragment
    that was not merged (ProductVersion X.Y.Z or X.Y.Z.0) is caught.

    Needs Windows (the WindowsInstaller.Installer COM object). Always ends with
    an explicit exit code: 0 on success, 1 on a mismatch or an unreadable MSI.

.PARAMETER Msi
    MSI to read.

.PARAMETER Expected
    The ProductVersion the MSI must carry, e.g. 0.0.0.10001.

.EXAMPLE
    ./scripts/internal/msi-product-version.ps1 -Msi termiHub_0.0.0-beta.1_x64_en-US.msi -Expected 0.0.0.10001
#>
param(
    [Parameter(Mandatory = $true)][string]$Msi,
    [string]$Expected = ''
)

$ErrorActionPreference = 'Stop'

function Get-MsiProperty {
    param($Database, [string]$Name)
    $view = $Database.OpenView("SELECT ``Value`` FROM ``Property`` WHERE ``Property`` = '$Name'")
    try {
        $view.Execute()
        $record = $view.Fetch()
        if ($null -eq $record) { return $null }
        return $record.StringData(1)
    } finally {
        $view.Close()
    }
}

try {
    $path = (Resolve-Path -LiteralPath $Msi).Path
    $installer = New-Object -ComObject WindowsInstaller.Installer
    # 0 = msiOpenDatabaseModeReadOnly
    $db = $installer.OpenDatabase($path, 0)
    $version = Get-MsiProperty $db 'ProductVersion'
    $name = Get-MsiProperty $db 'ProductName'
    $code = Get-MsiProperty $db 'ProductCode'
} catch {
    Write-Output "::error::cannot read the MSI Property table of ${Msi}: $($_.Exception.Message)"
    exit 1
}

Write-Output "MSI:            $path"
Write-Output "ProductName:    $name"
Write-Output "ProductVersion: $version"
Write-Output "ProductCode:    $code"

if ([string]::IsNullOrEmpty($version)) {
    Write-Output "::error::$Msi has no ProductVersion property"
    exit 1
}
if ($Expected -ne '' -and $version -ne $Expected) {
    Write-Output "::error::MSI ProductVersion is '$version', expected '$Expected' (the mapped wix.version)"
    exit 1
}
if ($Expected -ne '') {
    Write-Output "ProductVersion matches the expected $Expected"
}
exit 0
