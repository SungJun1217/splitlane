import assert from "node:assert/strict";
import test from "node:test";
import { cancelLane, dispatchPrompt } from "../spike/lib/dispatch.mjs";
import { applyNormalizedEvent, LaneTurnState } from "../spike/lib/lane-state.mjs";

class FakeLane {
  constructor(provider, { busy = false, startError = null } = {}) {
    this.provider = provider;
    this.busy = busy;
    this.startError = startError;
    this.started = [];
    this.released = [];
    this.interrupts = 0;
  }

  reserve(envelopeId) {
    if (this.busy) throw new Error(`${this.provider} lane is busy`);
    this.busy = true;
    return `${this.provider}:${envelopeId}`;
  }

  release(reservation) {
    this.busy = false;
    this.released.push(reservation);
  }

  async start(envelope, reservation) {
    this.started.push({ envelope, reservation });
    if (this.startError) throw this.startError;
    return { provider: this.provider };
  }

  async interrupt() {
    this.interrupts += 1;
    return { provider: this.provider, interrupted: true };
  }
}

test("broadcast preflight is atomic when either lane is busy", async () => {
  const claude = new FakeLane("claude");
  const codex = new FakeLane("codex", { busy: true });
  const result = await dispatchPrompt({ target: "both", prompt: "compare", lanes: { claude, codex } });

  assert.equal(result.accepted, false);
  assert.deepEqual(result.choices, ["wait", "send_available_only_with_confirmation", "cancel"]);
  assert.equal(claude.started.length, 0);
  assert.equal(codex.started.length, 0);
  assert.equal(claude.busy, false);
  assert.equal(claude.released.length, 1);
});

test("broadcast sends the same immutable prompt envelope to both lanes", async () => {
  const claude = new FakeLane("claude");
  const codex = new FakeLane("codex");
  const result = await dispatchPrompt({
    target: "both",
    prompt: "same prompt",
    lanes: { claude, codex },
    now: () => new Date("2026-07-26T00:00:00.000Z"),
    idFactory: () => "envelope-1",
  });

  assert.equal(result.accepted, true);
  assert.equal(claude.started[0].envelope, codex.started[0].envelope);
  assert.equal(Object.isFrozen(result.envelope), true);
  assert.deepEqual(Object.keys(result.outcomes), ["claude", "codex"]);
});

test("a provider start failure is reported without cancelling the other lane", async () => {
  const claude = new FakeLane("claude", { startError: new Error("claude startup failed") });
  const codex = new FakeLane("codex");
  const result = await dispatchPrompt({ target: "both", prompt: "compare", lanes: { claude, codex } });

  assert.equal(result.accepted, true);
  assert.equal(result.outcomes.claude.status, "failed");
  assert.equal(result.outcomes.codex.status, "started");
  assert.equal(codex.interrupts, 0);
});

test("cancelling one lane never interrupts the other", async () => {
  const claude = new FakeLane("claude");
  const codex = new FakeLane("codex");
  await cancelLane("claude", { claude, codex });
  assert.equal(claude.interrupts, 1);
  assert.equal(codex.interrupts, 0);
});

test("lane state rejects cross-provider events and illegal transitions", () => {
  const lane = new LaneTurnState("claude");
  lane.transition("STARTING");
  assert.deepEqual(applyNormalizedEvent(lane, { provider: "claude", kind: "turn.started" }), {
    applied: true,
    state: "RUNNING",
  });
  assert.throws(
    () => applyNormalizedEvent(lane, { provider: "codex", kind: "turn.failed" }),
    /Cross-lane event rejected/,
  );
  assert.throws(() => lane.transition("READY"), /Illegal claude lane transition/);
});

test("unknown diagnostic events do not guess a lane transition", () => {
  const lane = new LaneTurnState("codex");
  const result = applyNormalizedEvent(lane, { provider: "codex", kind: "provider.future_event" });
  assert.deepEqual(result, { applied: false, state: "READY" });
});
