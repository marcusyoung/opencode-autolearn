/**
 * Tests for plugin/autolearn-droid.mjs (node --test, no network, no real droid).
 *
 * Run: node --test plugin/test-droid-adapter.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

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
