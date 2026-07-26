const TRANSITIONS = Object.freeze({
  UNAVAILABLE: new Set(),
  READY: new Set(["STARTING"]),
  STARTING: new Set(["RUNNING", "FAILED", "CANCELLED"]),
  RUNNING: new Set(["BLOCKED_ON_APPROVAL", "CANCELLING", "COMPLETED", "FAILED"]),
  BLOCKED_ON_APPROVAL: new Set(["RUNNING", "CANCELLING", "FAILED"]),
  CANCELLING: new Set(["CANCELLED", "FAILED"]),
  COMPLETED: new Set(["READY"]),
  FAILED: new Set(["READY"]),
  CANCELLED: new Set(["READY"]),
});

export class LaneTurnState {
  constructor(provider, initial = "READY") {
    if (!TRANSITIONS[initial]) throw new Error(`Unknown lane state: ${initial}`);
    this.provider = provider;
    this.current = initial;
  }

  transition(next) {
    if (!TRANSITIONS[next]) throw new Error(`Unknown lane state: ${next}`);
    if (!TRANSITIONS[this.current].has(next)) {
      throw new Error(`Illegal ${this.provider} lane transition: ${this.current} -> ${next}`);
    }
    this.current = next;
    return this.current;
  }
}

const EVENT_TRANSITIONS = Object.freeze({
  "turn.started": "RUNNING",
  "approval.requested": "BLOCKED_ON_APPROVAL",
  "approval.resolved": "RUNNING",
  "turn.completed": "COMPLETED",
  "turn.failed": "FAILED",
  "turn.cancelled": "CANCELLED",
});

export function applyNormalizedEvent(lane, event) {
  if (event.provider !== lane.provider) {
    throw new Error(`Cross-lane event rejected: ${event.provider} -> ${lane.provider}`);
  }
  const next = EVENT_TRANSITIONS[event.kind];
  if (!next) return { applied: false, state: lane.current };
  return { applied: true, state: lane.transition(next) };
}
