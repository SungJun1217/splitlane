import { randomUUID } from "node:crypto";

const TARGETS = Object.freeze({
  both: ["claude", "codex"],
  claude: ["claude"],
  codex: ["codex"],
});

function immutableEnvelope(prompt, now, idFactory) {
  if (typeof prompt !== "string" || prompt.trim() === "") {
    throw new Error("Prompt must be a non-empty string");
  }
  return Object.freeze({
    envelope_id: idFactory(),
    created_at: now().toISOString(),
    prompt,
  });
}

export async function dispatchPrompt({ target, prompt, lanes, now = () => new Date(), idFactory = randomUUID }) {
  const providers = TARGETS[target];
  if (!providers) throw new Error(`Unknown prompt target: ${target}`);
  const selected = providers.map((provider) => {
    const lane = lanes[provider];
    if (!lane) throw new Error(`Missing lane: ${provider}`);
    return lane;
  });
  const envelope = immutableEnvelope(prompt, now, idFactory);
  const reservations = [];

  try {
    for (const lane of selected) {
      reservations.push({ lane, reservation: lane.reserve(envelope.envelope_id) });
    }
  } catch (error) {
    for (const { lane, reservation } of reservations) lane.release(reservation);
    return {
      accepted: false,
      atomic: true,
      reason: error.message,
      choices: target === "both" ? ["wait", "send_available_only_with_confirmation", "cancel"] : ["wait", "cancel"],
      outcomes: {},
    };
  }

  const settled = await Promise.allSettled(
    reservations.map(({ lane, reservation }) => lane.start(envelope, reservation)),
  );
  const outcomes = Object.fromEntries(
    settled.map((result, index) => {
      const provider = providers[index];
      return result.status === "fulfilled"
        ? [provider, { status: "started", value: result.value }]
        : [provider, { status: "failed", error: result.reason?.message ?? String(result.reason) }];
    }),
  );
  return { accepted: true, atomic: true, envelope, outcomes };
}

export async function cancelLane(provider, lanes) {
  const lane = lanes[provider];
  if (!lane) throw new Error(`Missing lane: ${provider}`);
  return lane.interrupt();
}
