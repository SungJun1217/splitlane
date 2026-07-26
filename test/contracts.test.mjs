import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = async (relative) => JSON.parse(await readFile(path.join(root, relative), "utf8"));

test("normalized event schema contains every planned common event", async () => {
  const schema = await load("schemas/normalized-event.schema.json");
  const kinds = schema.properties.kind.enum;
  for (const kind of [
    "session.started",
    "session.resumed",
    "turn.started",
    "message.delta",
    "tool.started",
    "file.changed",
    "approval.requested",
    "turn.completed",
    "turn.failed",
    "turn.cancelled",
  ]) {
    assert.ok(kinds.includes(kind), `missing ${kind}`);
  }
  assert.equal(schema.additionalProperties, false);
});

test("capability schema distinguishes blocked from unavailable", async () => {
  const schema = await load("schemas/capability-manifest.schema.json");
  assert.deepEqual(schema.properties.availability.enum, ["available", "unavailable", "blocked"]);
  assert.equal(schema.additionalProperties, false);
});

test("role evaluation cases are opt-in and cover all initial roles", async () => {
  const evaluation = await load("evaluation/role-profile.cases.json");
  assert.equal(evaluation.requires_explicit_live_opt_in, true);
  assert.deepEqual(
    new Set(evaluation.cases.map(({ role }) => role)),
    new Set(["scout", "architect", "builder", "debugger", "intent_reviewer", "correctness_reviewer"]),
  );
});

test("captured app-server fixture is redacted and starts no model turn", async () => {
  const fixture = await load("test/fixtures/codex-app-server-initialize.redacted.json");
  const serialized = JSON.stringify(fixture);
  assert.equal(fixture.model_turn_started, false);
  assert.equal(fixture.response.result.codexHome, "<redacted>");
  assert.ok(!serialized.includes("/Users/"));
  assert.ok(!serialized.includes("@"));
});

test("ephemeral Codex thread fixture is read-only and records the resume limitation", async () => {
  const fixture = await load("test/fixtures/codex-ephemeral-thread.redacted.json");
  assert.equal(fixture.model_turn_started, false);
  assert.equal(fixture.request.params.ephemeral, true);
  assert.equal(fixture.request.params.sandbox, "read-only");
  assert.equal(fixture.result_summary.sandbox.networkAccess, false);
  assert.equal(fixture.resume_attempt.ok, false);
  assert.match(fixture.resume_attempt.error, /<opaque-id>/);
});

test("live compatibility fixtures contain no raw provider session IDs", async () => {
  for (const file of [
    "test/fixtures/claude-live-compatibility.redacted.json",
    "test/fixtures/claude-agent-sdk-approval.redacted.json",
    "test/fixtures/claude-sdk-stream.redacted.json",
    "test/fixtures/codex-live-compatibility.redacted.json",
    "test/fixtures/codex-app-server-stream.redacted.json",
    "test/fixtures/codex-m2-approvals.redacted.json",
    "test/fixtures/codex-m3-review-start.redacted.json",
    "test/fixtures/m1-live-gate-2026-07-26.redacted.json",
  ]) {
    const fixture = await load(file);
    const serialized = JSON.stringify(fixture);
    assert.ok(!serialized.includes("/Users/"));
    assert.ok(!serialized.includes("@"));
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(serialized));
  }
});

test("M1 live gate evidence records the cleanup correction and successful rerun", async () => {
  const fixture = await load("test/fixtures/m1-live-gate-2026-07-26.redacted.json");
  assert.equal(fixture.completed_compare_pairs, 10);
  assert.equal(fixture.workspace_unchanged, true);
  assert.equal(fixture.shutdown.child_present_in_follow_up_process_audit, false);
  assert.equal(fixture.shutdown.post_fix_live_rerun_completed, true);
  assert.equal(fixture.shutdown.post_fix_lingering_processes, 0);
  assert.equal(fixture.gate_status, "passed");
  assert.equal(fixture.session_ids_retained, false);
});
