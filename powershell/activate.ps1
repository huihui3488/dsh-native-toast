# Handles a toast click: brings the DeepSeek Harness window forward and tells
# the Host which conversation action the Client half should perform.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Uri
)

$ErrorActionPreference = 'SilentlyContinue'

function Get-State {
    $path = Join-Path $env:TEMP 'dsh-native-toast-state.json'
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    try { return Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $null }
}

function Get-Query {
    param([string]$Url)
    $query = @{}
    try {
        $parsed = [uri]$Url
        foreach ($pair in $parsed.Query.TrimStart('?').Split('&')) {
            if ($pair -eq '') { continue }
            $parts = $pair.Split('=', 2)
            $key = [uri]::UnescapeDataString($parts[0])
            $value = if ($parts.Length -gt 1) { [uri]::UnescapeDataString($parts[1]) } else { '' }
            $query[$key] = $value
        }
    }
    catch {
        # A malformed launch URI still focuses the window.
    }
    return $query
}

Add-Type -Namespace DshToast -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
'@

function Focus-DshWindow {
    $proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne [System.IntPtr]::Zero } |
        Select-Object -First 1

    if ($null -eq $proc) {
        # Single-instance launch: a second start asks the owner to show and focus.
        $state = Get-State
        if ($state -and $state.exe -and (Test-Path -LiteralPath $state.exe)) {
            Start-Process -FilePath $state.exe | Out-Null
            Start-Sleep -Milliseconds 800
        }
        $proc = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowHandle -ne [System.IntPtr]::Zero } |
            Select-Object -First 1
    }
    if ($null -eq $proc) { return }

    $handle = $proc.MainWindowHandle
    $visible = [DshToast.Native]::IsWindowVisible($handle)
    $minimized = [DshToast.Native]::IsIconic($handle)

    # Already on screen: leave position, size and z-order untouched; the click
    # still scrolls, which is the whole point when the user is looking at it.
    if ($visible -and -not $minimized) { return }

    if ($minimized) {
        # SW_RESTORE only from minimized; on a visible maximized window it would
        # un-maximize and move/resize the window, which the user did not ask for.
        [DshToast.Native]::ShowWindow($handle, 9) | Out-Null
    }
    else {
        [DshToast.Native]::ShowWindow($handle, 5) | Out-Null
    }
    [DshToast.Native]::SetForegroundWindow($handle) | Out-Null
    if ([DshToast.Native]::GetForegroundWindow() -ne $handle) {
        # Windows' foreground lock admits the next call after an Alt tap.
        [DshToast.Native]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
        [DshToast.Native]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 60
        [DshToast.Native]::SetForegroundWindow($handle) | Out-Null
    }
}

$query = Get-Query -Url $Uri
$kind = if ($query.ContainsKey('kind')) { $query['kind'] } else { 'complete' }
$text = if ($query.ContainsKey('text')) { $query['text'] } else { '' }

Focus-DshWindow

$state = Get-State
if ($state -and $state.origin) {
    $clickUrl = $state.origin.TrimEnd('/') +
        '/api/dsh-native-toast/click?kind=' + [uri]::EscapeDataString($kind) +
        '&text=' + [uri]::EscapeDataString($text)
    try { Invoke-RestMethod -Uri $clickUrl -Method Post -TimeoutSec 5 | Out-Null } catch { }
}
