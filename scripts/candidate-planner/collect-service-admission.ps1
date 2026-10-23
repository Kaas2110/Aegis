param([Parameter(Mandatory=$true)][string]$PolicyPath,[Parameter(Mandatory=$true)][string]$PolicySha256)
$ErrorActionPreference='Stop'
# Called only by the pinned local observer. Never output exception text, argv, env or headers.
$started=[DateTime]::UtcNow.ToString('o')
$phase='policy'
function Hash-Local([string]$path){
 if($path -notmatch '^[A-Za-z]:[\\/]'){throw 'local_drive_pin_required'}
 $item=Get-Item -LiteralPath $path -Force
 if($item.PSIsContainer -or $item.Length -gt 67108864){throw 'local_pin_bound'}
 $cursor=$item
 while($null -ne $cursor){if($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'reparse_rejected'};$parent=[IO.Path]::GetDirectoryName($cursor.FullName);if([string]::IsNullOrEmpty($parent) -or $parent -eq $cursor.FullName){break};$cursor=Get-Item -LiteralPath $parent -Force}
 return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}
function Require-Pin($spec){if($spec.sha256 -notmatch '^[a-f0-9]{64}$' -or (Hash-Local $spec.path) -ne $spec.sha256){throw 'source_pin_changed'}}
function Same-Path([string]$a,[string]$b){return [IO.Path]::GetFullPath($a).Equals([IO.Path]::GetFullPath($b),[StringComparison]::OrdinalIgnoreCase)}
try{
 if((Hash-Local $PolicyPath) -ne $PolicySha256){throw 'policy_pin'}
 $p=Get-Content -LiteralPath $PolicyPath -Raw | ConvertFrom-Json
 if($p.contract -ne 'aegis.persistent-nonfit-service-policy.v1' -or $p.approved -isnot [bool] -or $p.active -isnot [bool] -or $p.approved -ne $true -or $p.active -ne $true -or $p.approvedBy -ne 'root' -or [DateTimeOffset]::Parse($p.approvedAt) -gt [DateTimeOffset]::UtcNow){throw 'policy_unapproved'}
 if($p.role -ne 'non_fit_service' -or $p.publicPromotion -ne $false -or $p.automaticTraining -ne $false){throw 'scope'}
 if($p.endpoint.host -ne '127.0.0.1' -or $p.endpoint.protocol -ne 'http:' -or $p.endpoint.path -ne '/diagnostics/training-admission' -or $p.endpoint.port -lt 1 -or $p.endpoint.port -gt 65535 -or ($p.endpoint.port -isnot [int] -and $p.endpoint.port -isnot [long])){throw 'fixed_endpoint'}
 if($p.credential.kind -ne 'environment' -or $p.credential.name -ne 'ML_SERVICE_TOKEN' -or $p.runtimeIdentity.section -ne 'ml'){throw 'fixed_credential_identity'}
 if(@($p.processChain).Count -lt 1 -or @($p.processChain).Count -gt 4 -or @($p.configurationPins).Count -lt 1 -or @($p.configurationPins).Count -gt 16 -or @($p.sourcePins).Count -lt 2 -or @($p.sourcePins).Count -gt 16){throw 'policy_bounds'}
 if(@($p.privateConfigurationPins).Count -lt 1 -or @($p.privateConfigurationPins).Count -gt 4){throw 'private_config_pins_required'}
 foreach($member in @($p.processChain)){if($member.observedExecutablePath -notmatch '^[A-Za-z]:[\\/]' -or $member.argumentsSha256 -notmatch '^[a-f0-9]{64}$' -or @($member.arguments).Count -lt 1 -or @($member.arguments).Count -gt 32){throw 'process_descriptor'}}
 Require-Pin $p.collectorSource
 if([IO.Path]::GetFullPath($p.collectorSource.path) -ne [IO.Path]::GetFullPath($PSCommandPath)){throw 'collector_identity'}
 $allPins=@($p.configurationPins)+@($p.privateConfigurationPins)+@($p.sourcePins)+@($p.processChain | ForEach-Object {$_.executable})
 foreach($spec in $allPins){Require-Pin $spec}
 Add-Type -AssemblyName System.Net.Http
 if(-not ('AegisServiceArgv' -as [type])){Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AegisServiceArgv {
 [DllImport("shell32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CommandLineToArgvW(string s,out int n);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);
 public static string[] Parse(string s) { int n;var p=CommandLineToArgvW(s,out n);if(p==IntPtr.Zero||n>40)throw new Exception("argv_unavailable");try{var a=new string[n];for(int i=0;i<n;i++)a[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,i*IntPtr.Size));return a;}finally{LocalFree(p);} }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFileW(string name,uint access,uint share,IntPtr security,uint mode,uint flags,IntPtr template);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr h,System.Text.StringBuilder buffer,uint chars,uint flags);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 public static string FinalPath(string path) {
  IntPtr h=CreateFileW(path,0,7,IntPtr.Zero,3,0,IntPtr.Zero);if(h==new IntPtr(-1))throw new Exception("canonical_file_unavailable");
  try{var b=new System.Text.StringBuilder(4096);uint n=GetFinalPathNameByHandleW(h,b,4096,0);if(n==0||n>=4096)throw new Exception("canonical_file_bound");string p=b.ToString();if(p.StartsWith("\\\\?\\"))p=p.Substring(4);if(p.Length<3||p[1]!=':')throw new Exception("local_drive_required");return p;}finally{CloseHandle(h);}
 }
}
'@
 }
 function Read-Registry {
  $script:phase='registry'
  $hash=Hash-Local $p.runtimeIdentity.path;$r=Get-Content -LiteralPath $p.runtimeIdentity.path -Raw | ConvertFrom-Json
  if((@($r.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'api,ml' -or (@($r.ml.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'executable,pid,startTicks'){throw 'registry_shape'}
  if(($r.ml.pid -isnot [int] -and $r.ml.pid -isnot [long]) -or $r.ml.pid -le 0 -or $r.ml.pid -gt 2147483647 -or $r.ml.startTicks -isnot [string] -or [string]$r.ml.startTicks -notmatch '^\d{18}$' -or -not (Same-Path $r.ml.executable $p.processChain[0].observedExecutablePath)){throw 'registry_semantics'}
  return @{hash=$hash;pid=[int]$r.ml.pid;created=([long]::Parse([string]$r.ml.startTicks)-504911232000000000L).ToString()}
 }
 function Read-Chain($registry){
  $script:phase='listener'
  try{$listeners=@(Get-NetTCPConnection -LocalPort $p.endpoint.port -State Listen -ErrorAction Stop)}catch{$script:phase='listener_query_failed';throw}
  if($listeners.Count -ne 1){$script:phase='listener_not_unique';throw 'unique_loopback_listener_required'}
  if($listeners[0].LocalAddress -ne '127.0.0.1'){$script:phase='listener_not_loopback';throw 'unique_loopback_listener_required'}
  $currentId=[int]$listeners[0].OwningProcess;$reverse=@()
  for($i=@($p.processChain).Count-1;$i -ge 0;$i--){
   $script:phase='process_identity'
   $expected=$p.processChain[$i];$processRecord=Get-Process -Id $currentId -ErrorAction Stop
   $created=$processRecord.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
   if(-not (Same-Path $processRecord.Path $expected.observedExecutablePath) -or -not (Same-Path ([AegisServiceArgv]::FinalPath($processRecord.Path)) $expected.executable.path)){throw 'process_executable'}
   $script:phase='process_command_query';$metadata=Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId='+$currentId) -ErrorAction Stop
   if($null -eq $metadata -or [string]::IsNullOrEmpty($metadata.CommandLine)){throw 'process_command_unavailable'}
   $script:phase='process_argv';$argv=[AegisServiceArgv]::Parse($metadata.CommandLine)
   if($argv.Count -ne @($expected.arguments).Count+1 -or (-not (Same-Path $argv[0] $expected.observedExecutablePath) -and -not (Same-Path $argv[0] $p.processChain[0].observedExecutablePath))){throw 'process_argv'}
   for($j=0;$j -lt @($expected.arguments).Count;$j++){if($argv[$j+1] -cne $expected.arguments[$j]){throw 'process_argv'}}
   # Only the reviewed argument digest is emitted after exact comparison.
   $reverse+=@{pid=$currentId;creationTime100ns=$created;parentPid=[int]$metadata.ParentProcessId;executablePath=[string]$expected.executable.path;observedExecutablePath=[string]$expected.observedExecutablePath;canonicalExecutableVerified=$true;executableSha256=Hash-Local $expected.executable.path;argumentsSha256=[string]$expected.argumentsSha256}
   $currentId=[int]$metadata.ParentProcessId
  }
  [array]::Reverse($reverse)
  $script:phase='registry_root_identity';if($reverse[0].pid -ne $registry.pid -or $reverse[0].creationTime100ns -ne $registry.created){throw 'registry_root_identity'}
  for($i=1;$i -lt $reverse.Count;$i++){if($reverse[$i].parentPid -ne $reverse[$i-1].pid -or [long]$reverse[$i].creationTime100ns -lt [long]$reverse[$i-1].creationTime100ns){throw 'lineage'}}
  return ,$reverse
 }
 $phase='identity_before';$before=Read-Registry;$chainBefore=Read-Chain $before
 $phase='authentication'
 $token=[Environment]::GetEnvironmentVariable('ML_SERVICE_TOKEN','Process')
 if([string]::IsNullOrWhiteSpace($token) -or $token.Length -gt 4096 -or $token.Contains("`r") -or $token.Contains("`n")){throw 'credential_unavailable'}
 $endpoint='http://127.0.0.1:'+([int]$p.endpoint.port)+'/diagnostics/training-admission'
 $handler=New-Object System.Net.Http.HttpClientHandler;$handler.UseProxy=$false;$handler.AllowAutoRedirect=$false
 $client=New-Object System.Net.Http.HttpClient($handler);$client.Timeout=[TimeSpan]::FromSeconds(3);$client.MaxResponseContentBufferSize=16384
 try{
  $u=$client.GetAsync($endpoint).GetAwaiter().GetResult();$unauth=[int]$u.StatusCode;$u.Dispose()
  if($unauth -ne 401){throw 'authentication_not_enforced'}
  $request=New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get,$endpoint)
  [void]$request.Headers.TryAddWithoutValidation('X-ML-Token',$token)
  try{$response=$client.SendAsync($request).GetAwaiter().GetResult();$auth=[int]$response.StatusCode;$body=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult()}finally{$request.Dispose()}
  if($auth -ne 200 -or $body.Length -gt 16384){throw 'admission_unavailable'}
  $phase='response';$admission=$body | ConvertFrom-Json
  if((@($admission.PSObject.Properties.Name | Sort-Object) -join ',') -ne 'contract,enabled,guardedPaths,reason,scope,sourceSha256'){throw 'admission_shape'}
  foreach($field in @('contract','enabled','guardedPaths','reason','scope','sourceSha256')){if([regex]::Matches($body,('"'+$field+'"\s*:')).Count -ne 1){throw 'duplicate_admission_key'}}
  if($admission.contract -ne 'legacy_http_training_admission.v1' -or $admission.enabled -isnot [bool] -or $admission.enabled -ne $false -or $admission.reason -notin @('disabled_by_default','disabled_explicitly') -or $admission.scope -ne 'legacy_http_training_routes_only' -or @($admission.guardedPaths).Count -ne 2 -or (@($admission.guardedPaths | Sort-Object) -join ',') -ne '/ml/train,/train' -or $admission.sourceSha256 -ne $p.admissionSourceSha256){throw 'training_not_closed'}
  $safeResponse=@{contract='legacy_http_training_admission.v1';enabled=$false;reason=[string]$admission.reason;scope='legacy_http_training_routes_only';guardedPaths=@('/ml/train','/train');sourceSha256=[string]$p.admissionSourceSha256}
 }finally{$token=$null;$body=$null;if($null -ne $response){$response.Dispose()};$client.Dispose();$handler.Dispose()}
 $phase='identity_after';$after=Read-Registry;$chainAfter=Read-Chain $after
 foreach($spec in $allPins){Require-Pin $spec}
 if($before.hash -ne $after.hash -or (ConvertTo-Json -InputObject $chainBefore -Depth 6 -Compress) -ne (ConvertTo-Json -InputObject $chainAfter -Depth 6 -Compress)){throw 'service_rotated_during_request'}
 @{contract='aegis.persistent-service-observation.v1';policySha256=$PolicySha256;verified=$true;startedAt=$started;receivedAt=[DateTime]::UtcNow.ToString('o');endpoint=$endpoint;unauthenticatedStatus=$unauth;authenticatedStatus=$auth;response=$safeResponse;chainBefore=$chainBefore;chainAfter=$chainAfter;listenerPid=$chainAfter[-1].pid;registryBeforeSha256=$before.hash;registryAfterSha256=$after.hash} | ConvertTo-Json -Depth 10 -Compress
}catch{
 @{contract='aegis.persistent-service-observation.v1';policySha256=$PolicySha256;verified=$false;startedAt=$started;receivedAt=[DateTime]::UtcNow.ToString('o');reason='persistent_service_verification_failed';phase=$phase} | ConvertTo-Json -Compress
 return
}
