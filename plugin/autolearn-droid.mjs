/**
 * Autolearn — Factory Droid harness adapter (hook-driven).
 *
 * Droid fires real lifecycle hooks, so unlike the Cursor adapter there is no
 * transcript watcher, pid lock, or Startup shortcut. Each hook invocation reads
 * the session transcript named on stdin, decides whether a review is due, and
 * spawns a detached headless `droid exec` reviewer. It reuses autolearn-core's
 * config, formatReview, throttle and observation log.
 *
 * Environment: AUTOLEARN_HOME, AUTOLEARN_DISABLED, AUTOLEARN_DEBUG (as core).
 */

import { mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import * as core from "./autolearn-core.mjs"

// Per-session cadence state lives under the persona dir, alongside reviews/.
export const STATE_DIR = join(core.DEFAULT_PERSONA_DIR, "droid")

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
