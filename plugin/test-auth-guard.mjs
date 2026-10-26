/**
 * Tests for plugin/autolearn-auth.mjs (node --test, no network, no real CLI).
 *
 * Run: node --test plugin/test-auth-guard.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import {
  classifyAuthStatus,
  shortCircuitFromEnv,
  cursorAuthArgv,
  probeAuth,
  resolveAuth,
  buildProbeCommand,
  readAuthState,
  writeAuthState,
  nextAuthState,
} from "./autolearn-auth.mjs"

// --- classification -------------------------------------------------------

test("classifyAuthStatus accepts a logged-in object", () => {
  const v = classifyAuthStatus({ status: "authenticated", isAuthenticated: true })
  assert.equal(v.ok, true)
  assert.equal(v.source, "login-store")
})

test("classifyAuthStatus rejects null", () => {
  const v = classifyAuthStatus(null)
  assert.equal(v.ok, false)
  assert.equal(v.reason, "unreadable_status")
})

test("classifyAuthStatus rejects the real unauthenticated payload", () => {
  const v = classifyAuthStatus({
    status: "unauthenticated",
    isAuthenticated: false,
    hasAccessToken: false,
    hasRefreshToken: false,
    message: "Not logged in",
  })
  assert.equal(v.ok, false)
  assert.equal(v.reason, "unauthenticated")
})

test("classifyAuthStatus requires a literal true, not truthy", () => {
  assert.equal(classifyAuthStatus({ isAuthenticated: "true" }).ok, false)
  assert.equal(classifyAuthStatus({ isAuthenticated: 1 }).ok, false)
  assert.equal(classifyAuthStatus({}).ok, false)
})

// --- env short-circuit ----------------------------------------------------

test("shortCircuitFromEnv ignores empty and whitespace keys", () => {
  assert.equal(shortCircuitFromEnv({}), null)
  assert.equal(shortCircuitFromEnv({ CURSOR_API_KEY: "" }), null)
  assert.equal(shortCircuitFromEnv({ CURSOR_API_KEY: "   " }), null)
})

test("shortCircuitFromEnv uses a set key without spawning", () => {
  const v = shortCircuitFromEnv({ CURSOR_API_KEY: "key-abc" })
  assert.deepEqual([v.ok, v.source], [true, "env"])
})

test("resolveAuth prefers env over the probe", () => {
  let spawned = false
  const spawn = () => { spawned = true; return { status: 0, stdout: "" } }
  const v = resolveAuth("agent", { env: { CURSOR_API_KEY: "k" }, spawn })
  assert.equal(v.ok, true)
  assert.equal(spawned, false)
})

// --- probe ----------------------------------------------------------------

test("cursorAuthArgv builds the documented status command", () => {
  assert.deepEqual(cursorAuthArgv("agent"), ["agent", "status", "--format", "json"])
})

test("buildProbeCommand passes argv straight through on POSIX", () => {
  const c = buildProbeCommand(["agent", "status"], "linux", "cmd.exe")
  assert.deepEqual([c.file, c.args], ["agent", ["status"]])
})

test("buildProbeCommand routes Windows cmd shims through ComSpec", () => {
  // Node refuses to spawn a .cmd shim directly (EINVAL), and a bare `agent`
  // resolves to agent.cmd, so the probe must wrap it or it reports a false
  // binary_missing and blocks a healthy pipeline.
  const c = buildProbeCommand(["agent.cmd", "status", "--format", "json"], "win32", "cmd.exe")
  assert.equal(c.file, "cmd.exe")
  assert.deepEqual(c.args, ["/d", "/s", "/c", "agent.cmd status --format json"])
})

test("buildProbeCommand quotes Windows argv entries containing spaces", () => {
  const bin = "C:\\Program Files\\nodejs\\agent.cmd"
  const c = buildProbeCommand([bin, "status"], "win32", "cmd.exe")
  assert.equal(c.args[3], `"${bin}" status`)
})

test("probeAuth uses the platform command builder", () => {
  const seen = []
  const spawn = (file, args) => {
    seen.push([file, args])
    return { status: 0, stdout: JSON.stringify({ isAuthenticated: true }), stderr: "" }
  }
  probeAuth(["agent.cmd", "status"], { spawn, platform: "win32", comspec: "cmd.exe" })
  assert.equal(seen[0][0], "cmd.exe")
})

test("probeAuth reports binary_missing for an empty argv", () => {
  assert.equal(probeAuth([]).reason, "binary_missing")
})

test("probeAuth reports binary_missing on ENOENT", () => {
  const spawn = () => ({ error: { code: "ENOENT" }, stdout: "", stderr: "" })
  assert.equal(probeAuth(["agent", "status"], { spawn }).reason, "binary_missing")
})

test("probeAuth reports probe_timeout on ETIMEDOUT", () => {
  const spawn = () => ({ error: { code: "ETIMEDOUT" }, stdout: "", stderr: "" })
  assert.equal(probeAuth(["agent", "status"], { spawn }).reason, "probe_timeout")
})

test("probeAuth treats unparseable success output as failure", () => {
  const spawn = () => ({ status: 0, stdout: "not json", stderr: "" })
  const v = probeAuth(["agent", "status"], { spawn })
  assert.equal(v.ok, false)
  assert.equal(v.reason, "unparseable_status")
})

test("probeAuth surfaces the CLI exit code when output is not JSON", () => {
  const spawn = () => ({ status: 7, stdout: "", stderr: "boom" })
  assert.equal(probeAuth(["agent", "status"], { spawn }).reason, "status_exit_7")
})

test("probeAuth passes a real authenticated payload", () => {
  const spawn = () => ({
    status: 0,
    stdout: JSON.stringify({ status: "authenticated", isAuthenticated: true }),
    stderr: "",
  })
  assert.equal(probeAuth(["agent", "status"], { spawn }).ok, true)
})

test("probeAuth never throws when the spawn implementation throws", () => {
  const spawn = () => { throw new Error("kaput") }
  const v = probeAuth(["agent", "status"], { spawn })
  assert.equal(v.ok, false)
  assert.match(v.reason, /^probe_failed:/)
})

// --- dedupe ---------------------------------------------------------------

test("first failure is recorded", () => {
  const { record, state } = nextAuthState(null, { ok: false, reason: "unauthenticated" })
  assert.equal(record, true)
  assert.equal(state.state, "unauthenticated")
})

test("repeated identical failures are not re-recorded", () => {
  const first = nextAuthState(null, { ok: false, reason: "unauthenticated" })
  const second = nextAuthState(first.states, { ok: false, reason: "unauthenticated" })
  const third = nextAuthState(second.states, { ok: false, reason: "unauthenticated" })
  assert.equal(second.record, false)
  assert.equal(third.record, false)
})

test("a changed reason is recorded again", () => {
  const first = nextAuthState(null, { ok: false, reason: "unauthenticated" })
  const second = nextAuthState(first.states, { ok: false, reason: "binary_missing" })
  assert.equal(second.record, true)
  assert.equal(second.state.reason, "binary_missing")
})

test("success clears state without recording", () => {
  const first = nextAuthState(null, { ok: false, reason: "unauthenticated" })
  const ok = nextAuthState(first.states, { ok: true, source: "env" })
  assert.equal(ok.record, false)
  assert.equal(ok.state.state, "ok")
})

test("a lapse after recovery is recorded again", () => {
  const fail = nextAuthState(null, { ok: false, reason: "unauthenticated" })
  const ok = nextAuthState(fail.states, { ok: true })
  const lapse = nextAuthState(ok.states, { ok: false, reason: "unauthenticated" })
  assert.equal(lapse.record, true)
})

test("each surface records its own first failure", () => {
  // The watcher and the curator both fail for the same reason. Sharing one entry
  // would let whichever runs second inherit the first one's silence.
  const watcher = nextAuthState(null, { ok: false, reason: "unauthenticated" }, new Date(), "cursor")
  const curator = nextAuthState(watcher.states, { ok: false, reason: "unauthenticated" }, new Date(), "curator")
  assert.equal(watcher.record, true)
  assert.equal(curator.record, true)
  assert.equal(curator.states.cursor.state, "unauthenticated")
  assert.equal(curator.states.curator.state, "unauthenticated")
})

test("alternating surfaces do not ping-pong new entries", () => {
  let states = null
  let records = 0
  for (let i = 0; i < 6; i++) {
    const scope = i % 2 === 0 ? "cursor" : "curator"
    const r = nextAuthState(states, { ok: false, reason: "unauthenticated" }, new Date(), scope)
    if (r.record) records++
    states = r.states
  }
  assert.equal(records, 2) // one per surface, then silence
})

test("state round-trips through disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "al-auth-"))
  const file = join(dir, "nested", ".auth_state.json")
  assert.equal(readAuthState(file), null)
  const { states } = nextAuthState(null, { ok: false, reason: "unauthenticated" })
  writeAuthState(states, file)
  const back = readAuthState(file)
  assert.equal(back.cursor.state, "unauthenticated")
  assert.equal(JSON.parse(readFileSync(file, "utf8")).cursor.reason, "unauthenticated")
})

test("corrupt state file degrades to null instead of throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "al-auth-"))
  const file = join(dir, ".auth_state.json")
  writeFileSync(file, "{not json")
  assert.equal(readAuthState(file), null)
})
