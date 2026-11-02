/**
 * Autolearn — Factory Droid harness adapter (hook-driven).
 *
 * Droid fires real lifecycle hooks, so unlike the Cursor adapter there is no
 * transcript watcher, pid lock, or Startup shortcut. Each hook invocation reads
 * the session transcript named on stdin, decides whether a review is due, and
 * spawns a detached headless `droid exec` reviewer. It reuses autolearn-core's
 * config, formatReview, throttle and observation log.
 *
 * Usage:
 *   --hook               handle one Stop, SessionEnd or PreCompact hook (stdin JSON)
 *   --install [--remove] add (or remove) the autolearn hooks in ~/.factory/hooks.json
 *
 * Environment: AUTOLEARN_HOME, AUTOLEARN_DISABLED, AUTOLEARN_DEBUG (as core),
 * plus AUTOLEARN_DROID_BIN (reviewer binary, default "droid") and
 * AUTOLEARN_DROID_HOOKS (hooks file, default ~/.factory/hooks.json).
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { homedir } from "os"
import { basename, dirname, join, resolve } from "path"
import { fileURLToPath } from "url"
import * as core from "./autolearn-core.mjs"
import { resolveDroidAuth, readAuthState, writeAuthState, nextAuthState } from "./autolearn-auth.mjs"

// Per-session cadence state lives under the persona dir, alongside reviews/.
export const STATE_DIR = join(core.DEFAULT_PERSONA_DIR, "droid")
export const REVIEWER_BIN = process.env.AUTOLEARN_DROID_BIN || "droid"
export const FACTORY_HOME = join(homedir(), ".factory")
// Harness notices Droid writes as user-role lines. They are not typed by the
// user, so counting them would fire reviews on tool-heavy turns.
const NOTICE_RES = [
  /^\s*<system-reminder>/,
  /^Skill "[^"]*" activated/,
  /^Request interrupted by user/,
  /^Background task completed\./,
  /^\/[\w-]+ is running/,
]

function textBlocks(content) {
  if (typeof content === "string") return [content]
  if (!Array.isArray(content)) return []
  return content
    .filter(b => b && b.type === "text" && typeof b.text === "string")
    .map(b => b.text)
    .filter(t => t.trim())
}

/**
 * Parse a Droid session transcript (JSONL) into ordered genuine user and
 * assistant text, plus the session cwd from the `session_start` line.
 *
 * A user line counts only when it is not a hook record (`hookEventName`) and
 * has a text block that is not a harness notice. Lines tagged with
 * `userMessageSource` were typed by the user, so only reminder blocks are
 * stripped from them; `droid exec` prompts carry no source tag and go through
 * the full notice filter. Tool results, thinking and tool_use blocks are dropped.
 */
export function parseDroidTranscript(text) {
  const messages = []
  let cwd = null
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let obj
    try { obj = JSON.parse(trimmed) } catch { continue }
    if (!obj || typeof obj !== "object") continue
    if (obj.type === "session_start") {
      if (typeof obj.cwd === "string" && obj.cwd) cwd = obj.cwd
      continue
    }
    if (obj.type !== "message" || !obj.message) continue
    const m = obj.message
    if (m.role === "user") {
      if (m.hookEventName) continue
      const typed = Boolean(m.userMessageSource)
      const texts = textBlocks(m.content).filter(t => typed ? !NOTICE_RES[0].test(t) : !NOTICE_RES.some(r => r.test(t)))
      if (!texts.length) continue
      messages.push({ role: "user", content: texts.join("\n\n") })
    } else if (m.role === "assistant") {
      const texts = textBlocks(m.content)
      if (!texts.length) continue
      messages.push({ role: "assistant", content: texts.join("\n\n") })
    }
  }
  return { messages, cwd }
}

function stateFile(id) {
  return join(STATE_DIR, `${String(id).replace(/[^A-Za-z0-9._-]/g, "_")}.json`)
}

export function loadState(id) {
  try {
    const st = JSON.parse(readFileSync(stateFile(id), "utf-8"))
    return st && typeof st === "object" ? st : {}
  } catch {
    return {}
  }
}

/** Persist only the cadence cursors; the user count is always recomputed. */
export function saveState(id, st) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(stateFile(id), JSON.stringify({
      lastReviewUserMsg: st.lastReviewUserMsg || 0,
      reviewedUpTo: st.reviewedUpTo || 0,
    }))
  } catch (err) {
    core.dbg("droid state save failed", err.message)
  }
}

/** Events that review any unreviewed slice regardless of the threshold. */
export const FORCE_EVENTS = new Set(["PreCompact", "SessionEnd"])

/**
 * Decide whether a review is due. Pure: returns null, or the slice to review
 * and the state to persist once the spawn is actually admitted.
 *
 * Stop fires on every turn, so this must be idempotent: the absolute user
 * count comes from the transcript, and the cursors only advance when the
 * caller commits `next`. Re-evaluating the same transcript after a commit
 * yields null.
 */
export function planReview(messages, state = {}, { event = "Stop", threshold = core.THRESHOLD_DEFAULT } = {}) {
  const userCount = messages.filter(m => m.role === "user").length
  // Clamp rather than reset if the transcript shrank, so a rewritten file
  // never re-reviews turns that were already reviewed.
  const last = Math.min(state.lastReviewUserMsg || 0, userCount)
  const upTo = Math.min(state.reviewedUpTo || 0, messages.length)
  if (!FORCE_EVENTS.has(event) && userCount - last < threshold) return null
  const slice = messages.slice(upTo)
  if (slice.length < 2 || !slice.some(m => m.role === "user")) return null
  return { slice, userCount, next: { lastReviewUserMsg: userCount, reviewedUpTo: messages.length } }
}

/**
 * argv for the headless reviewer. On Windows it goes through the same
 * WScript WindowStyle-0 launcher as `uv` (hide-uv.vbs), because windowsHide
 * only covers the immediate child and droid's own children would flash a
 * console. hide-uv.vbs wraps each argument in double quotes without escaping,
 * so the prompt must contain none, and a trailing backslash on --cwd would
 * escape its closing quote.
 */
export function reviewerArgv({ reviewFile, cwd }, platform = process.platform) {
  const prompt = `The autolearn session review is the file at ${reviewFile} - read that file first. Load the autolearn skill and follow references/reviewer.md to act on it.`
  const args = [REVIEWER_BIN, "exec", "--auto", "medium"]
  const dir = cwd ? String(cwd).replace(/[\\/]+$/, "") : ""
  if (dir) args.push("--cwd", dir)
  args.push(prompt)
  return platform === "win32" ? ["wscript.exe", core.HIDE_UV_VBS, ...args] : args
}

export function launchReviewer({ reviewFile, cwd }, { spawn = core.spawnDetached, platform = process.platform } = {}) {
  if (platform === "win32") {
    try {
      mkdirSync(join(process.env.USERPROFILE || "", ".local", "bin"), { recursive: true })
      writeFileSync(core.HIDE_UV_VBS, core.HIDE_UV_VBS_CONTENT)
    } catch (err) {
      core.dbg("droid launchReviewer: hide-uv.vbs ensure failed", err.message)
    }
  }
  // AUTOLEARN_REVIEWER marks the reviewer's own session so its hooks skip it.
  const env = { ...process.env, AUTOLEARN_REVIEWER: "1" }
  return spawn(reviewerArgv({ reviewFile, cwd }, platform), { cwd: cwd || FACTORY_HOME, env, unref: true })
}

/**
 * Review one Droid session if a review is due. Never throws.
 *
 * Order matters: cadence first (cheap, no I/O beyond the transcript), then the
 * auth preflight, then the throttle, and only then is a review file written.
 * A failed preflight therefore leaves no orphan review file and consumes no
 * throttle window, and the cursors advance only on an admitted spawn.
 *
 * `deps` exists for tests: auth, launch, ensureStore.
 */
export function reviewSession({ sessionId, transcriptPath, event = "Stop", cwd } = {}, deps = {}) {
  const {
    auth = () => resolveDroidAuth(REVIEWER_BIN),
    launch = launchReviewer,
    ensureStore = core.ensureStore,
  } = deps
  try {
    if (process.env.AUTOLEARN_DISABLED === "1") return { status: "disabled" }
    if (process.env.AUTOLEARN_REVIEWER === "1") return { status: "reviewer_session" }
    if (!sessionId || !transcriptPath) return { status: "no_transcript" }
    let text
    try { text = readFileSync(transcriptPath, "utf-8") } catch { return { status: "no_transcript" } }
    // Depth guard: never review a transcript that contains review content,
    // which is the reviewer's own session if the env marker did not reach it.
    if (text.includes(core.REVIEW_HEADING)) return { status: "reviewer_session" }

    const parsed = parseDroidTranscript(text)
    ensureStore()
    const config = core.parseConfig()
    const threshold = config.review_threshold || core.THRESHOLD_DEFAULT
    const plan = planReview(parsed.messages, loadState(sessionId), { event, threshold })
    if (!plan) return { status: "not_due" }

    const verdict = auth()
    const gate = nextAuthState(readAuthState(), verdict, new Date(), "droid")
    writeAuthState(gate.states)
    if (gate.record) {
      core.logObs({ type: "auth_missing", trigger: "droid", source: verdict.source, reason: verdict.reason })
    }
    if (!verdict.ok) return { status: "auth_failed", reason: verdict.reason }

    const sessionCwd = parsed.cwd || cwd || ""
    const project = sessionCwd ? basename(sessionCwd.replace(/[\\/]+$/, "")) : "unknown"
    const reviewMd = core.formatReview(plan.slice, { project, trigger: "droid" })
    // Peek, then commit only when a spawn will actually happen.
    if (!core.throttleCheck(reviewMd, false)) return { status: "throttled" }
    if (!core.throttleCheck(reviewMd, true)) return { status: "throttled" }

    const reviewFile = join(core.REVIEWS_DIR, `review-${Date.now()}.md`)
    try {
      mkdirSync(core.REVIEWS_DIR, { recursive: true })
      writeFileSync(reviewFile, reviewMd)
    } catch (err) {
      core.dbg("droid review: write failed", err.message)
      return { status: "write_failed" }
    }
    try {
      launch({ reviewFile, cwd: sessionCwd })
    } catch (err) {
      core.dbg("droid review: launch failed", err.message)
      try { writeFileSync(join(core.AL_HOME, `review-failed-${Date.now()}.md`), reviewMd) } catch {}
      return { status: "launch_failed" }
    }
    core.logObs({ type: "review_spawned", review_file: reviewFile, message_count: plan.slice.length, project, trigger: "droid", event })
    saveState(sessionId, plan.next)
    return { status: "spawned", reviewFile }
  } catch (err) {
    core.dbg("droid review error", err && err.message)
    return { status: "error" }
  }
}

/** Hook events that can trigger a review; every other event is ignored. */
export const HOOK_EVENTS = new Set(["Stop", "SessionEnd", "PreCompact"])

/**
 * Handle one hook invocation from its raw stdin text. Never throws. Droid
 * passes session_id, transcript_path, cwd and hook_event_name on stdin.
 */
export function handleHook(raw, deps = {}) {
  let payload
  try { payload = JSON.parse(String(raw || "")) } catch { return { status: "bad_payload" } }
  if (!payload || typeof payload !== "object") return { status: "bad_payload" }
  const event = payload.hook_event_name
  if (!HOOK_EVENTS.has(event)) return { status: "ignored_event" }
  return reviewSession({
    sessionId: payload.session_id,
    transcriptPath: payload.transcript_path,
    cwd: payload.cwd,
    event,
  }, deps)
}

// ---------------------------------------------------------------------------
// Hook registration in ~/.factory/hooks.json (additive, reversible)
// ---------------------------------------------------------------------------

export const HOOKS_FILE = process.env.AUTOLEARN_DROID_HOOKS || join(FACTORY_HOME, "hooks.json")
// Every autolearn entry is identified by this file name in its command, so
// removal never touches another tool's hooks.
export const ADAPTER_MARK = "autolearn-droid.mjs"
export const HOOK_TIMEOUT_S = 30

export function hookCommand(modulePath = fileURLToPath(import.meta.url)) {
  return `node "${modulePath}" --hook`
}

const isOurs = (h) => h && typeof h.command === "string" && h.command.includes(ADAPTER_MARK)

/** Strip autolearn hooks from one event's matcher groups; drop groups left empty. */
function stripOurs(groups) {
  const out = []
  let removed = false
  for (const g of groups) {
    if (!g || !Array.isArray(g.hooks)) { out.push(g); continue }
    const kept = g.hooks.filter(h => !isOurs(h))
    if (kept.length === g.hooks.length) { out.push(g); continue }
    removed = true
    if (kept.length) out.push({ ...g, hooks: kept })
  }
  return { groups: out, removed }
}

/**
 * Pure transform of a parsed hooks.json. Install appends one autolearn group
 * to Stop, SessionEnd and PreCompact (replacing any earlier autolearn entry);
 * remove strips autolearn entries everywhere and drops event keys it emptied.
 */
export function applyHookRegistration(config, { remove = false, command = hookCommand() } = {}) {
  const next = { ...(config && typeof config === "object" && !Array.isArray(config) ? config : {}) }
  for (const event of Object.keys(next)) {
    if (!Array.isArray(next[event])) continue
    const { groups, removed } = stripOurs(next[event])
    if (removed && !groups.length && (remove || !HOOK_EVENTS.has(event))) delete next[event]
    else next[event] = groups
  }
  if (!remove) {
    for (const event of HOOK_EVENTS) {
      const groups = Array.isArray(next[event]) ? next[event] : []
      next[event] = [...groups, { hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] }]
    }
  }
  return next
}

function detectFormat(raw) {
  const m = /\n([ \t]+)\S/.exec(raw)
  return { indent: m ? m[1] : 2, newline: raw.endsWith("\n") }
}

/**
 * Register (or with remove, unregister) the autolearn hooks. Idempotent. Backs
 * up the file before any change and refuses to touch a file it cannot parse,
 * because rewriting it would drop every other tool's hooks.
 */
export function installHooks({ file = HOOKS_FILE, remove = false, command } = {}) {
  let raw = ""
  try { raw = readFileSync(file, "utf-8") } catch (err) {
    if (err.code !== "ENOENT") return { ok: false, error: err.message }
  }
  let config = {}
  if (raw.trim()) {
    try { config = JSON.parse(raw) } catch (err) { return { ok: false, error: `unparseable ${file}: ${err.message}` } }
  }
  const next = applyHookRegistration(config, { remove, command })
  const { indent, newline } = raw ? detectFormat(raw) : { indent: 2, newline: true }
  const out = JSON.stringify(next, null, indent) + (newline ? "\n" : "")
  if (out === raw) return { ok: true, changed: false, file }
  if (remove && !raw) return { ok: true, changed: false, file }
  try {
    mkdirSync(dirname(file), { recursive: true })
    let backup = null
    if (raw) {
      backup = `${file}.autolearn-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`
      copyFileSync(file, backup)
    }
    writeFileSync(file, out)
    return { ok: true, changed: true, file, backup }
  } catch (err) {
    return { ok: false, error: err.message }
  }
}
function readStdin() {
  if (process.stdin.isTTY) return ""
  try { return readFileSync(0, "utf-8") } catch { return "" }
}

function main(argv) {
  if (argv.includes("--hook")) {
    // A hook must never block or annotate a turn: no output, always exit 0.
    try { core.dbg("droid hook", handleHook(readStdin())) } catch {}
    return 0
  }
  if (argv.includes("--install")) {
    const remove = argv.includes("--remove")
    const r = installHooks({ remove })
    if (!r.ok) { console.error(`[autolearn] Droid hook ${remove ? "removal" : "install"} failed: ${r.error}`); return 1 }
    const verb = remove ? "Removed autolearn hooks from" : "Registered autolearn hooks in"
    console.log(r.changed ? `${verb} ${r.file}${r.backup ? ` (backup: ${r.backup})` : ""}` : `Hooks already up to date: ${r.file}`)
    return 0
  }
  console.log("Usage: autolearn-droid.mjs [--hook | --install [--remove]]")
  return 0
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) process.exit(main(process.argv.slice(2)))
