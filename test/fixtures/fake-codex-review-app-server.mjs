import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
let activeTurn = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function completeReview(turnId, status = "completed") {
  send({ method: "turn/completed", params: { threadId: "fake-thread", turn: { id: turnId, status } } });
  activeTurn = null;
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake-codex-review/1.0" } });
    return;
  }
  if (message.method === "thread/start") {
    if (message.params?.sandbox !== "read-only" || message.params?.approvalPolicy !== "untrusted") {
      send({ id: message.id, error: { code: -32602, message: "thread must be read-only" } });
      return;
    }
    send({ id: message.id, result: { thread: { id: "fake-thread" }, model: "fake-model", modelProvider: "fake" } });
    return;
  }
  if (message.method === "review/start") {
    const instructions = message.params?.target?.instructions;
    if (
      message.params?.threadId !== "fake-thread" ||
      message.params?.delivery !== "inline" ||
      message.params?.target?.type !== "custom" ||
      typeof instructions !== "string" ||
      Object.hasOwn(message.params, "sandboxPolicy")
    ) {
      send({ id: message.id, error: { code: -32602, message: "malformed review/start" } });
      return;
    }
    const turnId = instructions.includes("hold-native-review")
      ? "fake-review-hold"
      : instructions.includes("early-native-review")
        ? "fake-review-early"
      : instructions.includes("approval-native-review")
        ? "fake-review-approval"
        : "fake-review-turn";
    activeTurn = turnId;
    if (turnId === "fake-review-early") {
      send({ method: "turn/started", params: { threadId: "fake-thread", turn: { id: turnId, status: "inProgress" } } });
    }
    send({ id: message.id, result: { reviewThreadId: "fake-thread", turn: { id: turnId, status: "inProgress" } } });
    setImmediate(() => {
      if (turnId !== "fake-review-early") {
        send({ method: "turn/started", params: { threadId: "fake-thread", turn: { id: turnId, status: "inProgress" } } });
      }
      if (turnId === "fake-review-hold") return;
      if (turnId === "fake-review-approval") {
        send({
          id: "native-review-approval",
          method: "item/fileChange/requestApproval",
          params: {
            threadId: "fake-thread",
            turnId,
            itemId: "fake-file-change",
            reason: "native review must remain read-only",
          },
        });
        return;
      }
      send({
        method: "item/agentMessage/delta",
        params: {
          threadId: "fake-thread",
          turnId,
          itemId: "fake-message",
          delta: '<<<SPLITLANE_FINDINGS_V1>>>\n{"findings":[]}\n<<<END_SPLITLANE_FINDINGS_V1>>>',
        },
      });
      completeReview(turnId);
    });
    return;
  }
  if (message.method === "turn/interrupt") {
    if (message.params?.threadId !== "fake-thread" || message.params?.turnId !== activeTurn) {
      send({ id: message.id, error: { code: -32602, message: "wrong review turn" } });
      return;
    }
    send({ id: message.id, result: {} });
    setImmediate(() => completeReview(message.params.turnId, "interrupted"));
    return;
  }
  if (message.id === "native-review-approval" && message.result?.decision === "decline") {
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: "fake-thread",
        turnId: activeTurn,
        itemId: "fake-message",
        delta: '<<<SPLITLANE_FINDINGS_V1>>>\n{"findings":[]}\n<<<END_SPLITLANE_FINDINGS_V1>>>',
      },
    });
    completeReview(activeTurn);
  }
});

process.on("SIGTERM", () => process.exit(0));
