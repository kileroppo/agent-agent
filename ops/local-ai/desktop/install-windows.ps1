param(
    [Parameter(Mandatory = $true)]
    [string]$MacPrivateIp,
    [string]$ComfyUiWorkingDirectory = "",
    [string]$ComfyUiStartCommandJson = ""
)

$ErrorActionPreference = "Stop"
$BundleRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvRoot = Join-Path $BundleRoot ".venv"
$EnvFile = Join-Path $BundleRoot "desktop-node.env"
$ConfigFile = Join-Path $BundleRoot "desktop-adapters.json"
$PairingFile = Join-Path $BundleRoot "mac-pairing.json"

[System.Net.IPAddress]::Parse($MacPrivateIp) | Out-Null
py -3 -m venv $VenvRoot
$Python = Join-Path $VenvRoot "Scripts\python.exe"
& $Python -m pip install --disable-pip-version-check -r (Join-Path $BundleRoot "requirements.txt")

$Token = & $Python -c "import secrets; print(secrets.token_urlsafe(48))"
$Adapter = Join-Path $BundleRoot "desktop_comfyui_adapter.py"
$Capabilities = @{}
foreach ($Capability in @("image.generate", "image.edit")) {
    $Capabilities[$Capability] = @{
        command = @($Python, $Adapter, "invoke", $Capability)
        healthCommand = @($Python, $Adapter, "health", $Capability)
        resource = "gpu-heavy"
        timeoutSeconds = 3600
    }
}
@{node = "rtx-4070ti-super"; capabilities = $Capabilities} |
    ConvertTo-Json -Depth 8 |
    Set-Content -Encoding UTF8 $ConfigFile

$WorkRoot = Join-Path $BundleRoot "work"
$WorkflowRoot = Join-Path $BundleRoot "workflows"
New-Item -ItemType Directory -Force -Path $WorkRoot, $WorkflowRoot | Out-Null
@(
    "LOCAL_AI_DESKTOP_HOST=0.0.0.0"
    "LOCAL_AI_DESKTOP_PORT=18083"
    "LOCAL_AI_DESKTOP_TOKEN=$Token"
    "LOCAL_AI_DESKTOP_ALLOWED_CIDRS=$MacPrivateIp/32"
    "LOCAL_AI_DESKTOP_ADAPTER_CONFIG=$ConfigFile"
    "LOCAL_AI_DESKTOP_WORK_ROOT=$WorkRoot"
    "COMFYUI_BASE_URL=http://127.0.0.1:8188"
    "COMFYUI_WORKING_DIRECTORY=$ComfyUiWorkingDirectory"
    "COMFYUI_START_COMMAND_JSON=$ComfyUiStartCommandJson"
    "COMFYUI_IDLE_SECONDS=900"
    "COMFYUI_GENERATE_WORKFLOW=$(Join-Path $WorkflowRoot 'flux2-klein-generate-api.json')"
    "COMFYUI_EDIT_WORKFLOW=$(Join-Path $WorkflowRoot 'flux2-klein-edit-api.json')"
) | Set-Content -Encoding UTF8 $EnvFile

@{baseUrl = "http://DESKTOP_PRIVATE_IP:18083"; token = $Token} |
    ConvertTo-Json |
    Set-Content -Encoding UTF8 $PairingFile

$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls $EnvFile /inheritance:r /grant:r "${CurrentUser}:(R,W)" | Out-Null
icacls $PairingFile /inheritance:r /grant:r "${CurrentUser}:(R,W)" | Out-Null

# Only the lightweight control node starts with the signed-in user. ComfyUI is
# deliberately excluded from Task Scheduler and is started on demand by A君.
$TaskName = "RTX4070EnhancementNode"
$TaskPath = "\AgentArmy\"
$Scheduler = New-Object -ComObject "Schedule.Service"
$Scheduler.Connect()
try {
    $Scheduler.GetFolder($TaskPath) | Out-Null
} catch {
    $Scheduler.GetFolder("\").CreateFolder("AgentArmy") | Out-Null
}
$Launcher = Join-Path $BundleRoot "desktop_node_launcher.py"
$TaskArguments = "`"$Launcher`" --env-file `"$EnvFile`""
$TaskAction = New-ScheduledTaskAction -Execute $Python -Argument $TaskArguments
$TaskTrigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
$TaskPrincipal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Limited
$TaskSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask `
    -TaskName $TaskName `
    -TaskPath $TaskPath `
    -Action $TaskAction `
    -Trigger $TaskTrigger `
    -Principal $TaskPrincipal `
    -Settings $TaskSettings `
    -Description "Agent Army 4070 lightweight capability control node; ComfyUI remains on demand." `
    -Force | Out-Null

Write-Host "4070 node runtime installed. Pairing data is in $PairingFile; do not paste its token into chat or logs."
Write-Host "The lightweight node is managed by scheduled task \AgentArmy\RTX4070EnhancementNode. ComfyUI is not started at login; A君 starts it on demand only when COMFYUI_START_COMMAND_JSON is configured."
Write-Host "Manage the visible node task with Get/Start/Stop/Enable/Disable-ScheduledTask -TaskPath '\AgentArmy\' -TaskName 'RTX4070EnhancementNode'."
Write-Host "After ComfyUI and both API workflows are ready, run:"
Write-Host "& '$Python' '$(Join-Path $BundleRoot 'desktop_node_launcher.py')' --env-file '$EnvFile' --check"
