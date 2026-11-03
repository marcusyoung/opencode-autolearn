/**
 * Cursor transcript reviewer guards (node --test, no network or real agent).
 *
 * Run: node --test plugin/test-cursor-adapter.mjs
 */

import { after, test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

// Store and transcript roots resolve at import time.
const root = mkdtempSync(join(tmpdir(), "al-cursor-"))
process.env.AUTOLEARN_HOME = join(root, "store")
process.env.AUTOLEARN_CURSOR_PROJECTS = join(root, "projects")
const cursor = await import("./autolearn-cursor.mjs")
const core = await import("./autolearn-core.mjs")
after(() => rmSync(root, { recursive: true, force: true }))

const REVIEWER_PROMPT = "The autolearn session review is the file at /reviews/review-1.md - read that file first. Load the autolearn skill and follow references/reviewer.md to act on it."
const user = (text) => ({ role: "user", message: { content: [{ type: "text", text }] } })
const assistant = (text) => ({ role: "assistant", message: { content: text } })
const tool = (text) => ({ role: "user", message: { content: [{ type: "tool_result", content: text }] } })
const jsonl = (lines) => lines.map(l => JSON.stringify(l)).join("\n") + "\n"
const noStore = () => {}
const reviews = () => readdirSync(core.REVIEWS_DIR).filter(f => f.startsWith("review-"))

function resetStore() {
  rmSync(core.AL_HOME, { recursive: true, force: true })
  rmSync(cursor.PROJECTS_DIR, { recursive: true, force: true })
  mkdirSync(core.REVIEWS_DIR, { recursive: true })
  writeFileSync(core.CONFIG_FILE, "review_threshold: 2\nmin_interval_ms: 0\nmax_reviews_per_day: 0\n")
}

function writeTranscript(id, lines) {
  const dir = join(cursor.PROJECTS_DIR, "fixture", "agent-transcripts", id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${id}.jsonl`)
  writeFileSync(file, jsonl(lines))
  return file
}

test("shared detection uses only the first user message and exact prefix", () => {
  assert.equal(core.REVIEWER_PROMPT_PREFIX, "The autolearn session review is the file at ")
  for (const [messages, expected] of [
    [[], false],
    [[{ role: "assistant", content: REVIEWER_PROMPT }], false],
    [[{ role: "user", content: REVIEWER_PROMPT }], true],
    [[{ role: "user", content: "" }, { role: "user", content: REVIEWER_PROMPT }], false],
    [[{ role: "user", content: " " + REVIEWER_PROMPT }], false],
    [[{ role: "user", content: "The autolearn session review is the file at" }], false],
    [[{ role: "user", content: "# Autolearn Review" }], false],
  ]) {
    assert.equal(core.isReviewerSession(messages), expected)
  }
})

test("Cursor parser drops tool results while preserving text", () => {
  assert.deepEqual(cursor.parseTranscript(jsonl([
    user("question"), tool(REVIEWER_PROMPT), assistant("answer"), { type: "turn_ended" },
  ])), [{ role: "user", content: "question" }, { role: "assistant", content: "answer" }])
})

test("Cursor reviewer environment marker skips store, auth and scanning", () => {
  resetStore()
  const previous = process.env.AUTOLEARN_REVIEWER
  process.env.AUTOLEARN_REVIEWER = "1"
  const unexpected = () => { throw new Error("must not run") }
  try {
    assert.deepEqual(cursor.scan({ auth: unexpected, launch: unexpected, ensureStore: unexpected }), { scanned: 0, spawned: 0 })
    assert.deepEqual(reviews(), [])
  } finally {
    if (previous === undefined) delete process.env.AUTOLEARN_REVIEWER
    else process.env.AUTOLEARN_REVIEWER = previous
  }
})

for (const [name, lines, reviewer] of [
  ["first user prompt", [user(REVIEWER_PROMPT), assistant("reading file")], true],
  ["first user prompt after assistant text", [assistant("context"), user(REVIEWER_PROMPT)], true],
  ["heading alone in the first user message", [user("# Autolearn Review"), assistant("ok")], false],
  ["heading and prompt in tool output", [user("read source"), tool(`# Autolearn Review\n${REVIEWER_PROMPT}`), assistant("done")], false],
  ["heading and prompt in assistant text", [user("explain guard"), assistant(`# Autolearn Review\n${REVIEWER_PROMPT}`)], false],
  ["prompt in assistant text before the first user", [assistant(REVIEWER_PROMPT), user("normal question")], false],
  ["heading and prompt in later user messages", [user("normal question"), assistant("ok"), user(`# Autolearn Review\n${REVIEWER_PROMPT}`)], false],
  ["prompt prefix at the start of a later user message", [user("normal question"), assistant("ok"), user(REVIEWER_PROMPT)], false],
  ["prompt quoted mid-message", [user(`Explain this prompt: ${REVIEWER_PROMPT}`), assistant("ok")], false],
]) {
  test(`Cursor depth guard: ${name}`, () => {
    resetStore()
    // Cross the cadence threshold even for a genuine reviewer fixture.
    const all = [...lines, user("follow-up"), assistant("response")]
    writeTranscript("guard", all)
    const calls = []
    const deps = { auth: () => ({ ok: true, source: "env" }), launch: (args) => calls.push(args), ensureStore: noStore }
    assert.deepEqual(cursor.scan(deps), { scanned: 1, spawned: reviewer ? 0 : 1 })
    assert.equal(calls.length, reviewer ? 0 : 1)
    if (reviewer) {
      assert.deepEqual(cursor.loadState("guard"), {})
      assert.deepEqual(reviews(), [])
      assert.ok(!existsSync(core.THROTTLE_FILE))
    } else {
      assert.equal(reviews().length, 1)
      assert.match(readFileSync(calls[0].reviewFile, "utf8"), /Trigger: cursor/)
      assert.equal(cursor.loadState("guard").lastReviewUserMsg, cursor.parseTranscript(jsonl(all)).filter(m => m.role === "user").length)
      assert.deepEqual(cursor.scan(deps), { scanned: 1, spawned: 0 })
      assert.equal(calls.length, 1)
    }
  })
}

test("Cursor session with no user message does not spawn", () => {
  resetStore()
  writeTranscript("empty", [tool(REVIEWER_PROMPT), assistant("# Autolearn Review"), assistant(REVIEWER_PROMPT)])
  const deps = { auth: () => ({ ok: true }), launch: () => { throw new Error("must not launch") }, ensureStore: noStore }
  assert.deepEqual(cursor.scan(deps), { scanned: 1, spawned: 0 })
  assert.deepEqual(cursor.loadState("empty"), {})
})

test("Cursor cadence still waits for another threshold of user messages", () => {
  resetStore()
  const file = writeTranscript("cadence", [user("one"), assistant("ok")])
  const calls = []
  const deps = { auth: () => ({ ok: true }), launch: (args) => calls.push(args), ensureStore: noStore }
  assert.deepEqual(cursor.scan(deps), { scanned: 1, spawned: 0 })
  const lines = [user("one"), assistant("ok"), user("two"), assistant("ok")]
  writeFileSync(file, jsonl(lines))
  assert.deepEqual(cursor.scan(deps), { scanned: 1, spawned: 1 })
  writeFileSync(file, jsonl([...lines, user("three"), assistant("ok")]))
  assert.deepEqual(cursor.scan(deps), { scanned: 1, spawned: 0 })
  writeFileSync(file, jsonl([...lines, user("three"), assistant("ok"), user("four"), assistant("ok")]))
  assert.deepEqual(cursor.scan(deps), { scanned: 1, spawned: 1 })
  assert.equal(calls.length, 2)
})

test("Cursor deduplicates identical review content across conversations", () => {
  resetStore()
  const lines = [user("same question"), assistant("ok"), user("same follow-up"), assistant("ok")]
  writeTranscript("duplicate-1", lines)
  writeTranscript("duplicate-2", lines)
  const calls = []
  const deps = { auth: () => ({ ok: true }), launch: (args) => calls.push(args), ensureStore: noStore }
  assert.deepEqual(cursor.scan(deps), { scanned: 2, spawned: 1 })
  assert.equal(calls.length, 1)
  assert.deepEqual(cursor.loadState("duplicate-2"), {})
  assert.deepEqual(cursor.scan(deps), { scanned: 2, spawned: 0 })
})

test("Cursor auth failure still writes no review or cadence state", () => {
  resetStore()
  writeTranscript("auth", [user("one"), assistant("ok"), user("two"), assistant("ok")])
  const result = cursor.scan({ auth: () => ({ ok: false, source: "login-store", reason: "not_logged_in" }), launch: () => { throw new Error("must not launch") }, ensureStore: noStore })
  assert.deepEqual(result, { scanned: 0, spawned: 0, authError: true, authReason: "not_logged_in" })
  assert.deepEqual(reviews(), [])
  assert.deepEqual(cursor.loadState("auth"), {})
})

test("Cursor launcher uses the shared prefix and reviewer environment", () => {
  let seen
  cursor.launchReviewer({ reviewFile: "/reviews/review-1.md", cwd: "/repo" }, {
    platform: "linux",
    spawn: (argv, opts) => { seen = { argv, opts } },
  })
  assert.deepEqual(seen.argv, [cursor.REVIEWER_BIN, "-p", "--force", REVIEWER_PROMPT])
  assert.ok(seen.argv.at(-1).startsWith(core.REVIEWER_PROMPT_PREFIX))
  assert.equal(seen.opts.env.AUTOLEARN_REVIEWER, "1")
  assert.equal(seen.opts.cwd, "/repo")
  assert.equal(seen.opts.unref, true)
})
