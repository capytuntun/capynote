# capynote "open in incognito" protocol handler.
#   capynote-incognito:<url-encoded http(s) url>  ->  chrome.exe --incognito <url>
# Chrome reuses an existing incognito window (new tab) and only opens a new one when
# there is none; Edge (--inprivate) is the fallback when Chrome is not installed.
# Accepts http(s) URLs only and never runs anything but the browser, since any web
# page can trigger a registered protocol once the user has allowed it.
# Registered into HKCU by install.cmd, removed by uninstall.cmd. ASCII only: PowerShell
# 5.1 reads a BOM-less file as ANSI.
param(
  [Parameter(Mandatory = $true)][string]$Arg,
  [switch]$DryRun
)

$raw = $Arg -replace '^capynote-incognito:/*', ''
$url = [uri]::UnescapeDataString($raw)
if ($url -notmatch '^https?://[^\s"''<>]+$') {
  if ($DryRun) { Write-Output "rejected: $url" }
  exit 1
}

function Find-Browser {
  foreach ($exe in 'chrome.exe', 'msedge.exe') {
    foreach ($hive in 'HKLM:', 'HKCU:') {
      $k = "$hive\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exe"
      if (-not (Test-Path $k)) { continue }
      $p = (Get-ItemProperty $k).'(default)'
      if ($p -and (Test-Path $p)) {
        $flag = if ($exe -eq 'chrome.exe') { '--incognito' } else { '--inprivate' }
        return @{ Path = $p; Flag = $flag }
      }
    }
  }
  return $null
}

$b = Find-Browser
if (-not $b) {
  if ($DryRun) { Write-Output 'no browser found' }
  exit 2
}
if ($DryRun) { Write-Output ('would run: "' + $b.Path + '" ' + $b.Flag + ' ' + $url); exit 0 }
Start-Process -FilePath $b.Path -ArgumentList @($b.Flag, $url)
