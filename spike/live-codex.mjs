#!/usr/bin/env node
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonlRpcProcess } from "./lib/jsonl-rpc.mjs";
import { redactOpaqueIds, sanitizeTerminalText } from "./lib/sanitize.mjs";

const CONSENT_FLAG = "--i-understand-this-starts-model-turns";

if (!process.argv.includes(CONSENT_FLAG)) {
  process.stderr.write(`Refusing live run without ${CONSENT_FLAG}\n`);
  process.exit(2);
}

async function openServer() {
  const rpc = new JsonlRpcProcess("codex", ["app-server", "--stdio"]);
  await rpc.start();
  const initialized = await rpc.request("initialize", {
    clientInfo: {
      name: "splitlane-protocol-spike",
      title: "Splitlane Protocol Spike",
      version: "0.0.0",
    },
    capabilities: { experimentalApi: false },
  });
  rpc.notify("initialized", {});
  return { rpc, initialized };
}

async function startThread(rpc, cwd, options = {}) {
  return rpc.request("thread/start", {
    cwd,
    sandbox: "read-only",
    approvalPolicy: "never",
    ephemeral: false,
    ...options,
  });
}

async function startTurn(rpc, threadId, text, overrides = {}) {
  const notificationOffset = rpc.notifications.length;
  const response = await rpc.request("turn/start", {
    threadId,
    input: [{ type: "text", text }],
    ...overrides,
  });
  return { response, notificationOffset };
}

async function waitForTurnCompletion(rpc, threadId, turnId, timeoutMs = 90_000) {
  return rpc.waitForMessage(
    (message) =>
      message.method === "turn/completed" &&
      message.params?.threadId === threadId &&
      message.params?.turn?.id === turnId,
    timeoutMs,
  );
}

function summarizeTurn(rpc, offset, completion) {
  const messages = rpc.notifications.slice(offset);
  const text = messages
    .filter((message) => message.method === "item/agentMessage/delta")
    .map((message) => message.params?.delta ?? "")
    .join("");
  return {
    event_methods: [...new Set(messages.map((message) => message.method))],
    event_count: messages.length,
    item_types: [
      ...new Set(
        messages
          .filter((message) => message.method === "item/started" || message.method === "item/completed")
          .map((message) => message.params?.item?.type)
          .filter(Boolean),
      ),
    ],
    status: completion.params?.turn?.status ?? null,
    text: sanitizeTerminalText(text) || null,
  };
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "splitlane-live-codex-"));
let firstRpc;
let resumedRpc;
let threadId;
let approvalThreadId;
try {
  const firstConnection = await openServer();
  firstRpc = firstConnection.rpc;
  const thread = await startThread(firstRpc, tempRoot);
  threadId = thread.thread.id;
  const firstTurn = await startTurn(
    firstRpc,
    threadId,
    "Reply with exactly SPLITLANE_CODEX_OK. Do not use tools.",
  );
  const firstCompletion = await waitForTurnCompletion(
    firstRpc,
    threadId,
    firstTurn.response.turn.id,
  );
  const firstSummary = summarizeTurn(firstRpc, firstTurn.notificationOffset, firstCompletion);
  await firstRpc.close();
  firstRpc = null;

  const resumedConnection = await openServer();
  resumedRpc = resumedConnection.rpc;
  const resumedThread = await resumedRpc.request("thread/resume", {
    threadId,
    cwd: tempRoot,
    sandbox: "read-only",
    approvalPolicy: "never",
    model: thread.model,
  });
  const resumedTurn = await startTurn(
    resumedRpc,
    threadId,
    "Reply with exactly SPLITLANE_CODEX_RESUMED. Do not use tools.",
  );
  const resumedCompletion = await waitForTurnCompletion(
    resumedRpc,
    threadId,
    resumedTurn.response.turn.id,
  );
  const resumedSummary = summarizeTurn(
    resumedRpc,
    resumedTurn.notificationOffset,
    resumedCompletion,
  );

  const interruptTurn = await startTurn(
    resumedRpc,
    threadId,
    "Write twenty numbered one-sentence observations about safe process cancellation.",
  );
  await resumedRpc.waitForMessage(
    (message) =>
      message.method === "turn/started" &&
      message.params?.turn?.id === interruptTurn.response.turn.id,
  );
  const interruptResponse = await resumedRpc.request("turn/interrupt", {
    threadId,
    turnId: interruptTurn.response.turn.id,
  });
  const interruptCompletion = await waitForTurnCompletion(
    resumedRpc,
    threadId,
    interruptTurn.response.turn.id,
  );
  const interruptMethods = [
    ...new Set(
      resumedRpc.notifications
        .slice(interruptTurn.notificationOffset)
        .map((message) => message.method),
    ),
  ];

  const approvalThread = await startThread(resumedRpc, tempRoot, {
    approvalPolicy: "untrusted",
    ephemeral: true,
  });
  approvalThreadId = approvalThread.thread.id;
  const proofPath = path.join(tempRoot, "approval-proof.txt");
  const approvalTurn = await startTurn(
    resumedRpc,
    approvalThreadId,
    "Use the shell to run exactly: touch approval-proof.txt. Do not use another tool and do not answer before attempting the command.",
  );
  const approvalWaitAbort = new AbortController();
  const approvalRequestPromise = resumedRpc.waitForMessage(
    (message) =>
      Object.hasOwn(message, "id") &&
      [
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
      ].includes(message.method) &&
      message.params?.threadId === approvalThreadId,
    60_000,
    approvalWaitAbort.signal,
  );
  const approvalCompletionPromise = waitForTurnCompletion(
    resumedRpc,
    approvalThreadId,
    approvalTurn.response.turn.id,
    60_000,
  );
  let approvalRequest = null;
  let approvalResponseAccepted = false;
  let approvalCompletion;
  const approvalRace = await Promise.race([
    approvalRequestPromise.then((request) => ({ type: "request", request })),
    approvalCompletionPromise.then((completion) => ({ type: "completion", completion })),
  ]);
  if (approvalRace.type === "request") {
    approvalRequest = approvalRace.request;
    resumedRpc.respond(approvalRequest.id, { decision: "cancel" });
    approvalResponseAccepted = true;
    approvalCompletion = await approvalCompletionPromise;
  } else {
    approvalWaitAbort.abort();
    await approvalRequestPromise.catch(() => {});
    approvalCompletion = approvalRace.completion;
  }

  let archiveOk = false;
  try {
    await resumedRpc.request("thread/archive", { threadId });
    archiveOk = true;
  } catch {
    archiveOk = false;
  }

  const report = {
    schema_version: 1,
    provider: "codex",
    captured_at: new Date().toISOString(),
    cli_version: "0.145.0",
    model_turns_started: 4,
    initialize: {
      ok: true,
      platform_family: firstConnection.initialized.platformFamily,
      platform_os: firstConnection.initialized.platformOs,
    },
    first: {
      ...firstSummary,
      thread_id_present: typeof threadId === "string",
      effective_model: thread.model,
      model_provider: thread.modelProvider,
      sandbox: thread.sandbox,
      approval_policy: thread.approvalPolicy,
    },
    resumed: {
      ...resumedSummary,
      thread_id_matches: resumedThread.thread?.id === threadId,
      requested_model: thread.model,
      effective_model: resumedThread.model,
    },
    interrupted: {
      response_received: interruptResponse != null,
      completion_status: interruptCompletion.params?.turn?.status ?? null,
      event_methods: interruptMethods,
    },
    approval: {
      request_emitted: Boolean(approvalRequest),
      request_method: approvalRequest?.method ?? null,
      request_id_present: approvalRequest ? Object.hasOwn(approvalRequest, "id") : false,
      response_decision: approvalRequest ? "cancel" : null,
      response_accepted: approvalResponseAccepted,
      completion_status: approvalCompletion.params?.turn?.status ?? null,
      file_created: await fileExists(proofPath),
    },
    cleanup: {
      persistent_thread_archived: archiveOk,
      ephemeral_approval_thread: approvalThread.thread?.ephemeral === true,
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${redactOpaqueIds(sanitizeTerminalText(error.stack ?? error.message))}\n`);
  process.exitCode = 1;
} finally {
  await firstRpc?.close();
  await resumedRpc?.close();
  await rm(tempRoot, { recursive: true, force: true });
}
