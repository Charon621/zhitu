param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $true)][string]$ReportPath,
  [string]$FixturePath
)
$ErrorActionPreference = 'Stop'
$exe = (Resolve-Path -LiteralPath $ExePath).Path
# Read the expected version from package.json instead of hardcoding it here:
# a release bump used to break this check for no real reason.
# -Encoding UTF8 matters: Windows PowerShell 5.1 reads a BOM-less file as ANSI,
# and package.json contains Chinese text, which makes ConvertFrom-Json fail.
$projectRoot = Split-Path -Parent $PSScriptRoot
$expectedVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$profileDir = Join-Path $env:TEMP ('zhitu-package-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $profileDir | Out-Null
$previousDataDir = $env:ZHITU_DATA_DIR
$env:ZHITU_DATA_DIR = $profileDir
$ownedProcess = $null
$checks = [System.Collections.Generic.List[string]]::new()
try {
  $ownedProcess = Start-Process -FilePath $exe -PassThru -WindowStyle Hidden
  # The ready marker lives inside the isolated profile now: it carries the local
  # API token, so it is not left in the shared temp directory any more.
  $readyFile = Join-Path $profileDir 'zhitu-ready.json'
  $deadline = (Get-Date).AddSeconds(30)
  $ready = $null
  do {
    Start-Sleep -Milliseconds 250
    if (Test-Path -LiteralPath $readyFile) {
      try { $candidate = Get-Content -LiteralPath $readyFile -Raw | ConvertFrom-Json
        if ($candidate.pid -eq $ownedProcess.Id) { $ready = $candidate }
      } catch { }
    }
  } until ($ready -or (Get-Date) -gt $deadline -or $ownedProcess.HasExited)
  if (-not $ready) { throw 'Packaged application did not start.' }
  $checks.Add('PASS packaged executable starts with its own process')
  $base = 'http://127.0.0.1:' + $ready.port
  $headers = @{ 'X-Zhitu-Token' = $ready.token }
  $boot = Invoke-RestMethod -Uri ($base + '/bootstrap') -Headers $headers
  if ($boot.version -ne $expectedVersion) { throw ('Unexpected version: ' + $boot.version) }
  $checks.Add("PASS packaged version is $expectedVersion")
  if ([IO.Path]::GetFullPath($boot.dataDir) -ne [IO.Path]::GetFullPath($profileDir)) { throw 'Data isolation failed.' }
  $checks.Add('PASS packaged application uses only its isolated test profile')
  if ($boot.providers.Count -ne 6 -or $boot.settings.onboarded) { throw 'Unexpected onboarding state.' }
  $checks.Add('PASS first-run configuration includes six providers')
  $notes = Invoke-RestMethod -Uri ($base + '/notes') -Headers $headers
  if ($notes.cards.Count -ne 0) { throw 'Unexpected test notes.' }
  $checks.Add('PASS packaged database and notes endpoint are available')
  $blocked = $false
  try { Invoke-RestMethod -Uri ($base + '/notes') | Out-Null } catch { $blocked = [int]$_.Exception.Response.StatusCode -eq 403 }
  if (-not $blocked) { throw 'Unauthenticated request was not blocked.' }
  $checks.Add('PASS local API rejects unauthenticated requests')
  $library = Invoke-RestMethod -Uri ($base + '/library') -Headers $headers
  if ($library.items.Count -ne 0) { throw 'Unexpected library items.' }
  $checks.Add('PASS packaged library endpoint and migrated schema are available')
  $history = Invoke-RestMethod -Uri ($base + '/sessions/history?q=old&state=archived&offset=0&limit=25') -Headers $headers
  if ($history.total -ne 0 -or $history.limit -ne 25) { throw 'Packaged complete history API is unavailable.' }
  $checks.Add('PASS packaged complete history supports filtered pagination')
  if ($FixturePath) {
    $fixture = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $FixturePath).Path)
    $boundary = 'zhitu-fixture-boundary'
    $prefix = [Text.Encoding]::UTF8.GetBytes("--$boundary`r`nContent-Disposition: form-data; name=`"file`"; filename=`"synthetic-book.epub`"`r`nContent-Type: application/epub+zip`r`n`r`n")
    $suffix = [Text.Encoding]::UTF8.GetBytes("`r`n--$boundary--`r`n")
    $body = New-Object byte[] ($prefix.Length + $fixture.Length + $suffix.Length)
    [Array]::Copy($prefix, 0, $body, 0, $prefix.Length)
    [Array]::Copy($fixture, 0, $body, $prefix.Length, $fixture.Length)
    [Array]::Copy($suffix, 0, $body, $prefix.Length + $fixture.Length, $suffix.Length)
    $uploaded = Invoke-RestMethod -Uri ($base + '/attachments') -Method Post -Headers $headers -ContentType ('multipart/form-data; boundary=' + $boundary) -Body $body
    $deadline = (Get-Date).AddSeconds(30)
    do {
      Start-Sleep -Milliseconds 200
      $attachment = (Invoke-RestMethod -Uri ($base + '/attachments/' + $uploaded.attachment.id) -Headers $headers).attachment
    } until ($attachment.extract_status -ne 'pending' -or (Get-Date) -gt $deadline)
    if ($attachment.extract_status -ne 'ok') { throw ('Packaged EPUB extraction failed: ' + $attachment.extract_error) }
    $chunks = (Invoke-RestMethod -Uri ($base + '/attachments/' + $uploaded.attachment.id + '/chunks') -Headers $headers).chunks
    if ($chunks.Count -ne 2 -or $chunks[0].page -ne 1 -or $chunks[1].page -ne 2) { throw 'Packaged EPUB reading order failed.' }
    $checks.Add('PASS packaged EPUB worker reads both chapters in spine order')
    $plan = Invoke-RestMethod -Uri ($base + '/library/' + $uploaded.attachment.id + '/plan') -Method Post -Headers $headers -ContentType 'application/json' -Body '{"mode":"book","startPage":1,"endPage":2}'
    if ($plan.plan.segments -ne 2) { throw 'Packaged analysis plan is incomplete.' }
    $checks.Add('PASS packaged book analysis plan covers the complete test book')
  }
  $backup = Invoke-RestMethod -Uri ($base + '/exports/all') -Headers $headers
  $backupJson = [Text.Encoding]::UTF8.GetBytes(($backup | ConvertTo-Json -Depth 100))
  $preview = Invoke-RestMethod -Uri ($base + '/backups/preview') -Headers $headers -Method Post -ContentType 'application/json; charset=utf-8' -Body $backupJson
  if ($preview.preview.sessions -ne $backup.sessions.Count) { throw 'Packaged backup preview failed.' }
  $checks.Add('PASS packaged backup validates its own exported learning data')
  $restored = Invoke-RestMethod -Uri ($base + '/backups/restore') -Headers $headers -Method Post -ContentType 'application/json; charset=utf-8' -Body $backupJson
  if (-not (Test-Path -LiteralPath $restored.snapshotPath)) { throw 'Packaged restore snapshot missing.' }
  $checks.Add('PASS packaged backup restoration creates a complete pre-restore snapshot')
  $checks | Set-Content -LiteralPath $ReportPath -Encoding UTF8
  $checks | Write-Output
} finally {
  $env:ZHITU_DATA_DIR = $previousDataDir
  if ($ownedProcess -and -not $ownedProcess.HasExited) {
    $ownedProcess.CloseMainWindow() | Out-Null
    if (-not $ownedProcess.WaitForExit(5000)) { Stop-Process -Id $ownedProcess.Id -Force }
  }
  # Electron spawns renderer and GPU child processes. Closing only the main
  # process can leave children alive holding release\zhitu.exe, which makes the
  # next copy fail with "file is being used by another process". Kill the whole
  # tree, scoped to the PID this script started.
  #
  # The process normally exits on its own first, and taskkill then reports
  # "not found" on stderr. That is the expected path, so it must not abort the
  # finally block and leave the temp profile behind.
  if ($ownedProcess) {
    try {
      & taskkill /PID $ownedProcess.Id /T /F *> $null
    } catch {
      Write-Verbose "Process tree already gone: $($ownedProcess.Id)"
    }
  }
  $resolvedProfile = [IO.Path]::GetFullPath($profileDir)
  $allowedTemp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
  if (-not $resolvedProfile.StartsWith($allowedTemp, [StringComparison]::OrdinalIgnoreCase) -or
    (Split-Path $resolvedProfile -Leaf) -notlike 'zhitu-package-test-*') { throw 'Refusing unsafe profile cleanup.' }
  Remove-Item -LiteralPath $resolvedProfile -Recurse -Force
}
