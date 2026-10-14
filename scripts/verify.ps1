# Zhitu - end-to-end verification
#
# Usage (from project root):
#   powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
#
# It launches the real app three times, against a THROWAWAY data directory:
#   phase 1: onboarding wizard -> test connection -> two chat rounds -> quit
#   phase 2: relaunch, confirm settings and conversation survived
#   phase 3: render the window and inspect the real DOM
#
# A local fake AI provider is used, so this is offline and costs nothing.
#
# IMPORTANT: the sandbox directory below exists so that verification can never
# touch the user's real data (%APPDATA%\zhitu). An earlier version of this
# script reused the real directory and wiped the user's saved API key.
#
# This file is intentionally ASCII-only: Windows PowerShell 5.1 reads .ps1
# files using the system ANSI codepage, and non-ASCII text would break parsing.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Some Electron-based terminals (the DSH harness, for one) export
# ELECTRON_RUN_AS_NODE=1. Child Electron processes then start as plain Node and
# the app dies with "Cannot read properties of undefined (reading 'setName')"
# before a single check runs, which shows up as "checks=0/162". Clear it here so
# verification behaves the same no matter which terminal started it.
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# Node writes UTF-8, but PowerShell decodes captured child output using the
# console codepage. On a GBK console (936, the default on Chinese Windows) the
# check marks turn into mojibake and the counting regexes below find 0 checks,
# so the script fails spuriously even though every check passed. Force UTF-8 so
# counting and display behave the same on every console.
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {
  # No interactive console (e.g. a scheduled task); the default decoding applies.
}

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
  Write-Host 'Electron not found. Run: npm install' -ForegroundColor Red
  exit 1
}

# Sandbox: verification data lives here, never in the real userData directory.
$sandbox = Join-Path $env:TEMP ('zhitu-verify-' + [guid]::NewGuid().ToString('N'))
$realData = Join-Path $env:APPDATA 'zhitu'
$realDb = Join-Path $realData 'zhitu.db'
$logFile = Join-Path $sandbox 'logs\app.log'
$reportFile = Join-Path $env:TEMP 'zhitu-e2e-report.txt'
$expectedPhase1 = 163
$expectedPhase2 = 13
$expectedPhase3 = 150
$expectedNoteChecks = 36
$expectedAttachmentChecks = 19

# Fail loudly rather than silently clobbering the user's data.
if ($sandbox -eq $realData) {
  Write-Host 'Refusing to run: sandbox and real data directory are the same.' -ForegroundColor Red
  exit 1
}

function Get-RealDbHash {
  if (-not (Test-Path -LiteralPath $realDb)) { return '(absent)' }
  # Get-FileHash requests restrictive sharing and fails while the real app is open.
  # Read with shared access so verification can confirm the file is unchanged
  # without stopping the user's app or writing to its database.
  $stream = [System.IO.File]::Open($realDb, [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}

$realDbHashBefore = Get-RealDbHash
function Assert-RealDbUnchanged {
  $after = Get-RealDbHash
  if ($after -ne $realDbHashBefore) {
    Write-Host 'FAILED: real user database hash changed during verification.' -ForegroundColor Red
    Write-Host "Before: $realDbHashBefore  After: $after" -ForegroundColor Red
    return $false
  }
  Write-Host 'Real user database hash unchanged.' -ForegroundColor DarkGray
  return $true
}

# Every run owns a new data directory and single-instance lock. Never terminate
# an existing development or user instance merely because its executable matches.

function Clear-Sandbox {
  foreach ($name in @('zhitu.db', 'zhitu.db-wal', 'zhitu.db-shm')) {
    $p = Join-Path $sandbox $name
    if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
  }
}

# Returns @{ Code; Checks; Passed; Failed; Text }
function Invoke-Phase([string]$phase, [string]$title, [string]$entry = 'scripts\e2e.cjs') {
  Write-Host ''
  Write-Host "=== $title ===" -ForegroundColor Cyan
  if (Test-Path $reportFile) { Remove-Item $reportFile -Force -ErrorAction SilentlyContinue }

  $env:ZHITU_E2E_PHASE = $phase
  $env:ZHITU_DATA_DIR = $sandbox
  if ($phase -eq '1') { $env:ZHITU_E2E_IDLE_POLL_MS = '200' }
  $ErrorActionPreference = 'Continue'
  & $electron $entry 2>&1 | Out-Null
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  Remove-Item Env:\ZHITU_DATA_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:\ZHITU_E2E_IDLE_POLL_MS -ErrorAction SilentlyContinue

  # Electron exits with 0 even when it is killed by the single-instance lock,
  # so the exit code alone is not trustworthy. Count the reported checks too.
  $text = ''
  if (Test-Path $reportFile) { $text = Get-Content $reportFile -Raw -Encoding UTF8 }

  $passed = ([regex]::Matches($text, '(?m)^\s+\u2713')).Count
  $failedCount = ([regex]::Matches($text, '(?m)^\s+\u2715')).Count
  $checks = $passed + $failedCount

  if ($text) { Write-Host $text.Trim() }

  return @{ Code = $code; Checks = $checks; Passed = $passed; Failed = $failedCount; Text = $text }
}

Write-Host 'Building...' -ForegroundColor DarkGray
$ErrorActionPreference = 'Continue'
npm run build 2>&1 | Out-Null
$buildCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($buildCode -ne 0) { Write-Host 'Build failed' -ForegroundColor Red; exit 1 }

Write-Host '=== Stream protocol regressions ===' -ForegroundColor Cyan
$streamOutput = & node 'scripts\stream-regression.cjs'
$streamCode = $LASTEXITCODE
$streamText = ($streamOutput | Out-String)
Write-Host $streamText.Trim()
$streamPassed = ([regex]::Matches($streamText, '(?m)^PASS ')).Count
if ($streamCode -ne 0 -or $streamPassed -ne 10) { Write-Host 'Stream checks FAILED'; exit 1 }

Write-Host ''
Write-Host '=== Note adversarial checks ===' -ForegroundColor Cyan
$ErrorActionPreference = 'Continue'
$noteOutput = & node 'scripts\note-adversarial.cjs' 2>&1
$noteCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
$noteText = ($noteOutput | Out-String)
Write-Host $noteText.Trim()
$notePassed = ([regex]::Matches($noteText, '(?m)^\s+\u2713')).Count
$noteFailed = ([regex]::Matches($noteText, '(?m)^\s+\u2715')).Count
if ($noteCode -ne 0 -or $notePassed -ne $expectedNoteChecks -or $noteFailed -gt 0) {
  Write-Host "Note checks FAILED (exit=$noteCode, checks=$notePassed/$expectedNoteChecks, failed=$noteFailed)" -ForegroundColor Red
  Assert-RealDbUnchanged | Out-Null
  exit 1
}

Write-Host ''
Write-Host '=== Attachment foundation checks ===' -ForegroundColor Cyan
$ErrorActionPreference = 'Continue'
$attachmentOutput = & node 'scripts\attachment-adversarial.cjs' 2>&1
$attachmentCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
$attachmentText = ($attachmentOutput | Out-String)
Write-Host $attachmentText.Trim()
$attachmentPassed = ([regex]::Matches($attachmentText, '(?m)^\s+\u2713')).Count
$attachmentFailed = ([regex]::Matches($attachmentText, '(?m)^\s+\u2715')).Count
if ($attachmentCode -ne 0 -or $attachmentPassed -ne $expectedAttachmentChecks -or $attachmentFailed -gt 0) {
  Write-Host "Attachment checks FAILED (exit=$attachmentCode, checks=$attachmentPassed/$expectedAttachmentChecks, failed=$attachmentFailed)" -ForegroundColor Red
  Assert-RealDbUnchanged | Out-Null
  exit 1
}

Write-Host "Sandbox data directory: $sandbox" -ForegroundColor DarkGray
Write-Host 'Clearing sandbox (your real data is untouched)...' -ForegroundColor DarkGray
Clear-Sandbox

$r1 = Invoke-Phase '1' 'Phase 1: first launch, complete the wizard, chat twice'
if ($r1.Code -ne 0 -or $r1.Checks -ne $expectedPhase1 -or $r1.Failed -gt 0) {
  Write-Host "Phase 1 FAILED (exit=$($r1.Code), checks=$($r1.Checks)/$expectedPhase1, failed=$($r1.Failed))" -ForegroundColor Red
  if (Test-Path $logFile) { Get-Content $logFile -Encoding UTF8 -Tail 30 }
  Assert-RealDbUnchanged | Out-Null
  exit 1
}
Write-Host "Phase 1 passed: $($r1.Passed) checks green." -ForegroundColor Green

Start-Sleep -Seconds 2
$r2 = Invoke-Phase '2' 'Phase 2: relaunch, are settings and conversation still here'
if ($r2.Code -ne 0 -or $r2.Checks -ne $expectedPhase2 -or $r2.Failed -gt 0) {
  Write-Host "Phase 2 FAILED (exit=$($r2.Code), checks=$($r2.Checks)/$expectedPhase2, failed=$($r2.Failed))" -ForegroundColor Red
  if (Test-Path $logFile) { Get-Content $logFile -Encoding UTF8 -Tail 30 }
  Assert-RealDbUnchanged | Out-Null
  exit 1
}
Write-Host "Phase 2 passed: $($r2.Passed) checks green." -ForegroundColor Green

# Phase 3 renders the actual window and inspects the real DOM.
# Start from a clean sandbox so the onboarding wizard is what gets rendered.
Clear-Sandbox
$r3 = Invoke-Phase 'ui' 'Phase 3: what does the window actually render' 'scripts\ui-smoke.cjs'

Write-Host ''
if ($r3.Code -eq 0 -and $r3.Checks -eq $expectedPhase3 -and $r3.Failed -eq 0) {
  $total = $streamPassed + $notePassed + $attachmentPassed + $r1.Passed + $r2.Passed + $r3.Passed
  if (-not (Assert-RealDbUnchanged)) { exit 1 }
  Write-Host "[OK] All three phases passed. $total checks green in total." -ForegroundColor Green
  exit 0
}

Write-Host "Phase 3 FAILED (exit=$($r3.Code), checks=$($r3.Checks)/$expectedPhase3, failed=$($r3.Failed))" -ForegroundColor Red
if (Test-Path $logFile) { Get-Content $logFile -Encoding UTF8 -Tail 30 }
Assert-RealDbUnchanged | Out-Null
exit 1
