/**
 * Tests for the pipeline staleness check in plugin/autolearn-schedule.mjs.
 *
 * Run: node --test plugin/test-schedule-health.mjs
 *
 * The check reads the observation log's retained tail, so these tests build
 * synthetic logs rather than touching the live store.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { checkPipelineHealth } from "./autolearn-schedule.mjs"

const HOUR = 3600 * 1000

function store(lines) {
  const dir = mkdtempSync(join(tmpdir(), "al-health-"))
  const file = join(dir, "observations.jsonl")
  writeFileSync(file, lines.map(l => JSON.stringify(l)).join("\n") + "\n")
  return file
}

function iso(ms) {
  return new Date(ms).toISOString()
}

test("healthy pipeline is not stale", () => {
  const now = Date.parse("2026-10-26T12:00:00Z")
  const file = store([
    { type: "review_spawned", timestamp: iso(now - 2 * HOUR) },
    { type: "review_complete", timestamp: iso(now - 1 * HOUR) },
  ])
  const h = checkPipelineHealth({ obsFile: file, now })
  assert.equal(h.stale, false)
  assert.equal(h.spawned, 1)
  assert.equal(h.completed, 1)
})

test("spawns with no completion are stale", () => {
  const now = Date.parse("2026-10-26T12:00:00Z")
  const obs = []
  for (let i = 1; i <= 5; i++) obs.push({ type: "spawn", message_count: i })
  const lines = obs.map((_, i) => ({ type: "review_spawned", timestamp: iso(now - (10 - i) * HOUR) }))
  const h = checkPipelineHealth({ obsFile: store(lines), now })
  assert.equal(h.stale, true)
  assert.equal(h.reason, "no_completion_in_window")
  assert.equal(h.spawned, 5)
  assert.equal(h.completed, 0)
})

test("spawns after a completion go stale only past the window", () => {
  const now = Date.parse("2026-10-26T12:00:00Z")
  // Completed 10h ago, spawned 9h ago -> inside a 48h window, so healthy.
  const inside = checkPipelineHealth({
    obsFile: store([
      { type: "review_complete", timestamp: iso(now - 10 * HOUR) },
      { type: "review_spawned", timestamp: iso(now - 9 * HOUR) },
    ]),
    now,
  })
  assert.equal(inside.stale, false)

  // Completed 72h ago -> outside the 48h window, so stale.
  const outside = checkPipelineHealth({
    obsFile: store([
      { type: "review_complete", timestamp: iso(now - 72 * HOUR) },
      { type: "review_spawned", timestamp: iso(now - 1 * HOUR) },
    ]),
    now,
  })
  assert.equal(outside.stale, true)
  assert.equal(outside.reason, "spawns_outrun_completions")
})

test("window is configurable", () => {
  const now = Date.parse("2026-10-26T12:00:00Z")
  const file = store([
    { type: "review_complete", timestamp: iso(now - 10 * HOUR) },
    { type: "review_spawned", timestamp: iso(now - 9 * HOUR) },
  ])
  assert.equal(checkPipelineHealth({ obsFile: file, now, staleAfterMs: 48 * HOUR }).stale, false)
  assert.equal(checkPipelineHealth({ obsFile: file, now, staleAfterMs: 4 * HOUR }).stale, true)
})

test("no spawns in the window is reported but not stale", () => {
  const now = Date.parse("2026-10-26T12:00:00Z")
  const h = checkPipelineHealth({
    obsFile: store([{ type: "review_complete", timestamp: iso(now - 500 * HOUR) }]),
    now,
  })
  assert.equal(h.stale, false)
  assert.equal(h.reason, "no_spawns_in_window")
})

test("a missing observation log does not throw", () => {
  const h = checkPipelineHealth({ obsFile: join(tmpdir(), "definitely-absent-al.jsonl") })
  assert.equal(h.stale, false)
  assert.equal(h.reason, "no_observation_log")
})

test("corrupt lines are skipped", () => {
  const now = Date.parse("2026-10-26T12:00:00Z")
  const dir = mkdtempSync(join(tmpdir(), "al-health-"))
  const file = join(dir, "observations.jsonl")
  writeFileSync(file, [
    "{not json",
    JSON.stringify({ type: "review_spawned", timestamp: iso(now - 2 * HOUR) }),
    "",
    JSON.stringify({ type: "review_complete", timestamp: iso(now - 1 * HOUR) }),
  ].join("\n"))
  const h = checkPipelineHealth({ obsFile: file, now })
  assert.equal(h.stale, false)
  assert.equal(h.spawned, 1)
})
