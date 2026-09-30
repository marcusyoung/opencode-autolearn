/**
 * Autolearn — harness-neutral OS scheduler for maintenance jobs.
 *
 * Modes:
 *   --install / --schedule              register Windows Task Scheduler jobs
 *                                       (or print crontab lines on POSIX)
 *   --remove / --schedule --remove      unregister those jobs
 *   --run curator|topics                invoke one job (what schtasks / cron call)
 *
 * Jobs (Windows, local machine time):
 *   AutoLearnCurator      daily 13:00 — headless harness print/run with curator.md
 *   AutoLearnTopicsScan   daily 12:15 — `uv run … topics scan`
 *
 * Proposals scan is intentionally NOT scheduled: `curator run` (invoked by the
 * curator agent) already embeds proposer.scan → verify → promote.
 *
 * Windows launches go through a wait-capable WindowStyle-0 VBS wrapper so the
 * Task Scheduler process stays hidden and still waits for completion.
 *
 * Environment: AUTOLEARN_HOME, AUTOLEARN_DISABLED (as core), plus:
 *   AUTOLEARN_CURATOR_BIN   - explicit curator binary (agent|pi|opencode|opencode2)
 *   AUTOLEARN_CURSOR_AGENT  - alias for AUTOLEARN_CURATOR_BIN (Cursor installs)
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  writeFileSync,
} from "fs"
import { homedir } from "os"
import { basename, dirname, join, resolve } from "path"
import { fileURLToPath } from "url"
import { spawnSync } from "child_process"
import * as core from "./autolearn-core.mjs"

export const SCHEDULE_DIR = join(core.AL_HOME, "bin")
export const MODULE_INSTALL_NAME = "autolearn-schedule.mjs"
export const CORE_INSTALL_NAME = "autolearn-core.mjs"

export const CURATOR_TASK = "AutoLearnCurator"
export const TOPICS_TASK = "AutoLearnTopicsScan"
export const CURATOR_TIME = "13:00"
export const TOPICS_TIME = "12:15"

export const CURATOR_PROMPT =
  "Load the autolearn skill and follow references/curator.md to run the curator."

/** Like hide-uv.vbs but waits and propagates the child exit code. */
export const HIDE_RUN_WAIT_VBS = join(
  process.env.USERPROFILE || homedir(),
  ".local",
  "bin",
  "hide-run-wait.vbs",
)
export const HIDE_RUN_WAIT_VBS_CONTENT = `Set sh = CreateObject("WScript.Shell")
Dim cmdline, i, rc
cmdline = ""
For i = 0 To WScript.Arguments.Count - 1
    cmdline = cmdline & """" & WScript.Arguments(i) & """" & " "
Next
rc = sh.Run(Trim(cmdline), 0, True)
WScript.Quit rc
`

function resolveExecutable(bin) {
  const ext = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""]
  const names = ext.includes("") && ext.length > 1 && !/\.(exe|cmd|bat)$/i.test(bin)
    ? ext.map(suffix => bin + suffix)
    : [bin]
  const pathEnv = process.env.PATH || ""
  const separator = process.platform === "win32" ? ";" : ":"
  const hasPath = bin.includes("/") || bin.includes("\\")
  const directories = hasPath ? [""] : pathEnv.split(separator)
  for (const directory of directories) {
    for (const name of names) {
      const candidate = directory ? join(directory, name) : name
      try {
        if (existsSync(candidate)) return resolve(candidate)
      } catch {}
    }
  }
  return null
}

function modulePath() {
  return fileURLToPath(import.meta.url)
}

function installedModulePath() {
  return join(SCHEDULE_DIR, MODULE_INSTALL_NAME)
}

function ensureHideLaunchers() {
  if (process.platform !== "win32") return
  const bin = join(process.env.USERPROFILE || homedir(), ".local", "bin")
  try {
    mkdirSync(bin, { recursive: true })
    writeFileSync(core.HIDE_UV_VBS, core.HIDE_UV_VBS_CONTENT)
    writeFileSync(HIDE_RUN_WAIT_VBS, HIDE_RUN_WAIT_VBS_CONTENT)
  } catch (err) {
    core.dbg("schedule: hide launcher write failed", err.message)
  }
}

function ensureInstalledCopy() {
  mkdirSync(SCHEDULE_DIR, { recursive: true })
  const here = modulePath()
  const coreHere = join(dirname(here), CORE_INSTALL_NAME)
  const destMod = installedModulePath()
  const destCore = join(SCHEDULE_DIR, CORE_INSTALL_NAME)
  try {
    if (resolve(here) !== resolve(destMod) || !existsSync(destMod)) {
      copyFileSync(here, destMod)
    }
    if (existsSync(coreHere) && (resolve(coreHere) !== resolve(destCore) || !existsSync(destCore))) {
      copyFileSync(coreHere, destCore)
    }
  } catch (err) {
    core.dbg("schedule: install copy failed", err.message)
  }
}

/**
 * Resolve which harness runs the curator prompt.
 * Preference: AUTOLEARN_CURATOR_BIN / AUTOLEARN_CURSOR_AGENT, else first of
 * agent → pi → opencode2 → opencode found on PATH (via core.harnessBinEnv).
 * Returns argv for spawn, or null if nothing compatible is installed.
 */
export function resolveCuratorArgv() {
  const override = process.env.AUTOLEARN_CURATOR_BIN || process.env.AUTOLEARN_CURSOR_AGENT || ""
  let bin = override.trim()
  if (bin) {
    bin = resolveExecutable(bin)
  } else {
    const env = core.harnessBinEnv("agent", ["pi", "opencode2", "opencode"])
    bin = env.AUTOLEARN_HARNESS_BIN ? resolveExecutable(env.AUTOLEARN_HARNESS_BIN) : null
  }
  if (!bin) return null

  const base = basename(bin).replace(/\.(cmd|exe|bat)$/i, "").toLowerCase()
  if (base === "agent" || base === "cursor-agent") {
    return [bin, "-p", "--force", CURATOR_PROMPT]
  }
  if (base === "pi") {
    return [bin, "-p", "--no-session", "-na", CURATOR_PROMPT]
  }
  if (base === "opencode" || base === "opencode2") {
    // OpenCode v1/v2: one-shot run with the curator prompt (no attached file).
    return [bin, "run", CURATOR_PROMPT, "--title", "autolearn curator"]
  }
  return null
}

/**
 * Write a .cmd trampoline and register it under Task Scheduler via
 * hide-run-wait.vbs as the *root* process. PowerShell/node as the schtasks
 * action still allocate a visible console host even with -WindowStyle Hidden;
 * wscript (Windows subsystem) + WindowStyle 0 does not.
 */
function writeJobLauncher(job, curatorBin = "") {
  mkdirSync(SCHEDULE_DIR, { recursive: true })
  const cmdPath = join(SCHEDULE_DIR, `autolearn-job-${job}.cmd`)
  const mod = installedModulePath()
  const node = process.execPath
  const lines = ["@echo off"]
  if (job === "curator" && curatorBin) {
    lines.push(`set "AUTOLEARN_CURATOR_BIN=${curatorBin}"`)
  }
  // Quote node + module; %* unused. Propagate exit code to Task Scheduler.
  lines.push(`"${node}" "${mod}" --run ${job}`)
  lines.push("exit /b %ERRORLEVEL%")
  lines.push("")
  writeFileSync(cmdPath, lines.join("\r\n"))
  // Drop the old PowerShell trampoline if present from earlier installs.
  try { unlinkSync(join(SCHEDULE_DIR, `autolearn-job-${job}.ps1`)) } catch {}
  return cmdPath
}

function schtasksCreate(taskName, time, cmdPath) {
  ensureHideLaunchers()
  // Register via PowerShell so we can clear the schtasks.exe defaults that
  // block/stop runs on battery (ThinkPads otherwise silently skip the daily
  // trigger). Keep wscript as the Exec root — no console host.
  const arg = `//Nologo "${HIDE_RUN_WAIT_VBS}" "${cmdPath}"`
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    `$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '${arg.replace(/'/g, "''")}'`,
    `$trigger = New-ScheduledTaskTrigger -Daily -At '${time}'`,
    "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 4)",
    `Unregister-ScheduledTask -TaskName '${taskName.replace(/'/g, "''")}' -Confirm:$false -ErrorAction SilentlyContinue`,
    `Register-ScheduledTask -TaskName '${taskName.replace(/'/g, "''")}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
    "Write-Output OK",
  ].join("; ")
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
    { encoding: "utf8" },
  )
  return { ok: r.status === 0 && /OK/.test(r.stdout || ""), stdout: r.stdout || "", stderr: r.stderr || "" }
}

function schtasksDelete(taskName) {
  const r = spawnSync("schtasks", ["/Delete", "/TN", taskName, "/F"], { encoding: "utf8" })
  const out = `${r.stdout || ""}\n${r.stderr || ""}`
  const missing = /ERROR:\s*The system cannot find|cannot find the file|does not exist/i.test(out)
  return {
    ok: r.status === 0 || missing,
    missing,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
  }
}

export function crontabLines(curatorBin = "") {
  const mod = modulePath()
  const node = process.execPath
  const curatorEnv = curatorBin
    ? `AUTOLEARN_CURATOR_BIN='${curatorBin.replace(/'/g, "'\\''")}' `
    : ""
  return [
    `15 12 * * * "${node}" "${mod}" --run topics >/dev/null 2>&1`,
    `0 13 * * * ${curatorEnv}"${node}" "${mod}" --run curator >/dev/null 2>&1`,
  ].join("\n")
}

/**
 * Register (or print) the maintenance schedule.
 * Windows: two daily Task Scheduler tasks at local machine time.
 * POSIX: return crontab lines for the user to install.
 */
export function installSchedule() {
  ensureHideLaunchers()
  if (process.platform !== "win32") {
    const curator = resolveCuratorArgv()
    if (!curator) {
      return {
        ok: false,
        crontab: crontabLines(),
        stderr: "No curator harness found (agent/pi/opencode2/opencode). Set AUTOLEARN_CURATOR_BIN before installing crontab lines that run --run curator.",
      }
    }
    return {
      ok: true,
      crontab: crontabLines(curator[0]),
      note: "Times assume a Europe/London (or UTC+0/+1) host matching the prior OpenChamber slot.",
      curatorBin: curator[0],
    }
  }

  const curator = resolveCuratorArgv()
  if (!curator) {
    return {
      ok: false,
      stderr: "No curator harness found (agent/pi/opencode2/opencode). Install one or set AUTOLEARN_CURATOR_BIN, then re-run --install.",
    }
  }

  ensureInstalledCopy()
  const curatorCmd = writeJobLauncher("curator", curator[0])
  const topicsCmd = writeJobLauncher("topics")
  const c = schtasksCreate(CURATOR_TASK, CURATOR_TIME, curatorCmd)
  const t = schtasksCreate(TOPICS_TASK, TOPICS_TIME, topicsCmd)
  return {
    ok: c.ok && t.ok,
    tasks: [CURATOR_TASK, TOPICS_TASK],
    curatorBin: curator[0],
    stderr: [c.stderr, t.stderr, c.stdout, t.stdout].filter(Boolean).join("\n"),
  }
}

export function removeSchedule() {
  if (process.platform !== "win32") {
    return { ok: true, note: "Remove the autolearn crontab lines manually." }
  }
  const c = schtasksDelete(CURATOR_TASK)
  const t = schtasksDelete(TOPICS_TASK)
  const ok = c.ok && t.ok
  return {
    ok,
    tasks: [CURATOR_TASK, TOPICS_TASK],
    stderr: ok ? "" : [c.stderr, t.stderr, c.stdout, t.stdout].filter(Boolean).join("\n"),
  }
}

/**
 * Run one job synchronously. On Windows, wrap via hide-run-wait.vbs so the
 * console stays hidden and the process waits for completion.
 */
export function runJob(job) {
  if (process.env.AUTOLEARN_DISABLED === "1") {
    console.log("autolearn disabled (AUTOLEARN_DISABLED=1); skipping", job)
    return 0
  }
  ensureHideLaunchers()
  core.ensureStore()

  let argv
  if (job === "curator") {
    argv = resolveCuratorArgv()
    if (!argv) {
      console.error("No curator harness found (agent/pi/opencode2/opencode). Set AUTOLEARN_CURATOR_BIN.")
      return 1
    }
  } else if (job === "topics") {
    argv = ["uv", "run", core.AUTOLEARN_CLI, "topics", "scan"]
  } else {
    console.error(`Unknown job: ${job} (expected curator|topics)`)
    return 2
  }

  if (process.platform === "win32") {
    argv = ["wscript.exe", HIDE_RUN_WAIT_VBS, ...argv]
  }

  const r = spawnSync(argv[0], argv.slice(1), {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, AUTOLEARN_REVIEWER: job === "curator" ? "1" : process.env.AUTOLEARN_REVIEWER },
  })
  if (r.error) {
    console.error(`schedule --run ${job} failed:`, r.error.message)
    return 1
  }
  return r.status == null ? 1 : r.status
}

function main(argv) {
  if (argv.includes("--run")) {
    const i = argv.indexOf("--run")
    const job = argv[i + 1]
    if (!job || job.startsWith("-")) {
      console.error("Usage: autolearn-schedule.mjs --run curator|topics")
      process.exit(2)
    }
    process.exit(runJob(job))
  }

  if (argv.includes("--remove") || (argv.includes("--schedule") && argv.includes("--remove"))) {
    const r = removeSchedule()
    console.log(r.ok ? `Removed schedule tasks: ${(r.tasks || []).join(", ") || "ok"}` : `Remove failed: ${r.stderr || r.note || "unknown"}`)
    if (r.note) console.log(r.note)
    if (!r.ok) process.exit(1)
    return
  }

  if (argv.includes("--install") || argv.includes("--schedule")) {
    const r = installSchedule()
    if (r.crontab) {
      console.log("Add to crontab (Europe/London-aligned local times):\n" + r.crontab)
      if (r.note) console.log(r.note)
      if (r.curatorBin) console.log(`Curator harness: ${r.curatorBin}`)
      if (!r.ok) {
        console.error(r.stderr || "Schedule install failed")
        process.exit(1)
      }
      return
    }
    console.log(
      r.ok
        ? `Installed Task Scheduler jobs: ${(r.tasks || []).join(", ")} (daily ${TOPICS_TIME} topics, ${CURATOR_TIME} curator, local time)`
        : `Schedule install failed: ${r.stderr || "unknown"}`,
    )
    if (r.ok && r.curatorBin) console.log(`Curator harness: ${r.curatorBin}`)
    console.log(
      "Before enabling these, disable or delete any OpenChamber/OpenCode autolearn-curator schedule so the curator never runs twice.",
    )
    console.log(
      "Proposals scan is not scheduled separately — curator run already embeds proposals.scan → verify → promote.",
    )
    if (!r.ok) process.exit(1)
    return
  }

  console.log("Usage: autolearn-schedule.mjs [--install | --schedule | --remove | --run curator|topics]")
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) main(process.argv.slice(2))
