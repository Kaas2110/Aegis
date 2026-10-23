param([Parameter(Mandatory=$true)][string]$Plan,[Parameter(Mandatory=$true)][string]$Approval)
$ErrorActionPreference='Stop'
# A dedicated wrapper only. No task registration/start/enable/retry belongs here.
$p=Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json
if($p.contract -ne 'aegis.rich.single-fit-plan.v2' -or $p.nativeFits -ne 1 -or $p.automaticRetry -ne $false -or $p.identity.contract -ne 'aegis.rich-fit-identity.v2' -or $p.head -ne $p.identity.head){throw 'explicit_v2_single_head_plan_required'}
foreach($name in @('jobHelper','pythonExecutable','workerSource','supervisorSource','contractSource','wrapperSource')){
 $item=$p.$name
 if((Get-FileHash -LiteralPath $item.path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.sha256){throw 'wrapper_source_pin'}
}
if((Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $p.wrapperSource.sha256){throw 'wrapper_self_pin'}
. $p.jobHelper.path
$ownership=Enter-AegisOwnedTaskJob
# JobObject is armed before the first child. Its only handle remains open until wrapper OS exit.
$env:AEGIS_CANDIDATE_OWNED_JOB=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($ownership | ConvertTo-Json -Compress)))
& $p.pythonExecutable.path -B (Join-Path $PSScriptRoot 'supervisor.py') --plan $Plan --approval $Approval
exit $LASTEXITCODE
