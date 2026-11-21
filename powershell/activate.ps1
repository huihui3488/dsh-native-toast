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
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr GetAncestor(System.IntPtr hWnd, uint gaFlags);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern System.IntPtr WindowFromPoint(POINT point);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT rect);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint processId);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern int GetClassName(System.IntPtr hWnd, System.Text.StringBuilder name, int max);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
'@

function Test-IsForeground {
    param([System.IntPtr]$Handle)
    $foreground = [DshToast.Native]::GetForegroundWindow()
    if ($foreground -eq [System.IntPtr]::Zero) { return $false }
    return ([DshToast.Native]::GetAncestor($foreground, 2) -eq [DshToast.Native]::GetAncestor($Handle, 2))
}

function Test-WindowCovered {
    param([System.IntPtr]$Handle)
    # Already in front: nothing to raise, and no sampled point can say otherwise.
    if (Test-IsForeground -Handle $Handle) { return $false }

    $rect = New-Object DshToast.Native+RECT
    if (-not [DshToast.Native]::GetWindowRect($Handle, [ref]$rect)) { return $false }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -lt 40 -or $height -lt 40) { return $false }

    # Windows' own notification/tray surfaces must not count as covering apps.
    $ignored = @('ShellExperienceHost', 'StartMenuExperienceHost', 'TextInputHost', 'SearchHost', 'SearchApp')
    # explorer.exe hosts both File Explorer windows (real cover) and the shell
    # surfaces below; only the shell classes are ignored.
    $shellClasses = @('Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'TrayNotifyWnd', 'Progman', 'WorkerW')

    for ($fx = 1; $fx -le 4; $fx++) {
        for ($fy = 1; $fy -le 4; $fy++) {
            $point = New-Object DshToast.Native+POINT
            $point.X = $rect.Left + [int]($width * $fx / 5)
            $point.Y = $rect.Top + [int]($height * $fy / 5)
            $under = [DshToast.Native]::WindowFromPoint($point)
            if ($under -eq [System.IntPtr]::Zero) { continue }
            $underRoot = [DshToast.Native]::GetAncestor($under, 2)
            if ($underRoot -eq [System.IntPtr]::Zero) { continue }
            if ($underRoot -eq [DshToast.Native]::GetAncestor($Handle, 2)) { continue }
            $processId = 0
            [DshToast.Native]::GetWindowThreadProcessId($underRoot, [ref]$processId) | Out-Null
            $processName = ''
            try { $processName = (Get-Process -Id $processId -ErrorAction Stop).ProcessName } catch { $processName = '' }
            if ($ignored -contains $processName) { continue }
            if ($processName -eq 'explorer') {
                $className = New-Object System.Text.StringBuilder 256
                [DshToast.Native]::GetClassName($underRoot, $className, 256) | Out-Null
                if ($shellClasses -contains $className.ToString()) { continue }
            }
            return $true
        }
    }
    return $false
}

function Raise-DshWindow {
    param([System.IntPtr]$Handle)
    # Foreground only: never move, resize, or change the maximized state.
    [DshToast.Native]::SetForegroundWindow($Handle) | Out-Null
    if (-not (Test-IsForeground -Handle $Handle)) {
        # Windows' foreground lock admits the next call after an Alt tap.
        [DshToast.Native]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
        [DshToast.Native]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 60
        [DshToast.Native]::SetForegroundWindow($Handle) | Out-Null
    }
}

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

    if ($visible -and -not $minimized) {
        # On screen: never move or resize. Only raise it when another window
        # actually covers part of it; a fully visible window stays as it is.
        if (Test-WindowCovered -Handle $handle) {
            Raise-DshWindow -Handle $handle
        }
        return
    }

    if ($minimized) {
        # SW_RESTORE only from minimized; on a visible maximized window it would
        # un-maximize and move/resize the window, which the user did not ask for.
        [DshToast.Native]::ShowWindow($handle, 9) | Out-Null
    }
    else {
        [DshToast.Native]::ShowWindow($handle, 5) | Out-Null
    }
    Raise-DshWindow -Handle $handle
}

$query = Get-Query -Url $Uri
$kind = if ($query.ContainsKey('kind')) { $query['kind'] } else { 'complete' }
$text = if ($query.ContainsKey('text')) { $query['text'] } else { '' }
$session = if ($query.ContainsKey('session')) { $query['session'] } else { '' }

Focus-DshWindow

$state = Get-State
if ($state -and $state.origin) {
    $clickUrl = $state.origin.TrimEnd('/') +
        '/api/dsh-native-toast/click?kind=' + [uri]::EscapeDataString($kind) +
        '&text=' + [uri]::EscapeDataString($text) +
        '&session=' + [uri]::EscapeDataString($session)
    try { Invoke-RestMethod -Uri $clickUrl -Method Post -TimeoutSec 5 | Out-Null } catch { }
}
