/**
 * Tests for plugin/autolearn-droid.mjs (node --test, no network, no real droid).
 *
 * Run: node --test plugin/test-droid-adapter.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawnSync } from "child_process"
import { fileURLToPath } from "url"

// The adapter resolves its store from AUTOLEARN_HOME at import time.
process.env.AUTOLEARN_HOME = mkdtempSync(join(tmpdir(), "al-droid-"))
const droid = await import("./autolearn-droid.mjs")

// Line shapes observed in real ~/.factory/sessions transcripts (2026-11-02).
const L = {
  start: (cwd = "C:\\repo") => ({ type: "session_start", id: "s1", cwd }),
  hook: () => ({ type: "message", message: { role: "user", content: [], visibility: "user_only", hookEventName: "Stop" } }),
  reminder: () => ({ type: "message", message: { role: "user", visibility: "llm_only", content: [{ type: "text", text: "<system-reminder> Unified tool catalog </system-reminder>" }] } }),
  toolResult: () => ({ type: "message", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } }),
  skill: () => ({ type: "message", message: { role: "user", content: [{ type: "text", text: "Skill \"sdd\" activated" }] } }),
  notice: (t) => ({ type: "message", message: { role: "user", content: [{ type: "text", text: t }] } }),
  user: (t) => ({ type: "message", message: { role: "user", userMessageSource: "desktop", content: [{ type: "text", text: t }] } }),
  execPrompt: (t) => ({ type: "message", message: { role: "user", content: [{ type: "text", text: t }] } }),
  asst: (t) => ({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: t }, { type: "tool_use", id: "t1", name: "Read", input: {} }] } }),
  toolOnly: () => ({ type: "message", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Read", input: {} }] } }),
  outcome: () => ({ type: "agent_turn_outcome", reason: "completed" }),
}
const jsonl = (lines) => lines.map(l => JSON.stringify(l)).join("\n") + "\n"

function conversation(turns) {
  const lines = [L.start()]
  for (let i = 1; i <= turns; i++) {
    lines.push(L.reminder(), L.user(`question ${i}`), L.hook(), L.toolOnly(), L.toolResult(), L.asst(`answer ${i}`), L.outcome())
  }
  return jsonl(lines)
}

// --- parser ---------------------------------------------------------------

test("parser keeps only genuine user and assistant text", () => {
  const { messages, cwd } = droid.parseDroidTranscript(jsonl([
    L.start("C:\\work"), L.reminder(), L.user("hello"), L.hook(), L.skill(), L.toolOnly(),
    L.toolResult(), L.notice("Request interrupted by user"), L.notice("Background task completed. task_id: x"),
    L.notice("/session-handoff is running"), L.asst("hi there"), L.outcome(),
  ]))
  assert.equal(cwd, "C:\\work")
  assert.deepEqual(messages, [{ role: "user", content: "hello" }, { role: "assistant", content: "hi there" }])
})

test("parser counts an untagged droid exec prompt as a user message", () => {
  const { messages } = droid.parseDroidTranscript(jsonl([L.start(), L.execPrompt("Reply with exactly: ok"), L.asst("ok")]))
  assert.equal(messages.filter(m => m.role === "user").length, 1)
})

test("parser strips reminder blocks from a typed message but keeps its text", () => {
  const line = { type: "message", message: { role: "user", userMessageSource: "desktop", content: [
    { type: "text", text: "<system-reminder>ctx</system-reminder>" }, { type: "text", text: "real question" },
  ] } }
  assert.deepEqual(droid.parseDroidTranscript(jsonl([line])).messages, [{ role: "user", content: "real question" }])
})

test("parser keeps a typed message that looks like a slash command", () => {
  const { messages } = droid.parseDroidTranscript(jsonl([L.user("/resume abc")]))
  assert.equal(messages[0].content, "/resume abc")
})

test("parser skips malformed lines without throwing", () => {
  const { messages } = droid.parseDroidTranscript("{not json\n" + jsonl([L.user("a")]) + "null\n42\n")
  assert.equal(messages.length, 1)
})

// --- cadence --------------------------------------------------------------

test("Stop below the threshold does not review", () => {
  const { messages } = droid.parseDroidTranscript(conversation(4))
  assert.equal(droid.planReview(messages, {}, { event: "Stop", threshold: 5 }), null)
})

test("repeated Stop firings over the same transcript review exactly once", () => {
  const { messages } = droid.parseDroidTranscript(conversation(5))
  let state = {}
  let reviews = 0
  for (let i = 0; i < 4; i++) {
    const plan = droid.planReview(messages, state, { event: "Stop", threshold: 5 })
    if (plan) { reviews++; state = plan.next }
  }
  assert.equal(reviews, 1)
  assert.deepEqual(state, { lastReviewUserMsg: 5, reviewedUpTo: 10 })
})

test("the next review fires only after another threshold of user messages", () => {
  const first = droid.planReview(droid.parseDroidTranscript(conversation(5)).messages, {}, { threshold: 5 })
  const nine = droid.parseDroidTranscript(conversation(9)).messages
  assert.equal(droid.planReview(nine, first.next, { threshold: 5 }), null)
  const ten = droid.parseDroidTranscript(conversation(10)).messages
  const second = droid.planReview(ten, first.next, { threshold: 5 })
  assert.equal(second.slice.length, 10)
  assert.equal(second.slice[0].content, "question 6")
})

test("PreCompact reviews the unreviewed slice below the threshold", () => {
  const { messages } = droid.parseDroidTranscript(conversation(2))
  const plan = droid.planReview(messages, {}, { event: "PreCompact", threshold: 5 })
  assert.equal(plan.slice.length, 4)
  assert.equal(droid.planReview(messages, plan.next, { event: "PreCompact", threshold: 5 }), null)
})

test("SessionEnd reviews the remainder after a threshold review", () => {
  const first = droid.planReview(droid.parseDroidTranscript(conversation(5)).messages, {}, { threshold: 5 })
  const seven = droid.parseDroidTranscript(conversation(7)).messages
  const plan = droid.planReview(seven, first.next, { event: "SessionEnd", threshold: 5 })
  assert.deepEqual(plan.slice.map(m => m.content), ["question 6", "answer 6", "question 7", "answer 7"])
})

test("a forced event with no new user message does not review", () => {
  const { messages } = droid.parseDroidTranscript(conversation(3))
  const st = { lastReviewUserMsg: 3, reviewedUpTo: messages.length - 1 }
  assert.equal(droid.planReview(messages, st, { event: "SessionEnd", threshold: 5 }), null)
})

test("a shrunken transcript clamps the cursors instead of re-reviewing", () => {
  const { messages } = droid.parseDroidTranscript(conversation(3))
  const st = { lastReviewUserMsg: 50, reviewedUpTo: 100 }
  assert.equal(droid.planReview(messages, st, { event: "SessionEnd", threshold: 5 }), null)
})

test("state round-trips and persists only the cursors", () => {
  droid.saveState("sess/1", { lastReviewUserMsg: 5, reviewedUpTo: 10, extra: "x" })
  assert.deepEqual(droid.loadState("sess/1"), { lastReviewUserMsg: 5, reviewedUpTo: 10 })
  assert.deepEqual(droid.loadState("missing"), {})
})

// --- review pipeline ------------------------------------------------------

const core = await import("./autolearn-core.mjs")
const authMod = await import("./autolearn-auth.mjs")

function resetStore() {
  rmSync(core.AL_HOME, { recursive: true, force: true })
  mkdirSync(core.REVIEWS_DIR, { recursive: true })
  // No spacing between reviews so each test controls admission itself.
  writeFileSync(core.CONFIG_FILE, "review_threshold: 5\nmin_interval_ms: 0\nmax_reviews_per_day: 0\n")
}

function writeTranscript(name, turns) {
  const dir = join(core.AL_HOME, "sessions")
  mkdirSync(dir, { recursive: true })
  const p = join(dir, `${name}.jsonl`)
  writeFileSync(p, conversation(turns))
  return p
}

const obs = () => existsSync(core.OBS_FILE)
  ? readFileSync(core.OBS_FILE, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l))
  : []
const reviews = () => readdirSync(core.REVIEWS_DIR).filter(f => f.startsWith("review-"))
const noStore = () => {}

test("failed auth writes no review file and records one auth_missing", () => {
  resetStore()
  const transcriptPath = writeTranscript("a1", 5)
  let launched = 0
  const deps = { auth: () => ({ ok: false, source: "login-store", reason: "auth_verify_fail" }), launch: () => { launched++ }, ensureStore: noStore }
  for (let i = 0; i < 3; i++) {
    assert.equal(droid.reviewSession({ sessionId: "a1", transcriptPath, event: "Stop" }, deps).status, "auth_failed")
  }
  assert.equal(launched, 0)
  assert.deepEqual(reviews(), [])
  const missing = obs().filter(o => o.type === "auth_missing")
  assert.equal(missing.length, 1)
  assert.deepEqual([missing[0].trigger, missing[0].reason], ["droid", "auth_verify_fail"])
  assert.equal(authMod.readAuthState().droid.state, "unauthenticated")
  assert.deepEqual(droid.loadState("a1"), {})
})

test("auth is not probed when no review is due", () => {
  resetStore()
  const transcriptPath = writeTranscript("a2", 2)
  let probed = 0
  const r = droid.reviewSession({ sessionId: "a2", transcriptPath }, { auth: () => { probed++; return { ok: true } }, launch: () => {}, ensureStore: noStore })
  assert.equal(r.status, "not_due")
  assert.equal(probed, 0)
})

test("auth ok spawns once, logs review_spawned and advances the cursors", () => {
  resetStore()
  const transcriptPath = writeTranscript("a3", 5)
  const calls = []
  const deps = { auth: () => ({ ok: true, source: "env" }), launch: (a) => calls.push(a), ensureStore: noStore }
  const first = droid.reviewSession({ sessionId: "a3", transcriptPath, event: "Stop" }, deps)
  const again = droid.reviewSession({ sessionId: "a3", transcriptPath, event: "Stop" }, deps)
  assert.equal(first.status, "spawned")
  assert.equal(again.status, "not_due")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].cwd, "C:\\repo")
  assert.equal(reviews().length, 1)
  const md = readFileSync(calls[0].reviewFile, "utf8")
  assert.match(md, /Trigger: droid/)
  assert.match(md, /question 5/)
  const spawned = obs().filter(o => o.type === "review_spawned")
  assert.deepEqual([spawned.length, spawned[0].project, spawned[0].trigger, spawned[0].event], [1, "repo", "droid", "Stop"])
  assert.deepEqual(droid.loadState("a3"), { lastReviewUserMsg: 5, reviewedUpTo: 10 })
})

test("a throttled spawn leaves the cursors for the next hook", () => {
  resetStore()
  writeFileSync(core.CONFIG_FILE, "review_threshold: 5\nmin_interval_ms: 3600000\nmax_reviews_per_day: 0\n")
  writeFileSync(core.THROTTLE_FILE, `${Date.now()}:other`)
  const transcriptPath = writeTranscript("a4", 5)
  const r = droid.reviewSession({ sessionId: "a4", transcriptPath }, { auth: () => ({ ok: true }), launch: () => {}, ensureStore: noStore })
  assert.equal(r.status, "throttled")
  assert.deepEqual(reviews(), [])
  assert.deepEqual(droid.loadState("a4"), {})
})

test("the reviewer's own session is never reviewed", () => {
  resetStore()
  const dir = join(core.AL_HOME, "sessions")
  mkdirSync(dir, { recursive: true })
  const p = join(dir, "rv.jsonl")
  writeFileSync(p, conversation(6).replace("question 1", "# Autolearn Review"))
  const deps = { auth: () => ({ ok: true }), launch: () => { throw new Error("must not launch") }, ensureStore: noStore }
  assert.equal(droid.reviewSession({ sessionId: "rv", transcriptPath: p }, deps).status, "reviewer_session")
  process.env.AUTOLEARN_REVIEWER = "1"
  try {
    assert.equal(droid.reviewSession({ sessionId: "a5", transcriptPath: writeTranscript("a5", 6) }, deps).status, "reviewer_session")
  } finally {
    delete process.env.AUTOLEARN_REVIEWER
  }
})

test("a launch failure keeps the review in a fallback file and does not advance", () => {
  resetStore()
  const transcriptPath = writeTranscript("a6", 5)
  const r = droid.reviewSession({ sessionId: "a6", transcriptPath }, { auth: () => ({ ok: true }), launch: () => { throw new Error("ENOENT") }, ensureStore: noStore })
  assert.equal(r.status, "launch_failed")
  assert.ok(readdirSync(core.AL_HOME).some(f => f.startsWith("review-failed-")))
  assert.deepEqual(droid.loadState("a6"), {})
})

// --- reviewer launch ------------------------------------------------------

test("reviewer argv runs droid exec headless with the review path", () => {
  const argv = droid.reviewerArgv({ reviewFile: "/h/review-1.md", cwd: "/repo/" }, "linux")
  assert.deepEqual(argv.slice(0, 6), ["droid", "exec", "--auto", "medium", "--cwd", "/repo"])
  assert.match(argv[6], /review-1\.md/)
  assert.ok(!argv[6].includes('"'), "hide-uv.vbs cannot carry double quotes")
})

test("reviewer argv routes through the hidden launcher on Windows", () => {
  const argv = droid.reviewerArgv({ reviewFile: "C:\\r.md", cwd: "C:\\repo\\" }, "win32")
  assert.deepEqual(argv.slice(0, 3), ["wscript.exe", core.HIDE_UV_VBS, "droid"])
  assert.equal(argv[argv.indexOf("--cwd") + 1], "C:\\repo")
})

test("launchReviewer marks the child as the reviewer and detaches it", () => {
  let seen
  droid.launchReviewer({ reviewFile: "/r.md", cwd: "/repo" }, { spawn: (argv, opts) => { seen = { argv, opts } }, platform: "linux" })
  assert.equal(seen.opts.env.AUTOLEARN_REVIEWER, "1")
  assert.equal(seen.opts.unref, true)
  assert.equal(seen.opts.cwd, "/repo")
})

// --- hook entry point -----------------------------------------------------

const ADAPTER = fileURLToPath(new URL("./autolearn-droid.mjs", import.meta.url))

test("handleHook rejects malformed and non-object payloads", () => {
  assert.equal(droid.handleHook("{nope").status, "bad_payload")
  assert.equal(droid.handleHook("").status, "bad_payload")
  assert.equal(droid.handleHook("42").status, "bad_payload")
})

test("handleHook ignores events other than Stop, SessionEnd and PreCompact", () => {
  for (const e of ["SessionStart", "UserPromptSubmit", "PreToolUse", "Notification"]) {
    assert.equal(droid.handleHook(JSON.stringify({ hook_event_name: e, session_id: "x", transcript_path: "/x" })).status, "ignored_event")
  }
})

test("handleHook dispatches each review event with the payload fields", () => {
  resetStore()
  const transcriptPath = writeTranscript("h1", 2)
  const deps = { auth: () => ({ ok: true }), launch: () => {}, ensureStore: noStore }
  const payload = (e) => JSON.stringify({ session_id: "h1", transcript_path: transcriptPath, cwd: "C:\\repo", permission_mode: "auto", hook_event_name: e })
  assert.equal(droid.handleHook(payload("Stop"), deps).status, "not_due")
  assert.equal(droid.handleHook(payload("PreCompact"), deps).status, "spawned")
  assert.equal(droid.handleHook(payload("SessionEnd"), deps).status, "not_due")
})

function runHookProcess(stdin, env = {}) {
  return spawnSync(process.execPath, [ADAPTER, "--hook"], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, AUTOLEARN_HOME: core.AL_HOME, ...env },
    timeout: 20000,
  })
}

test("--hook prints nothing and exits 0 for every input", () => {
  resetStore()
  const transcriptPath = writeTranscript("h2", 2)
  const inputs = [
    "",
    "{not json",
    "[]",
    JSON.stringify({ hook_event_name: "Notification" }),
    JSON.stringify({ hook_event_name: "Stop", session_id: "h2", transcript_path: join(core.AL_HOME, "missing.jsonl") }),
    JSON.stringify({ hook_event_name: "Stop", session_id: "h2", transcript_path: transcriptPath }),
  ]
  for (const input of inputs) {
    const r = runHookProcess(input)
    assert.equal(r.status, 0, `exit for ${input}`)
    assert.equal(r.stdout, "", `stdout for ${input}`)
    assert.equal(r.stderr, "", `stderr for ${input}`)
  }
})

test("--hook does nothing when autolearn is disabled", () => {
  resetStore()
  const transcriptPath = writeTranscript("h3", 6)
  const r = runHookProcess(JSON.stringify({ hook_event_name: "Stop", session_id: "h3", transcript_path: transcriptPath }), { AUTOLEARN_DISABLED: "1" })
  assert.equal(r.status, 0)
  assert.deepEqual(reviews(), [])
})
