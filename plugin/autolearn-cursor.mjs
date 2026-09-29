/**
 * Autolearn — Cursor harness adapter (transcript-driven; no Cursor hooks).
 *
 * Cursor has no in-process plugin runtime. Cursor's only role here is writing
 * transcript files; this module scans those transcripts locally and triggers
 * reviews via a one-shot headless Cursor agent. It reuses autolearn-core's
 * existing pipeline (config, redaction, formatReview, throttle, obs logging)
 * and modifies neither core nor any existing shell.
 *
 * Modes:
 *   --install    write the always-applied observer rule under ~/.cursor/rules/
 *   --scan       scan Cursor transcripts and spawn a review once per
 *                review_threshold user messages (one-shot; idempotent)
 *   --watch      resident loop: scan on an internal timer (default 5 min) in a
 *                single long-lived process — no console process per cycle
 *   --schedule   install (or, with --remove, remove) the hidden Startup
 *                shortcut that launches the watcher at logon (auto-push
 *                pattern; Windows); POSIX prints a crontab line
 *
 * Environment: AUTOLEARN_HOME, AUTOLEARN_DISABLED, AUTOLEARN_DEBUG (as core),
 * plus:
 *   AUTOLEARN_CURSOR_AGENT    - reviewer binary name (default "agent")
 *   AUTOLEARN_CURSOR_PROJECTS - transcripts root (default ~/.cursor/projects)
 *   AUTOLEARN_CURSOR_RULES    - rules dir (default ~/.cursor/rules)
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs"
import { homedir } from "os"
import { basename, join, resolve } from "path"
import { fileURLToPath } from "url"
import { spawnSync } from "child_process"
import * as core from "./autolearn-core.mjs"

export const CURSOR_HOME = join(homedir(), ".cursor")
export const PROJECTS_DIR = process.env.AUTOLEARN_CURSOR_PROJECTS || join(CURSOR_HOME, "projects")
export const RULES_DIR = process.env.AUTOLEARN_CURSOR_RULES || join(CURSOR_HOME, "rules")
export const OBSERVER_RULE_FILE = join(RULES_DIR, "autolearn-observer.mdc")
// Per-conversation scan state lives under the persona dir, alongside reviews/.
export const STATE_DIR = join(core.DEFAULT_PERSONA_DIR, "cursor")
export const REVIEWER_BIN = process.env.AUTOLEARN_CURSOR_AGENT || "agent"
export const SCHEDULE_TASK_NAME = "autolearn-cursor-scan"
export const SCAN_INTERVAL_MINUTES = 5

const OBSERVER_RULE = `---
description: Autolearn observer — capture user corrections, preferences, and workflow specs as they happen
alwaysApply: true
---

# Autolearn observer

After EVERY user message, silently check the autolearn signal taxonomy and,
when it matches, record it before continuing. Load the \`autolearn\` skill and
follow \`references/observer.md\` for the full taxonomy and escalation rules.

Record with:

    uv run ~/.agents/skills/autolearn/scripts/improve.py observe "<rule>" --project <project>

Strong signals (always record): user corrections; explicit preferences;
declarative workflow specs ("should be", "we use", "we don't", "I want");
frustration about repetition; explicit "remember this". Do not record one-time
task instructions, clarifications, or normal conversational flow.
`

export const WATCH_LAUNCHER = join(CURSOR_HOME, "autolearn-cursor-watch.ps1")

/**
 * Write the resident-watcher launcher (Windows only). Mirrors the proven
 * auto-push pattern: a long-lived process started once at logon via a hidden
 * Startup shortcut, rather than a Task Scheduler console process per cycle.
 * The watcher runs node --watch inside a hidden PowerShell console, so no
 * window is ever drawn and children inherited from it stay hidden too.
 */
export function writeWatchLauncher() {
  if (process.platform !== "win32") return
  const modulePath = fileURLToPath(import.meta.url)
  const ps = `& "${process.execPath}" "${modulePath}" --watch\r\n`
  try {
    mkdirSync(CURSOR_HOME, { recursive: true })
    writeFileSync(WATCH_LAUNCHER, ps)
  } catch (err) {
    core.dbg("cursor watch launcher write failed", err.message)
  }
}

/** Write the always-applied observer rule + watcher launcher. Idempotent. */
export function install() {
  try {
    mkdirSync(RULES_DIR, { recursive: true })
    writeFileSync(OBSERVER_RULE_FILE, OBSERVER_RULE)
    writeWatchLauncher()
    core.dbg("cursor install: wrote observer rule", OBSERVER_RULE_FILE)
    return OBSERVER_RULE_FILE
  } catch (err) {
    console.error("[autolearn] Cursor install failed:", err.message)
    return null
  }
}

function isDir(p) { try { return statSync(p).isDirectory() } catch { return false } }
function isFile(p) { try { return statSync(p).isFile() } catch { return false } }

/** Extract plain text from a Cursor message `content` (string or blocks). */
function textOf(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content
      .filter(b => b && b.type === "text" && typeof b.text === "string")
      .map(b => b.text)
      .join("\n\n")
  }
  return ""
}

/**
 * Parse a Cursor transcript (JSONL) into an ordered message list. Lines are
 * `{"role":"user|assistant","message":{"content":[ ... ]}}`; a turn ends with a
 * `{"type":"turn_ended",...}` marker (no `role`, skipped here). Tool-use blocks
 * are dropped — only text is reviewed.
 */
export function parseTranscript(text) {
  const messages = []
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj
    try { obj = JSON.parse(trimmed) } catch { continue }
    if (obj.role !== "user" && obj.role !== "assistant") continue
    const content = textOf(obj.message && obj.message.content)
    if (!content) continue
    messages.push({ role: obj.role, content })
  }
  return messages
}

/**
 * Reconstruct a workspace path from a Cursor project slug by greedily matching
 * segments against the filesystem (Cursor replaces path separators with "-",
 * so "git-repos" is indistinguishable from a separator without a lookup).
 * Returns null when it cannot be reconstructed (project moved/deleted).
 */
export function workspacePathFromSlug(slug) {
  try {
    const parts = String(slug).split("-")
    if (!parts.length) return null
    let cur
    let rest
    if (process.platform === "win32" && /^[a-zA-Z]$/.test(parts[0])) {
      cur = parts[0].toUpperCase() + ":\\"
      rest = parts.slice(1)
    } else if (slug.startsWith("-")) {
      cur = "/"
      rest = parts.slice(1)
    } else {
      return null
    }
    let i = 0
    while (i < rest.length) {
      let pick = null
      // Longest match first so multi-token names ("git-repos") win over splits.
      for (let k = rest.length - i; k >= 1; k--) {
        const candidate = rest.slice(i, i + k).join("-")
        const p = join(cur, candidate)
        try {
          if (existsSync(p) && statSync(p).isDirectory()) { pick = { p, k }; break }
        } catch {}
      }
      if (!pick) return null
      cur = pick.p
      i += pick.k
    }
    return cur
  } catch {
    return null
  }
}

function stateFile(id) {
  return join(STATE_DIR, `${String(id).replace(/[^A-Za-z0-9._-]/g, "_")}.json`)
}

export function loadState(id) {
  try { return JSON.parse(readFileSync(stateFile(id), "utf-8")) } catch { return {} }
}

export function saveState(id, st) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(stateFile(id), JSON.stringify(st))
  } catch (err) {
    core.dbg("cursor state save failed", err.message)
  }
}

/**
 * Launch the headless reviewer (`agent -p --force`) against the review file,
 * detached. On Windows the Cursor CLI is a `.cmd`/`.ps1` shim; the whole tree
 * stays hidden because the watcher runs inside a hidden console (Startup
 * shortcut) and children inherit it.
 */
export function launchReviewer({ reviewFile, cwd }) {
  const prompt = `The autolearn session review is the file at ${reviewFile} - read that file first. Load the autolearn skill and follow references/reviewer.md to act on it.`
  const env = { ...process.env, AUTOLEARN_REVIEWER: "1" }
  const opts = { cwd: cwd || CURSOR_HOME, env, unref: true }
  let argv
  if (process.platform === "win32") {
    // cmd /s strips the first/last quote of its /c argument, so leave the
    // binary unquoted and quote only the prompt.
    const comspec = process.env.ComSpec || "cmd.exe"
    const command = `${REVIEWER_BIN} -p --force "${prompt.replace(/"/g, '\\"')}"`
    argv = [comspec, "/d", "/s", "/c", command]
    opts.windowsVerbatimArguments = true
  } else {
    argv = [REVIEWER_BIN, "-p", "--force", prompt]
  }
  return core.spawnDetached(argv, opts)
}

/**
 * Scan all Cursor transcripts and spawn a review wherever the user-message
 * threshold is crossed. Idempotent: the absolute user count is recomputed from
 * the transcript each run, the reviewed slice advances only on an admitted
 * spawn, and core.throttleCheck dedupes identical content globally.
 */
export function scan() {
  const result = { scanned: 0, spawned: 0 }
  if (process.env.AUTOLEARN_DISABLED === "1") return result
  core.ensureStore()
  const config = core.parseConfig()
  const threshold = config.review_threshold || core.THRESHOLD_DEFAULT

  if (!existsSync(PROJECTS_DIR)) {
    core.dbg("cursor scan: no projects dir", PROJECTS_DIR)
    return result
  }
  let slugs = []
  try { slugs = readdirSync(PROJECTS_DIR) } catch { return result }

  for (const slug of slugs) {
    const tdir = join(PROJECTS_DIR, slug, "agent-transcripts")
    if (!isDir(tdir)) continue
    let entries = []
    try { entries = readdirSync(tdir) } catch { continue }

    const wsPath = workspacePathFromSlug(slug)
    const project = wsPath ? basename(wsPath) : slug
    const cwd = wsPath || CURSOR_HOME

    for (const entry of entries) {
      // Cursor stores one directory per conversation:
      //   agent-transcripts/<conversation_id>/<conversation_id>.jsonl
      // with subagent transcripts nested under a "subagents" subdir (not
      // scanned). Tolerate a bare <id>.jsonl/.txt file for older layouts.
      const ep = join(tdir, entry)
      let transcriptFile = null
      let conversationId = entry
      if (isDir(ep)) {
        const named = join(ep, entry + ".jsonl")
        if (isFile(named)) {
          transcriptFile = named
        } else {
          let inner = []
          try { inner = readdirSync(ep).filter(x => isFile(join(ep, x)) && /\.(jsonl|txt)$/.test(x)) } catch {}
          if (inner.length) {
            transcriptFile = join(ep, inner[0])
            conversationId = inner[0].replace(/\.(jsonl|txt)$/, "")
          }
        }
      } else if (isFile(ep) && /\.(jsonl|txt)$/.test(entry)) {
        transcriptFile = ep
        conversationId = entry.replace(/\.(jsonl|txt)$/, "")
      }
      if (!transcriptFile) continue

      result.scanned++
      let text
      try { text = readFileSync(transcriptFile, "utf-8") } catch { core.dbg("cursor scan: unreadable", entry); continue }
      // Depth guard: never review a transcript that contains review content
      // (e.g. a reviewer's own headless session).
      if (text.includes(core.REVIEW_HEADING)) continue

      const messages = parseTranscript(text)
      if (messages.length < 2) continue
      const userCount = messages.filter(m => m.role === "user").length

      const st = loadState(conversationId)
      const lastReviewUserMsg = st.lastReviewUserMsg || 0
      const reviewedUpTo = st.reviewedUpTo || 0
      if (userCount - lastReviewUserMsg < threshold) continue

      const slice = messages.slice(reviewedUpTo)
      if (!slice.length) continue

      const reviewMd = core.formatReview(slice, { project, trigger: "cursor" })
      // Peek, then commit ONLY when a spawn will actually happen, so a denied
      // spawn (busy window / duplicate) leaves state intact for the next scan.
      if (!core.throttleCheck(reviewMd, false)) { core.dbg("cursor scan: throttled", project); continue }
      if (!core.throttleCheck(reviewMd, true)) { core.dbg("cursor scan: throttled at commit", project); continue }

      const reviewFile = join(core.REVIEWS_DIR, `review-${Date.now()}.md`)
      try {
        mkdirSync(core.REVIEWS_DIR, { recursive: true })
        writeFileSync(reviewFile, reviewMd)
      } catch (err) {
        core.dbg("cursor scan: write review failed", err.message)
        continue
      }

      try {
        launchReviewer({ reviewFile, cwd })
      } catch (err) {
        core.dbg("cursor scan: launch failed", err.message)
        try { writeFileSync(join(core.AL_HOME, `review-failed-${Date.now()}.md`), reviewMd) } catch {}
        continue
      }

      core.logObs({ type: "review_spawned", review_file: reviewFile, message_count: slice.length, project, trigger: "cursor" })
      core.dbg("cursor scan: review spawned", reviewFile, project)
      result.spawned++

      saveState(conversationId, {
        userMsgCount: userCount,
        lastReviewUserMsg: userCount,
        reviewedUpTo: messages.length,
        project,
      })
    }
  }

  core.dbg("cursor scan complete", result)
  return result
}

// ---------------------------------------------------------------------------
// Resident watcher (auto-push pattern): one long-lived process, internal timer
// ---------------------------------------------------------------------------
export const WATCH_LOCK = join(core.AL_HOME, ".cursor_watch.lock")

function watchLockHeld() {
  try {
    const pid = parseInt(readFileSync(WATCH_LOCK, "utf-8").trim(), 10)
    if (pid > 0) { try { process.kill(pid, 0); return true } catch {} }
  } catch {}
  return false
}

/**
 * Resident watcher: scan on an internal timer so no console process is spawned
 * per cycle (mirrors the auto-push tray-daemon pattern). Single-instance via a
 * pid lock. Started once at logon by the hidden Startup shortcut.
 */
export function watch({ intervalMinutes = SCAN_INTERVAL_MINUTES } = {}) {
  if (process.env.AUTOLEARN_DISABLED === "1") return
  if (watchLockHeld()) { core.dbg("cursor watch: another watcher already running; exiting"); return }
  try { mkdirSync(core.AL_HOME, { recursive: true }); writeFileSync(WATCH_LOCK, String(process.pid)) } catch {}
  const release = () => { try { unlinkSync(WATCH_LOCK) } catch {} }
  process.on("exit", release)
  process.on("SIGINT", () => { release(); process.exit(0) })
  const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000
  const tick = () => { try { scan() } catch (err) { core.dbg("cursor watch tick error", err.message) } }
  core.dbg("cursor watch started", intervalMs)
  tick()
  setInterval(tick, intervalMs)
}

export const STARTUP_LNK = process.env.APPDATA
  ? join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "AutoLearnCursorScan.lnk")
  : null

function registerStartup() {
  writeWatchLauncher()
  // Remove any leftover Task Scheduler entry from the earlier approach.
  spawnSync("schtasks", ["/delete", "/tn", SCHEDULE_TASK_NAME, "/f"], { encoding: "utf8" })
  if (!STARTUP_LNK) return { ok: false, stderr: "APPDATA not set" }
  const ps = [
    "$ws = New-Object -ComObject WScript.Shell",
    `$lnk = $ws.CreateShortcut('${STARTUP_LNK.replace(/'/g, "''")}')`,
    "$lnk.TargetPath = 'powershell.exe'",
    `$lnk.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${WATCH_LAUNCHER}"'`,
    `$lnk.WorkingDirectory = '${CURSOR_HOME.replace(/'/g, "''")}'`,
    "$lnk.WindowStyle = 7",
    "$lnk.Save()",
    "Write-Output OK",
  ].join("; ")
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { encoding: "utf8" })
  return { ok: r.status === 0 && /OK/.test(r.stdout || ""), stderr: r.stderr || r.stdout }
}

function removeStartup() {
  if (STARTUP_LNK) { try { unlinkSync(STARTUP_LNK) } catch {} }
  try { unlinkSync(WATCH_LAUNCHER) } catch {}
  spawnSync("schtasks", ["/delete", "/tn", SCHEDULE_TASK_NAME, "/f"], { encoding: "utf8" })
  return { ok: true }
}

/**
 * Install (or remove) the autostart entry. Windows: a hidden Startup shortcut
 * running the resident watcher (auto-push pattern) — no Task Scheduler console
 * process, no VBS. POSIX: prints a crontab line for the user to install.
 */
export function schedule({ remove = false } = {}) {
  if (process.platform !== "win32") {
    const modulePath = fileURLToPath(import.meta.url)
    return { ok: true, crontab: `*/${SCAN_INTERVAL_MINUTES} * * * * "${process.execPath}" "${modulePath}" --scan >/dev/null 2>&1` }
  }
  return remove ? removeStartup() : registerStartup()
}

function main(argv) {
  if (argv.includes("--install")) {
    const path = install()
    console.log(path ? `Wrote observer rule: ${path}` : "Install failed")
    return
  }
  if (argv.includes("--scan")) {
    const r = scan()
    console.log(`cursor scan: ${r.scanned} transcript(s), ${r.spawned} review(s) spawned`)
    return
  }
  if (argv.includes("--watch")) {
    const m = argv.find(a => /^--interval=/.test(a))
    watch({ intervalMinutes: m ? Number(m.split("=")[1]) : SCAN_INTERVAL_MINUTES })
    return
  }
  if (argv.includes("--schedule")) {
    if (argv.includes("--remove")) {
      const r = schedule({ remove: true })
      console.log(r.ok ? "Removed autostart entry" : `Remove failed: ${r.stderr || "unknown"}`)
      return
    }
    const r = schedule()
    if (r.crontab) console.log("Add to crontab:\n" + r.crontab)
    else console.log(r.ok ? `Installed autostart shortcut: ${STARTUP_LNK}` : `Schedule failed: ${r.stderr || "unknown"}`)
    return
  }
  console.log("Usage: autolearn-cursor.mjs [--install | --scan | --watch | --schedule [--remove]]")
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) main(process.argv.slice(2))
