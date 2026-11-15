<#
.SYNOPSIS
Brings a spoke up to the hub's build: pulls the fork, matches the hub's ComfyUI commit,
installs ComfyUI's pip requirements, then restarts the spoke.

.DESCRIPTION
Run on the hub, from the repo root. A spoke refuses to update or repair itself, so this
is the "redeploy the spoke" step its log messages ask for.

The spoke pulls from origin, so push the hub's commits first.

.EXAMPLE
tools\redeploy-spoke.ps1 -SshHost myspoke -SpokePath D:\SwarmUI -SpokeUrl http://myspoke:7801
#>
param(
    # SSH host (or alias) of the spoke.
    [Parameter(Mandatory = $true)][string]$SshHost,
    # SwarmUI folder on the spoke.
    [Parameter(Mandatory = $true)][string]$SpokePath,
    # Spoke address as written in the hub's backend settings. Omit to skip the restart.
    [string]$SpokeUrl = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$comfyCommit = (git -C "$repo\dlbackend\comfy\ComfyUI" rev-parse HEAD).Trim()
if ($comfyCommit -notmatch '^[0-9a-f]{40}$') { throw 'Could not read the hub ComfyUI commit.' }
if ($SpokePath -match "['`"]") { throw 'SpokePath must not contain quotes.' }
# Swarm demands its own validated frontend, not the one ComfyUI's requirements pin.
# shortcut: assumes the backend's FrontendVersion is the default LatestSwarmValidated; skip the re-pin if that setting changes.
$source = Get-Content -Raw "$repo\src\BuiltinExtensions\ComfyUIBackend\ComfyUISelfStartBackend.cs"
if ($source -notmatch 'SwarmValidatedFrontendVersion = "([0-9.]+)"') { throw 'Could not read the validated frontend version.' }
$frontend = $Matches[1]
# Extensions register generation parameters, and the hub rejects a spoke whose parameter set differs.
# shortcut: only the source commit is matched; a spoke cannot build, so copy src\bin\extensions\<name> from the hub when the spoke lacks that commit's DLL.
$extensions = foreach ($dir in Get-ChildItem "$repo\src\Extensions" -Directory) {
    if ((Test-Path "$($dir.FullName)\.git") -and $dir.Name -match '^[\w.-]+$') { "'$($dir.Name)=$((git -C $dir.FullName rev-parse HEAD).Trim())'" }
}
$extensionList = $extensions -join ','

# Sent base64-encoded: no shell quoting to survive, and unlike stdin it runs multi-line blocks whole.
$remote = @"
`$ErrorActionPreference = 'Continue'
`$ProgressPreference = 'SilentlyContinue'
function Check(`$what) { if (`$LASTEXITCODE -ne 0) { Write-Output "FAILED: `$what"; exit 1 } }
Set-Location '$SpokePath'
`$old = git rev-parse HEAD
git pull --ff-only origin main; Check 'pull the fork'
`$new = git rev-parse HEAD
if (git diff --name-only `$old `$new -- '*.cs' '*.csproj' '*.cshtml' '*.props') {
    New-Item -ItemType File -Force src\bin\must_rebuild | Out-Null
    Write-Output 'C# changed: the spoke will rebuild on restart.'
}
foreach (`$pair in @($extensionList)) {
    `$name, `$want = `$pair -split '='
    `$dir = "src\Extensions\`$name"
    if (-not (Test-Path "`$dir\.git")) { Write-Output "WARNING: extension `$name is not installed on the spoke."; continue }
    if ((git -C `$dir rev-parse HEAD) -eq `$want) { continue }
    git -C `$dir fetch -q origin; Check "fetch extension `$name"
    git -C `$dir checkout -q --detach `$want; Check "check out extension `$name"
    New-Item -ItemType File -Force src\bin\must_rebuild | Out-Null
    Write-Output "Extension `$name moved to the hub's commit."
}
`$comfy = 'dlbackend\comfy\ComfyUI'
git -C `$comfy fetch origin; Check 'fetch ComfyUI'
git -C `$comfy merge --ff-only $comfyCommit; Check 'fast-forward ComfyUI'
# Same choice Swarm makes (GetProbableLibFolderFor): a venv beside main.py wins over the embedded Python.
`$python = "`$comfy\venv\Scripts\python.exe"
if (-not (Test-Path `$python)) { `$python = 'dlbackend\comfy\python_embeded\python.exe' }
& `$python -s -m pip install -q -r "`$comfy\requirements.txt"; Check 'pip install'
& `$python -s -m pip install -q comfyui-frontend-package==$frontend; Check 'pin the frontend'
Write-Output "Spoke files ready: fork `$(git rev-parse --short HEAD), ComfyUI `$(git -C `$comfy rev-parse --short HEAD)."
"@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($remote))
ssh -o BatchMode=yes $SshHost "powershell -NoProfile -EncodedCommand $encoded"
if ($LASTEXITCODE -ne 0) { throw 'Spoke update failed. Nothing was restarted.' }

if (-not $SpokeUrl) {
    Write-Output 'No -SpokeUrl given. Restart the spoke yourself to load the update.'
    return
}
# The spoke only accepts a restart from a controller session carrying the hub's saved header.
$want = $SpokeUrl.TrimEnd('/')
$header = ''
$inBlock = $false
foreach ($line in Get-Content "$repo\Data\Backends.fds") {
    $text = $line.Trim()
    if ($text -like 'Address:*') { $inBlock = ($text.Substring(8).Trim().TrimEnd('/') -eq $want) }
    elseif ($inBlock -and $text -like 'AuthorizationHeader:*') { $header = $text.Substring(20).Trim(); break }
}
if (-not $header -or $header -eq '\x') { throw "No saved authorization header for $want in Data\Backends.fds." }
$headers = @{ Authorization = $header }
$session = Invoke-RestMethod -Method Post -Uri "$want/API/GetNewSession" -Headers $headers -ContentType 'application/json' -Body '{"spokeController":true}'
if (-not $session.session_id) { throw 'The spoke did not grant a session.' }
$body = @{ session_id = $session.session_id } | ConvertTo-Json
$result = Invoke-RestMethod -Method Post -Uri "$want/API/RestartServer" -Headers $headers -ContentType 'application/json' -Body $body
if ($result.error) { throw "Spoke refused the restart: $($result.error)" }
Write-Output 'Spoke restart requested. It reconnects to the hub by itself.'
