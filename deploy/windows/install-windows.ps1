<#
.SYNOPSIS
    Windows-native installer for ericmjl/agent-autolearn.

.DESCRIPTION
    Replicates the repo's install.sh WITHOUT invoking a POSIX shell. The upstream
    install.sh cannot run as-is on Windows: the `bash` on PATH is WSL's Linux bash
    (it writes to the wrong filesystem), and msys Git Bash passes POSIX paths that
    Windows-python cannot open. This script uses only PowerShell + native uv/python3.

    Prerequisites (verified 2026-09-06 on this host):
      * uv on PATH                      -> uv --version
      * python >= 3.11 on PATH          -> python3 --version
      * Windows Developer Mode ENABLED  -> required so runtime os.symlink works
                                          (Blocker A; no code change needed)
      * Git Bash on PATH (optional)     -> only needed so the plugin can spawn the
                                          #!/bin/sh review wrapper; the plugin
                                          prepeneds "bash" on win32 (Blocker B patch)

    Install from a checkout of the fork branch local-fixes-v2. That branch
    already carries the Windows spawn fixes (Blocker B/C) AND the consolidated
    skills/autolearn layout, so no patch needs applying. The former
    windows-spawn.patch was retired 2026-09-22 - its contents are committed on
    local-fixes-v2.

    If a clone previously had the old patch applied, reset the affected paths:
        cd <path-to-clone>
        git checkout -- plugin/ skills/

    Then run, from the repository root:
        .\deploy\windows\install-windows.ps1 [-RepoDir <path-to-clone>]

.PARAMETER RepoDir
    Path to the cloned opencode-autolearn repo. Defaults to the repository root,
    two levels above this script (deploy\windows\install-windows.ps1).

.PARAMETER SkipPreflight
    Skip the environment preflight checks (use only if you already confirmed them).
#>
[CmdletBinding()]
param(
    [string]$RepoDir = (Join-Path $PSScriptRoot '..' '..'),
    [switch]$SkipPreflight
)

$ErrorActionPreference = 'Stop'
$scriptDir = $PSScriptRoot

# The default points at the repo root relative to deploy\windows\. Normalise it
# so every Join-Path below builds a full path regardless of how the script was
# invoked (relative path, -RepoDir override, or a copied-out location).
if (Test-Path $RepoDir) { $RepoDir = (Resolve-Path $RepoDir).Path }

$pluginDir = Join-Path $env:USERPROFILE '.config\opencode\plugins'
$skillsDir  = Join-Path $env:USERPROFILE '.agents\skills'
$cursorDir  = Join-Path $env:USERPROFILE '.cursor'

function Test-OnPath { param([string]$Cmd) (Get-Command $Cmd -ErrorAction SilentlyContinue) -ne $null }

# ---------------------------------------------------------------------------
# 0. Preflight
# ---------------------------------------------------------------------------
if (-not $SkipPreflight) {
    Write-Host "opencode-autolearn Windows installer" -ForegroundColor Cyan
    Write-Host ("Repo: {0}" -f $RepoDir)
    $ok = $true
    if (-not (Test-Path $RepoDir)) { Write-Warning "RepoDir not found: $RepoDir"; $ok = $false }
    if (-not (Test-OnPath uv))     { Write-Warning "uv not on PATH"; $ok = $false }
    if (-not (Test-OnPath python3)) { Write-Warning "python3 not on PATH"; $ok = $false }
    # Dev Mode registry key
    try {
        $dev = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock' `
                -Name 'AllowDevelopmentWithoutDevLicense' -ErrorAction Stop).AllowDevelopmentWithoutDevLicense
        if ($dev -ne 1) { Write-Warning "Windows Developer Mode not enabled (os.symlink will fail)"; $ok = $false }
    } catch { Write-Warning "Cannot read Developer Mode registry key"; $ok = $false }
    if (-not $ok) { throw "Preflight failed. Fix the items above and re-run." }
    Write-Host "Preflight OK." -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 1. Plugin (v1 shell, v2 shell, patched shared core)
# ---------------------------------------------------------------------------
Write-Host "[1/7] Installing plugin..."
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
foreach ($f in 'autolearn.js', 'autolearn-v2.js', 'autolearn-core.mjs') {
    $src = Join-Path $RepoDir "plugin\$f"
    if (-not (Test-Path $src)) { throw "Missing plugin file: $src" }
    Copy-Item $src $pluginDir -Force
}
Remove-Item (Join-Path $pluginDir 'autolearn-core.js') -Force -ErrorAction SilentlyContinue

# Hidden uv launcher (Windows console-flash fix). Placed in the user script dir
# (~/.local/bin) so it pre-exists before any `uv` spawn at startup. Must match
# HIDE_UV_VBS_CONTENT in plugin/autolearn-core.mjs.
$localBin = Join-Path $env:USERPROFILE '.local\bin'
New-Item -ItemType Directory -Force -Path $localBin | Out-Null
$hideVbs = @'
Set sh = CreateObject("WScript.Shell")
Dim cmdline, i
cmdline = ""
For i = 0 To WScript.Arguments.Count - 1
    cmdline = cmdline & """" & WScript.Arguments(i) & """" & " "
Next
sh.Run Trim(cmdline), 0, False
'@
Set-Content -Path (Join-Path $localBin 'hide-uv.vbs') -Value $hideVbs -Encoding ASCII

# ---------------------------------------------------------------------------
# 2. Cursor adapter (transcript-driven; no hooks)
# ---------------------------------------------------------------------------
# Cursor has no in-process plugin runtime, so the adapter is a local module
# that scans Cursor's transcript files and spawns a one-shot headless reviewer.
# The module + shared core land in ~/.cursor/; --install writes the always-
# applied observer rule and --schedule registers the recurring scan task.
Write-Host "[2/7] Installing Cursor adapter..."
New-Item -ItemType Directory -Force -Path $cursorDir | Out-Null
foreach ($f in 'autolearn-cursor.mjs', 'autolearn-core.mjs', 'autolearn-auth.mjs') {
    $src = Join-Path $RepoDir "plugin\$f"
    if (-not (Test-Path $src)) { throw "Missing plugin file: $src" }
    Copy-Item $src $cursorDir -Force
}
$jsRuntime = if (Test-OnPath node) { 'node' } elseif (Test-OnPath bun) { 'bun' } else { $null }
$cursorDeferred = $false
if ($jsRuntime) {
    & $jsRuntime (Join-Path $cursorDir 'autolearn-cursor.mjs') --install
    & $jsRuntime (Join-Path $cursorDir 'autolearn-cursor.mjs') --schedule
} else {
    # No runtime to write the observer rule / register autostart. The adapter and
    # core copies still land above; only these two steps are deferred, so Verify
    # must not fail on the missing rule (a deferred install is not a broken one).
    $cursorDeferred = $true
    Write-Warning "node/bun not found; run: node ~/.cursor/autolearn-cursor.mjs --install"
}

# ---------------------------------------------------------------------------
# 3. Maintenance schedule (curator + topics; harness-neutral)
# ---------------------------------------------------------------------------
# Registers Windows Task Scheduler jobs. Disable any OpenChamber
# autolearn-curator entry yourself first so the curator never runs twice.
# Proposals scan is covered by curator run — not a separate task.
Write-Host "[3/7] Installing maintenance schedule..."
$scheduleDir = Join-Path $env:USERPROFILE '.autolearn\bin'
New-Item -ItemType Directory -Force -Path $scheduleDir | Out-Null
foreach ($f in 'autolearn-schedule.mjs', 'autolearn-core.mjs', 'autolearn-auth.mjs') {
    $src = Join-Path $RepoDir "plugin\$f"
    if (-not (Test-Path $src)) { throw "Missing plugin file: $src" }
    Copy-Item $src $scheduleDir -Force
}
if ($jsRuntime) {
    & $jsRuntime (Join-Path $scheduleDir 'autolearn-schedule.mjs') --install
} else {
    Write-Warning "node/bun not found; run: node ~/.autolearn/bin/autolearn-schedule.mjs --install"
}

# ---------------------------------------------------------------------------
# 4. Skills
# ---------------------------------------------------------------------------
Write-Host "[4/7] Installing skills..."
New-Item -ItemType Directory -Force -Path $skillsDir | Out-Null
# Upstream consolidated three skills (autolearn-reviewer, autolearn-curator,
# self-improving-agent) into one skills/autolearn skill. Remove the legacy dirs
# this installer owns, then install the consolidated skill. Never touches
# agent-created skills (which live in the persona dir and are symlinked in).
foreach ($s in 'autolearn-reviewer', 'autolearn-curator', 'self-improving-agent', 'autolearn') {
    $legacy = Join-Path $skillsDir $s
    if (Test-Path $legacy) { Remove-Item $legacy -Recurse -Force }
}
$skillSrc = Join-Path $RepoDir 'skills\autolearn'
if (-not (Test-Path $skillSrc)) { throw "Missing skill dir: $skillSrc" }
Copy-Item $skillSrc $skillsDir -Recurse -Force

# ---------------------------------------------------------------------------
# 4. Merge opencode.json (JSONC-tolerant)
# ---------------------------------------------------------------------------
Write-Host "[5/7] Configuring opencode.json..."
& python3 (Join-Path $scriptDir 'merge-opencode.py')
if ($LASTEXITCODE -ne 0) { throw "opencode.json merge failed." }

# ---------------------------------------------------------------------------
# 6. Initialize + bootstrap the registry
# ---------------------------------------------------------------------------
Write-Host "[6/7] Initializing autolearn store..."
$cli = Join-Path $skillsDir 'autolearn\scripts\autolearn.py'
if (-not (Test-Path $cli)) { throw "CLI not found: $cli" }
uv run $cli init
uv run $cli retention score
uv run $cli memory compose

# ---------------------------------------------------------------------------
# 7. Verify
# ---------------------------------------------------------------------------
Write-Host "[7/7] Verifying..."
$ok = $true
foreach ($p in @(
    (Join-Path $pluginDir 'autolearn.js'),
    (Join-Path $pluginDir 'autolearn-v2.js'),
    (Join-Path $pluginDir 'autolearn-core.mjs'),
    (Join-Path $cursorDir 'autolearn-cursor.mjs'),
    (Join-Path $cursorDir 'autolearn-core.mjs'),
    (Join-Path $cursorDir 'autolearn-auth.mjs'),
    (Join-Path $scheduleDir 'autolearn-schedule.mjs'),
    (Join-Path $scheduleDir 'autolearn-core.mjs'),
    (Join-Path $scheduleDir 'autolearn-auth.mjs'),
    (Join-Path $skillsDir 'autolearn\SKILL.md'),
    (Join-Path $skillsDir 'autolearn\scripts\autolearn.py'),
    (Join-Path $skillsDir 'autolearn\scripts\improve.py'),
    (Join-Path $env:USERPROFILE '.autolearn\personas\default\memory.context.md'),
    (Join-Path $env:USERPROFILE '.autolearn\personas\default\memories.jsonl'),
    (Join-Path $env:USERPROFILE '.local\bin\hide-uv.vbs')
)) {
    if (-not (Test-Path $p)) { Write-Warning "MISSING: $p"; $ok = $false }
}
# The observer rule is written by --install (needs node/bun); skip only this
# check when that step was deferred rather than failing the whole install.
$observerRule = Join-Path $cursorDir 'rules\autolearn-observer.mdc'
if ($cursorDeferred) {
    Write-Host "  DEFERRED: $observerRule (no node/bun - run autolearn-cursor.mjs --install)"
} elseif (-not (Test-Path $observerRule)) {
    Write-Warning "MISSING: $observerRule"; $ok = $false
}

Write-Host ""
if ($ok) {
    Write-Host "Done! Autolearn will activate on your next OpenCode, pi, or Cursor session." -ForegroundColor Green
} else {
    Write-Warning "Some files are missing - check the errors above."
    exit 1
}
