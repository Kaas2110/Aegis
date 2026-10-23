param(
    [Parameter(Mandatory=$true)][string]$StateDirectory,
    [Parameter(Mandatory=$true)][string]$OwnerJsonBase64
)
$ErrorActionPreference = 'Stop'
$guardStream = $null
$ownerFile = Join-Path $StateDirectory 'pipeline.lock\owner.json'

function Read-LockOwner {
    try {return [IO.File]::ReadAllText($ownerFile) | ConvertFrom-Json} catch {return $null}
}

function Is-SameOwnerProcess($record) {
    if($null -eq $record -or $null -eq $record.pid) {return $false}
    $candidate = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    if(-not $candidate) {return $false}
    try {
        $start = $candidate.StartTime.ToUniversalTime()
        if($record.processStartTicks) {return $start.Ticks.ToString() -eq [string]$record.processStartTicks}
        # Legacy owners did not record a process identity. A process created
        # after that job began is a reused PID, including after Windows reboot.
        if($record.startedAt) {return $start -le [DateTime]::Parse($record.startedAt).ToUniversalTime()}
    } catch {return $true}
    return $true
}

try {
    # FileShare.None is an OS lock, automatically released when this helper
    # dies. Keep the empty guard file permanently; deleting it is unnecessary.
    $guardPath = Join-Path $StateDirectory 'pipeline.guard'
    try {
        $guardStream = [IO.File]::Open($guardPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch [IO.IOException] {
        if(($_.Exception.HResult -band 0xFFFF) -notin @(32,33)) {throw}
        @{state='blocked';owner=(Read-LockOwner)} | ConvertTo-Json -Depth 6 -Compress | Write-Output
        exit 75
    }
    $previous = Read-LockOwner
    if(Is-SameOwnerProcess $previous) {
        @{state='blocked';owner=$previous} | ConvertTo-Json -Depth 6 -Compress | Write-Output
        exit 75
    }
    $newOwner = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($OwnerJsonBase64)) | ConvertFrom-Json
    $parentProcess = Get-Process -Id $newOwner.pid -ErrorAction Stop
    $newOwner | Add-Member -NotePropertyName processStartTicks -NotePropertyValue ($parentProcess.StartTime.ToUniversalTime().Ticks.ToString()) -Force
    $newOwner | Add-Member -NotePropertyName lockHelperPid -NotePropertyValue $PID -Force
    $ownerDirectory = Split-Path -Parent $ownerFile
    $recovered = Test-Path -LiteralPath $ownerDirectory
    [IO.Directory]::CreateDirectory($ownerDirectory) | Out-Null
    $temporaryOwner = $ownerFile + '.' + $newOwner.runId + '.tmp'
    [IO.File]::WriteAllText($temporaryOwner, ($newOwner | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporaryOwner -Destination $ownerFile -Force
    @{state='acquired';recovered=$recovered;previousRunId=$previous.runId} | ConvertTo-Json -Compress | Write-Output
    [Console]::Out.Flush()
    # EOF also releases the guard after forced termination of the Node parent.
    $null = [Console]::In.ReadLine()
} catch {
    @{state='failed';error='Could not acquire the Windows pipeline lock.'} | ConvertTo-Json -Compress | Write-Output
    exit 1
} finally {
    if($null -ne $guardStream) {$guardStream.Dispose()}
}
