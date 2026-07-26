import { randomUUID } from "node:crypto";
import type { EventKind, NormalizedEvent, ProviderId } from "../domain.ts";

export function event(
  provider: ProviderId,
  kind: EventKind,
  fields: {
    sessionId?: string | null;
    turnId?: string | null;
    payload?: Record<string, unknown>;
    rawVersion?: string | null;
  } = {},
): NormalizedEvent {
  return {
    event_id: randomUUID(),
    provider,
    session_id: fields.sessionId ?? null,
    turn_id: fields.turnId ?? null,
    timestamp: new Date().toISOString(),
    kind,
    payload: fields.payload ?? {},
    raw_version: fields.rawVersion ?? null,
  };
}
