param([Parameter(Mandatory=$true)][string]$ConfigPath,[Parameter(Mandatory=$true)][string]$ConfigSha256)
$ErrorActionPreference='Stop'
# Read-only observation: no task enable/start/stop, process termination, or job creation.
if((Get-FileHash -LiteralPath $ConfigPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ConfigSha256){throw 'host_config_pin'}
$config=Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if(@($config.taskNames).Count -gt 64){throw 'task_inventory_bound'}
$started=[DateTime]::UtcNow.ToString('o');$errors=@();$records=@();$tasks=@();$processComplete=$true
# ToolHelp parent census avoids WMI/CIM permission and command-line disclosure.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class AegisReadOnlyParents {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Entry {
  public uint size,usage,pid; public UIntPtr heap; public uint module,threads,parent; public int priority; public uint flags;
  [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string exe;
 }
 [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32FirstW(IntPtr h,ref Entry e);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool Process32NextW(IntPtr h,ref Entry e);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 public static Dictionary<int,int> Read() {
  var h=CreateToolhelp32Snapshot(2,0);if(h==new IntPtr(-1))throw new Exception("snapshot_unavailable");
  try{var e=new Entry();e.size=(uint)Marshal.SizeOf(typeof(Entry));if(!Process32FirstW(h,ref e))throw new Exception("snapshot_empty");
   var d=new Dictionary<int,int>();do{d[(int)e.pid]=(int)e.parent;}while(Process32NextW(h,ref e));return d;
  }finally{CloseHandle(h);}
 }
}
'@
function Get-AegisCompleteProcessCensus {
 param(
  [scriptblock]$ReadParents={ [AegisReadOnlyParents]::Read() },
  [scriptblock]$ReadProcesses={ @(Get-Process -ErrorAction Stop) }
 )
 $began=[DateTime]::UtcNow.ToString('o');$rows=@();$problems=@()
 try{
  $before=& $ReadParents;$inventory=@(& $ReadProcesses)
  if($inventory.Count -gt 4096 -or $before.Count -gt 4096){throw 'process_inventory_bound'}
  $seen=@{}
  foreach($p in $inventory){
   $id=[int]$p.Id
   if($seen.ContainsKey($id) -or -not $before.ContainsKey($id)){throw 'process_parent_inventory_mismatch'}
   $seen[$id]=$true
   $python=([string]$p.ProcessName -match '^python(w|[0-9.]*)?$')
   try{
    $created=$p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
    $rows += [pscustomobject]@{pid=$id;parentPid=[int]$before[$id];creationTime100ns=$created;identityPrecise=$true;isPython=$python}
   }catch{if($python){$problems+='python_identity_unavailable'}}
  }
  $after=& $ReadParents
  if($seen.Count -ne $before.Count -or $after.Count -ne $before.Count){throw 'process_census_changed'}
  foreach($id in $before.Keys){if(-not $after.ContainsKey($id) -or $after[$id] -ne $before[$id]){throw 'process_census_changed'}}
 }catch{$problems+='process_inventory_unavailable_or_changed'}
 [pscustomobject]@{startedAt=$began;completedAt=[DateTime]::UtcNow.ToString('o');complete=($problems.Count -eq 0);processes=$rows;errors=$problems}
}
function Complete-AegisServiceCensus {
 param([object[]]$Admissions,[scriptblock]$Collect={ Get-AegisCompleteProcessCensus })
 # This call is deliberately AFTER every HTTP/helper check, for ALL processes.
 $census=& $Collect
 foreach($check in $Admissions){
  if(-not $census.complete){$check.verified=$false;continue}
  foreach($claim in @($check.chainAfter)){
   $matches=@($census.processes | Where-Object { $_.pid -eq $claim.pid })
   if($matches.Count -ne 1 -or $matches[0].identityPrecise -ne $true -or
      $matches[0].creationTime100ns -ne $claim.creationTime100ns -or
      $matches[0].parentPid -ne $claim.parentPid){$check.verified=$false}
  }
 }
 $census
}
foreach($name in @($config.taskNames)){
 try{
  if([string]::IsNullOrWhiteSpace($name)){throw 'task_name_required'}
  $task=Get-ScheduledTask -TaskName $name -TaskPath '\' -ErrorAction Stop
  $info=Get-ScheduledTaskInfo -InputObject $task -ErrorAction Stop
  $tasks += [pscustomobject]@{name=$name;state=[string]$task.State;enabled=[bool]$task.Settings.Enabled;lastResult=[long]$info.LastTaskResult;lastRunUtc=$info.LastRunTime.ToUniversalTime().ToString('o')}
 }catch{$errors += 'configured_task_unavailable';$tasks += [pscustomobject]@{name=$name;state='Unknown';enabled=$null;lastResult=$null}}
}
$serviceAdmissions=@()
$persistentPolicies=@($config.persistentNonFitServicePolicies | Where-Object {$null -ne $_})
if($persistentPolicies.Count -gt 2){throw 'persistent_service_policy_bound'}
foreach($spec in $persistentPolicies){
 try{
  $helper=Join-Path $PSScriptRoot 'collect-service-admission.ps1'
  if((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant() -ne $config.serviceAdmissionCollectorSha256){throw 'service_collector_source_pin'}
  $result=& $helper -PolicyPath $spec.path -PolicySha256 $spec.sha256
  $serviceAdmissions+=($result | ConvertFrom-Json)
 }catch{$serviceAdmissions+=@{contract='aegis.persistent-service-observation.v1';policySha256=$spec.sha256;verified=$false;receivedAt=[DateTime]::UtcNow.ToString('o');reason='persistent_service_verification_failed'}}
}
$finalCensus=Complete-AegisServiceCensus -Admissions $serviceAdmissions
$records=@($finalCensus.processes);$errors+=@($finalCensus.errors);$processComplete=$finalCensus.complete
[pscustomobject]@{contract='aegis.host-observation.v1';startedAt=$started;observedAt=[DateTime]::UtcNow.ToString('o');complete=($errors.Count -eq 0);processComplete=$processComplete;processes=$records;processCensusKind='post_service_complete_v2';processCensusStartedAt=$finalCensus.startedAt;processCensusCompletedAt=$finalCensus.completedAt;tasks=$tasks;errors=$errors;serviceAdmissions=$serviceAdmissions;taskMutations=0;processMutations=0;nativeFits=0} | ConvertTo-Json -Depth 12 -Compress
