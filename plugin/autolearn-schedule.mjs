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
 *   AutoLearnCurator      daily 13:00 — headless `agent -p` with curator.md
 *   AutoLearnTopicsScan   daily 12:15 — `uv run … topics scan`
 *
 * Proposals scan is intentionally NOT scheduled: `curator run` (invoked by the
 * curator agent) already embeds proposer.scan → verify → promote.
 *
 * Windows launches go through a wait-capable WindowStyle-0 VBS wrapper so the
 * Task Scheduler process stays hidden and still waits for completion.
 *
 * Environment: AUTOLEARN_HOME, AUTOLEARN_DISABLED (as core), plus:
 *   AUTOLEARN_CURSOR_AGENT  - curator binary (default "agent"; shared with Cursor)
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "fs"
import { homedir } from "os"
import { dirname, join, resolve } from "path"
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

export const AGENT_BIN = process.env.AUTOLEARN_CURSOR_AGENT || "agent"
export const CURATOR_PROMPT =
  "Load the autolearn skill and follow references/curator.md to run the curator."

/** Like hide-uv.vbs but waits (third Run arg True) so schtasks sees real duration. */
export const HIDE_RUN_WAIT_VBS = join(
  process.env.USERPROFILE || homedir(),
  ".local",
  "bin",
  "hide-run-wait.vbs",
)
export const HIDE_RUN_WAIT_VBS_CONTENT = `Set sh = CreateObject("WScript.Shell")
Dim cmdline, i
cmdline = ""
For i = 0 To WScript.Arguments.Count - 1
    cmdline = cmdline & """" & WScript.Arguments(i) & """" & " "
Next
sh.Run Trim(cmdline), 0, True
`

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

/** Tiny PowerShell trampoline Task Scheduler can quote reliably. */
function writeJobLauncher(job) {
  mkdirSync(SCHEDULE_DIR, { recursive: true })
  const psPath = join(SCHEDULE_DIR, `autolearn-job-${job}.ps1`)
  const mod = installedModulePath().replace(/'/g, "''")
  const node = process.execPath.replace(/'/g, "''")
  writeFileSync(
    psPath,
    [
      "$ErrorActionPreference = 'Stop'",
      `& '${node}' '${mod}' --run ${job}`,
      "exit $LASTEXITCODE",
      "",
    ].join("\r\n"),
  )
  return psPath
}

function schtasksCreate(taskName, time, psPath) {
  const tr = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${psPath}"`
  const r = spawnSync(
    "schtasks",
    ["/Create", "/TN", taskName, "/SC", "DAILY", "/ST", time, "/F", "/RL", "LIMITED", "/TR", tr],
    { encoding: "utf8" },
  )
  return { ok: r.status === 0, stdout: r.stdout || "", stderr: r.stderr || "" }
}

function schtasksDelete(taskName) {
  spawnSync("schtasks", ["/Delete", "/TN", taskName, "/F"], { encoding: "utf8" })
}

export function crontabLines() {
  const mod = modulePath()
  const node = process.execPath
  // topics 12:15, curator 13:00 — daily
  return [
    `15 12 * * * "${node}" "${mod}" --run topics >/dev/null 2>&1`,
    `0 13 * * * "${node}" "${mod}" --run curator >/dev/null 2>&1`,
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
    return {
      ok: true,
      crontab: crontabLines(),
      note: "Times assume a Europe/London (or UTC+0/+1) host matching the prior OpenChamber slot.",
    }
  }
  ensureInstalledCopy()
  const curatorPs = writeJobLauncher("curator")
  const topicsPs = writeJobLauncher("topics")
  const c = schtasksCreate(CURATOR_TASK, CURATOR_TIME, curatorPs)
  const t = schtasksCreate(TOPICS_TASK, TOPICS_TIME, topicsPs)
  return {
    ok: c.ok && t.ok,
    tasks: [CURATOR_TASK, TOPICS_TASK],
    stderr: [c.stderr, t.stderr, c.stdout, t.stdout].filter(Boolean).join("\n"),
  }
}

export function removeSchedule() {
  if (process.platform !== "win32") {
    return { ok: true, note: "Remove the autolearn crontab lines manually." }
  }
  schtasksDelete(CURATOR_TASK)
  schtasksDelete(TOPICS_TASK)
  return { ok: true, tasks: [CURATOR_TASK, TOPICS_TASK] }
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
    argv = [AGENT_BIN, "-p", "--force", CURATOR_PROMPT]
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
    return
  }

  if (argv.includes("--install") || argv.includes("--schedule")) {
    const r = installSchedule()
    if (r.crontab) {
      console.log("Add to crontab (Europe/London-aligned local times):\n" + r.crontab)
      if (r.note) console.log(r.note)
      return
    }
    console.log(
      r.ok
        ? `Installed Task Scheduler jobs: ${(r.tasks || []).join(", ")} (daily ${TOPICS_TIME} topics, ${CURATOR_TIME} curator, local time)`
        : `Schedule install failed: ${r.stderr || "unknown"}`,
    )
    console.log(
      "Before enabling these, disable or delete any OpenChamber/OpenCode autolearn-curator schedule so the curator never runs twice.",
    )
    console.log(
      "Proposals scan is not scheduled separately — curator run already embeds proposals.scan → verify → promote.",
    )
    return
  }

  console.log("Usage: autolearn-schedule.mjs [--install | --schedule | --remove | --run curator|topics]")
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) main(process.argv.slice(2))
