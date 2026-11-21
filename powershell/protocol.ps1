# Registers (or removes) the `dsh-native-toast:` URL protocol that a toast click
# activates. HKCU only: no elevation, and it points at this plugin's
# activate.ps1 until the plugin is disabled.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ActivateScript,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$scheme = 'dsh-native-toast'
$root = "HKCU:\Software\Classes\$scheme"

if ($Remove) {
    Remove-Item -Path $root -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
}

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$command = '"' + $powershell + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ActivateScript + '" "%1"'

# Prefer the GUI-subsystem wscript launcher: activating a toast from the
# notification center would otherwise flash a console window.
$hidden = Join-Path (Split-Path -Parent $ActivateScript) 'hidden.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
if ((Test-Path -LiteralPath $hidden -PathType Leaf) -and (Test-Path -LiteralPath $wscript -PathType Leaf)) {
    $command = '"' + $wscript + '" //B //Nologo "' + $hidden + '" "' + $powershell + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ActivateScript + '" "%1"'
}

New-Item -Path "$root\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path $root -Name '(Default)' -Value 'URL:DeepSeek Harness toast click'
New-ItemProperty -Path $root -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
Set-ItemProperty -Path "$root\shell\open\command" -Name '(Default)' -Value $command
