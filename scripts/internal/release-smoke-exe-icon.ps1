<#
.SYNOPSIS
  Release install-smoke: the Windows executable embeds termiHub's own icon
  (#4933, MT-UI-19).

.DESCRIPTION
  Explorer, the taskbar and the Start menu take the app's icon from the icon
  resources embedded in termihub.exe. This reads them straight from the PE file
  (no System.Drawing, so it also runs under pwsh on Linux/macOS) and checks:

    - the executable has an RT_GROUP_ICON resource with one entry per image of
      src-tauri/icons/icon.ico;
    - every image of icon.ico is embedded byte for byte as an RT_ICON resource.

  A missing, placeholder or stale icon fails, instead of waiting for an operator
  to notice a generic icon in the taskbar.

.PARAMETER Exe
  The installed termihub.exe.

.PARAMETER Ico
  The repository's src-tauri/icons/icon.ico.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $Exe,
  [Parameter(Mandatory)] [string] $Ico
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

foreach ($f in @($Exe, $Ico)) {
  if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { throw "'$f' is not a file" }
}

function Get-Hash([byte[]] $Bytes) {
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes))
}

# The images of an .ico file (ICONDIR + ICONDIRENTRY records).
function Get-IcoImage([byte[]] $B) {
  if ([BitConverter]::ToUInt16($B, 2) -ne 1) { throw "'$Ico' is not an icon file" }
  $count = [BitConverter]::ToUInt16($B, 4)
  for ($i = 0; $i -lt $count; $i++) {
    $e = 6 + 16 * $i
    $size = [BitConverter]::ToUInt32($B, $e + 8)
    $offset = [BitConverter]::ToUInt32($B, $e + 12)
    $w = if ($B[$e] -eq 0) { 256 } else { $B[$e] }
    [pscustomobject]@{ Size = "${w}px"; Bytes = [byte[]]$B[$offset..($offset + $size - 1)] }
  }
}

# The resources of a PE file, as type id -> list of byte arrays.
function Get-PeResource([byte[]] $B) {
  $pe = [BitConverter]::ToInt32($B, 0x3C)
  if ([BitConverter]::ToUInt32($B, $pe) -ne 0x4550) { throw "'$Exe' is not a PE file" }
  $sections = [BitConverter]::ToUInt16($B, $pe + 6)
  $optSize = [BitConverter]::ToUInt16($B, $pe + 20)
  $opt = $pe + 24
  $dirs = if ([BitConverter]::ToUInt16($B, $opt) -eq 0x20b) { $opt + 112 } else { $opt + 96 }
  $rsrcRva = [BitConverter]::ToUInt32($B, $dirs + 16)  # DataDirectory[2]
  if ($rsrcRva -eq 0) { return @{} }
  $table = $opt + $optSize
  $toOffset = {
    param([uint32] $Rva)
    for ($s = 0; $s -lt $sections; $s++) {
      $h = $table + 40 * $s
      $va = [BitConverter]::ToUInt32($B, $h + 12)
      $len = [Math]::Max([BitConverter]::ToUInt32($B, $h + 8), [BitConverter]::ToUInt32($B, $h + 16))
      if ($Rva -ge $va -and $Rva -lt $va + $len) {
        return [BitConverter]::ToUInt32($B, $h + 20) + ($Rva - $va)
      }
    }
    throw "RVA $Rva lies in no section"
  }
  $base = & $toOffset $rsrcRva
  # The entries of a resource directory: id (or name offset) and target.
  $entries = {
    param([long] $Dir)
    $n = [BitConverter]::ToUInt16($B, $Dir + 12) + [BitConverter]::ToUInt16($B, $Dir + 14)
    for ($i = 0; $i -lt $n; $i++) {
      $e = $Dir + 16 + 8 * $i
      [pscustomobject]@{
        Id     = [BitConverter]::ToUInt32($B, $e)
        Target = [BitConverter]::ToUInt32($B, $e + 4)
      }
    }
  }
  $result = @{}
  foreach ($type in & $entries $base) {
    $list = [Collections.Generic.List[byte[]]]::new()
    foreach ($name in & $entries ($base + ($type.Target -band 0x7FFFFFFF))) {
      foreach ($lang in & $entries ($base + ($name.Target -band 0x7FFFFFFF))) {
        $data = $base + $lang.Target
        $rva = [BitConverter]::ToUInt32($B, $data)
        $size = [BitConverter]::ToUInt32($B, $data + 4)
        $off = & $toOffset $rva
        $list.Add([byte[]]$B[$off..($off + $size - 1)])
      }
    }
    $result[[int]$type.Id] = $list
  }
  return $result
}

$passed = 0
$failed = 0
function Pass([string] $m) { Write-Output "  PASS: $m"; $script:passed++ }
function Fail([string] $m) { Write-Output "::error::exe icon smoke: $m"; $script:failed++ }

Write-Output '=== termiHub release smoke: embedded executable icon ==='
Write-Output "  exe: $Exe"
Write-Output "  ico: $Ico"
$images = @(Get-IcoImage ([IO.File]::ReadAllBytes($Ico)))
$res = Get-PeResource ([IO.File]::ReadAllBytes($Exe))

$RT_ICON = 3
$RT_GROUP_ICON = 14
# A plain loop: piping or returning a list of byte arrays would unroll them.
$groupCounts = [Collections.Generic.List[int]]::new()
if ($res.ContainsKey($RT_GROUP_ICON)) {
  foreach ($group in $res[$RT_GROUP_ICON]) { $groupCounts.Add([BitConverter]::ToUInt16($group, 4)) }
}
if ($groupCounts -contains $images.Count) {
  Pass "an RT_GROUP_ICON lists $($images.Count) image(s), like icon.ico"
} elseif ($groupCounts.Count -eq 0) {
  Fail 'the executable has no RT_GROUP_ICON (Explorer and the taskbar would show a generic icon)'
} else {
  Fail "the executable's icon groups list $($groupCounts -join '/') image(s); icon.ico has $($images.Count)"
}

$embedded = @{}
if ($res.ContainsKey($RT_ICON)) {
  foreach ($blob in $res[$RT_ICON]) { $embedded[(Get-Hash $blob)] = $true }
}
foreach ($img in $images) {
  if ($embedded.ContainsKey((Get-Hash $img.Bytes))) {
    Pass "the $($img.Size) image of icon.ico is embedded byte for byte"
  } else {
    Fail "the $($img.Size) image of icon.ico is not embedded (a placeholder or stale icon)"
  }
}

Write-Output ''
Write-Output "  Exe icon smoke: $passed passed, $failed failed"
if ($failed -gt 0) { exit 1 }
exit 0
