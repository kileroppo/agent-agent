param(
    [Parameter(Mandatory = $true)]
    [string]$MacPrivateIp
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
    "COMFYUI_GENERATE_WORKFLOW=$(Join-Path $WorkflowRoot 'flux2-klein-generate-api.json')"
    "COMFYUI_EDIT_WORKFLOW=$(Join-Path $WorkflowRoot 'flux2-klein-edit-api.json')"
) | Set-Content -Encoding UTF8 $EnvFile

@{baseUrl = "http://DESKTOP_PRIVATE_IP:18083"; token = $Token} |
    ConvertTo-Json |
    Set-Content -Encoding UTF8 $PairingFile

$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls $EnvFile /inheritance:r /grant:r "${CurrentUser}:(R,W)" | Out-Null
icacls $PairingFile /inheritance:r /grant:r "${CurrentUser}:(R,W)" | Out-Null

Write-Host "4070 node runtime installed. Pairing data is in $PairingFile; do not paste its token into chat or logs."
Write-Host "After ComfyUI and both API workflows are ready, run:"
Write-Host "& '$Python' '$(Join-Path $BundleRoot 'desktop_node_launcher.py')' --env-file '$EnvFile' --check"
