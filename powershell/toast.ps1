# Renders one Windows notification-center toast for DeepSeek Harness.
# Invoked by the DSH Host plugin `dsh-native-toast`; can also be run by
# hand to preview text, logo, app id, sound, or duration changes:
#   powershell.exe -NoProfile -File toast.ps1 -Title "任务已完成！" -Body "DeepSeek Harness"
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Title,
    [string]$Body = '',
    [string]$Icon = '',
    [string]$AppId = 'com.deepseek.dsh',
    [ValidateSet('default', 'silent')][string]$Sound = 'default',
    [ValidateSet('short', 'long')][string]$Duration = 'short',
    [string]$Tag = '',
    [string]$Group = 'dsh',
    [string]$Launch = ''
)

$ErrorActionPreference = 'Stop'
$PowerShellFallbackAppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'

function Esc {
    param([AllowNull()][string]$Value)
    if ([string]::IsNullOrEmpty($Value)) { return '' }
    return [System.Security.SecurityElement]::Escape($Value)
}

function Build-ToastXml {
    param([string]$TitleText, [string]$BodyText, [string]$IconPath, [string]$SoundName, [string]$DurationKind, [string]$LaunchUri)

    $lines = New-Object System.Collections.Generic.List[string]
    if ([string]::IsNullOrWhiteSpace($LaunchUri)) {
        $lines.Add('<toast activationType="foreground" duration="' + $DurationKind + '">')
    }
    else {
        # A protocol activation launches the click bridge registered by protocol.ps1.
        $lines.Add('<toast activationType="protocol" launch="' + (Esc $LaunchUri) + '" duration="' + $DurationKind + '">')
    }
    $lines.Add('  <visual>')
    $lines.Add('    <binding template="ToastGeneric">')
    $lines.Add('      <text>' + (Esc $TitleText) + '</text>')
    if (-not [string]::IsNullOrWhiteSpace($BodyText)) {
        $lines.Add('      <text>' + (Esc $BodyText) + '</text>')
    }
    if (-not [string]::IsNullOrWhiteSpace($IconPath) -and (Test-Path -LiteralPath $IconPath -PathType Leaf)) {
        $iconUri = ([uri]('file:///' + ($IconPath -replace '\\', '/'))).AbsoluteUri
        $lines.Add('      <image placement="appLogoOverride" src="' + (Esc $iconUri) + '" />')
    }
    $lines.Add('    </binding>')
    $lines.Add('  </visual>')
    if ($SoundName -eq 'silent') {
        $lines.Add('  <audio silent="true" />')
    }
    else {
        $lines.Add('  <audio src="ms-winsoundevent:Notification.Default" />')
    }
    $lines.Add('</toast>')
    return ($lines -join "`r`n")
}

function Show-WithAppId {
    param([string]$ApplicationId)

    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

    $xmlText = Build-ToastXml -TitleText $Title -BodyText $Body -IconPath $Icon -SoundName $Sound -DurationKind $Duration -LaunchUri $Launch
    $document = New-Object Windows.Data.Xml.Dom.XmlDocument
    $document.LoadXml($xmlText)
    $toast = New-Object Windows.UI.Notifications.ToastNotification $document
    if (-not [string]::IsNullOrWhiteSpace($Tag)) {
        $toast.Tag = $Tag
    }
    if (-not [string]::IsNullOrWhiteSpace($Group)) {
        $toast.Group = $Group
    }
    $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($ApplicationId)
    $notifier.Show($toast)
    Start-Sleep -Milliseconds 250
}

try {
    Show-WithAppId -ApplicationId $AppId
}
catch {
    if ($AppId -eq $PowerShellFallbackAppId) {
        throw
    }
    # An unknown AppUserModelID silently drops the toast, so fall back to the
    # built-in Windows PowerShell registration when the app id is unusable.
    Show-WithAppId -ApplicationId $PowerShellFallbackAppId
}
