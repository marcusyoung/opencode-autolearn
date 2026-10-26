/**
 * Autolearn — Cursor CLI authentication preflight.
 *
 * The reviewer and curator are detached `agent -p` children. Their auth comes
 * from the Cursor CLI, which autolearn neither owns nor controls: an expired
 * login, a CLI upgrade, or an `agent logout` kills every spawn silently, because
 * the windowless launcher discards the child's stderr and an orphaned review
 * file looks exactly like a completed one. On 2026-10-16 that happened and the
 * pipeline sat dead for ten days.
 *
 * This module answers one question before anything is written or spawned:
 * will `agent` authenticate? It never throws, never prints, and never stores a
 * credential — it only reports which source is live so the caller can fail loudly.
 *
 * Environment:
 *   CURSOR_API_KEY        - non-interactive credential; `agent` prefers it over
 *                           its login store, so it survives logouts and upgrades
 *   AUTOLEARN_AUTH_TIMEOUT_MS - probe timeout (default 15000)
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs"
import { dirname, join } from "path"
import { spawnSync } from "child_process"
import * as core from "./autolearn-core.mjs"

/** Persisted auth state, used to record one observation per distinct failure. */
export const AUTH_STATE_FILE = join(core.DEFAULT_PERSONA_DIR, "cursor", ".auth_state.json")

export const AUTH_TIMEOUT_MS = (() => {
  const raw = Number(process.env.AUTOLEARN_AUTH_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 15000
})()

/**
 * Shape returned by `agent status --format json`:
 *   { status, isAuthenticated, hasAccessToken, hasRefreshToken, message }
 * Only `isAuthenticated` is trusted; a missing/false value means "not usable".
 */
export function classifyAuthStatus(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, source: "unknown", reason: "unreadable_status" }
  }
  if (parsed.isAuthenticated === true) {
    return { ok: true, source: "login-store", reason: parsed.status || "authenticated" }
  }
  const reason = parsed.status || parsed.message || "unauthenticated"
  return { ok: false, source: "login-store", reason: String(reason) }
}

/**
 * CURSOR_API_KEY short-circuit. `agent` reads the env var itself, so a set key
 * is sufficient evidence of a working credential and costs no process spawn.
 * An empty or whitespace-only value is not a credential.
 */
export function shortCircuitFromEnv(env = process.env) {
  const key = typeof env.CURSOR_API_KEY === "string" ? env.CURSOR_API_KEY.trim() : ""
  if (key) return { ok: true, source: "env", reason: "CURSOR_API_KEY" }
  return null
}

export function cursorAuthArgv(bin) {
  return [bin, "status", "--format", "json"]
}

function quoteCmdArg(value) {
  const s = String(value)
  return /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Windows cannot spawn a `.cmd`/`.bat` shim directly (Node refuses with EINVAL,
 * and an extensionless name like `agent` resolves to `agent.cmd`). The reviewer
 * launcher already routes through a VBS/cmd shim for the same reason, so the
 * probe must do the equivalent or it reports a false `binary_missing` and blocks
 * a healthy pipeline.
 *
 * Returns { file, args } to hand to spawnSync.
 */
export function buildProbeCommand(argv, platform = process.platform, comspec = process.env.ComSpec || "cmd.exe") {
  if (platform !== "win32") return { file: argv[0], args: argv.slice(1) }
  const line = argv.map(quoteCmdArg).join(" ")
  return { file: comspec, args: ["/d", "/s", "/c", line] }
}

/**
 * Run the probe and classify the result. Never throws: a missing binary, a
 * non-zero exit, malformed JSON, or a timeout all degrade to `ok: false` with a
 * distinguishable `reason`, because "cannot determine auth" must block spawning
 * the same way "known unauthenticated" does.
 */
export function probeAuth(argv, opts = {}) {
  const { timeoutMs = AUTH_TIMEOUT_MS, spawn = spawnSync } = opts
  if (!Array.isArray(argv) || !argv.length || !argv[0]) {
    return { ok: false, source: "unknown", reason: "binary_missing", raw: "" }
  }
  let r
  try {
    const { file, args } = buildProbeCommand(argv, opts.platform, opts.comspec)
    r = spawn(file, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true })
  } catch (err) {
    return { ok: false, source: "unknown", reason: `probe_failed:${err.code || "error"}`, raw: "" }
  }
  const stdout = (r && r.stdout) || ""
  const stderr = (r && r.stderr) || ""
  if (r && r.error) {
    const code = r.error.code || "error"
    const reason = code === "ETIMEDOUT" ? "probe_timeout" : code === "ENOENT" ? "binary_missing" : `probe_failed:${code}`
    return { ok: false, source: "unknown", reason, raw: stderr }
  }
  let parsed = null
  try { parsed = JSON.parse(stdout.trim()) } catch {}
  if (!parsed) {
    // A CLI that cannot even report status is not usable, whatever its exit code.
    const reason = (r && r.status === 0) ? "unparseable_status" : `status_exit_${r ? r.status : "null"}`
    return { ok: false, source: "unknown", reason, raw: stdout || stderr }
  }
  const verdict = classifyAuthStatus(parsed)
  return { ...verdict, raw: stdout.trim() }
}

/**
 * Resolve the effective auth verdict for a Cursor harness binary.
 * Order matches `agent` itself: env credential first, then the login store.
 */
export function resolveAuth(bin, opts = {}) {
  const fromEnv = shortCircuitFromEnv(opts.env || process.env)
  if (fromEnv) return fromEnv
  return probeAuth(cursorAuthArgv(bin), opts)
}

// ---------------------------------------------------------------------------
// Dedupe: record a failure once per distinct state, not once per scan cycle
// ---------------------------------------------------------------------------

export function readAuthState(file = AUTH_STATE_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

export function writeAuthState(state, file = AUTH_STATE_FILE) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(state))
  } catch (err) {
    core.dbg("auth: state write failed", err.message)
  }
}

/**
 * Decide whether a failing probe should be recorded.
 *
 * A 5-minute watcher would otherwise append ~288 identical failures a day and
 * push every useful observation out of the 1000-line tail. So: record on the
 * transition into failure, and again only if the reason changes.
 *
 * `scope` (the surface that is failing, e.g. "cursor" or "curator") keys its own
 * entry in `prev`, so each surface records its own first failure instead of one
 * surface inheriting the other's silence — and neither overwrites the other,
 * which would otherwise make them re-record on every alternation.
 *
 * A success clears that scope's entry so the next lapse is recorded afresh.
 *
 * Returns { record, state, states } where `states` is the full map to persist.
 */
export function nextAuthState(prev, verdict, now = new Date(), scope = "cursor") {
  const at = now.toISOString()
  const states = { ...(prev && typeof prev === "object" ? prev : {}) }

  if (verdict && verdict.ok) {
    states[scope] = { state: "ok", source: verdict.source || "unknown", since: at }
    return { record: false, state: states[scope], states }
  }

  const reason = (verdict && verdict.reason) || "unknown"
  const prior = states[scope]
  if (prior && prior.state === "unauthenticated" && prior.reason === reason) {
    return { record: false, state: prior, states }
  }
  states[scope] = { state: "unauthenticated", source: (verdict && verdict.source) || "unknown", reason, since: at }
  return { record: true, state: states[scope], states }
}
