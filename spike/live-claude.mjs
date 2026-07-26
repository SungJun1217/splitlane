#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { terminateProcessGroup } from "./lib/process-group.mjs";
import { redactOpaqueIds, sanitizeProviderIdentifier, sanitizeTerminalText } from "./lib/sanitize.mjs";

const CONSENT_FLAG = "--i-understand-this-starts-model-turns";

if (!process.argv.includes(CONSENT_FLAG)) {
  process.stderr.write(`Refusing live run without ${CONSENT_FLAG}\n`);
  process.exit(2);
}

function baseArgs() {
  return [
    "--print",
    "--verbose",
    "--safe-mode",
    "--no-chrome",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
  ];
}

async function runClaude({ cwd, args, inputMessage, stopWhen, timeoutMs = 90_000 }) {
  const child = spawn("claude", args, {
    cwd,
    detached: process.platform !== "win32",
    stdio: [inputMessage ? "pipe" : "ignore", "pipe", "pipe"],
  });
  const messages = [];
  let stderr = "";
  let forcedStop = null;
  const lines = readline.createInterface({ input: child.stdout });

  child.stderr.on("data", (chunk) => {
    stderr = (stderr + sanitizeTerminalText(chunk.toString("utf8"))).slice(-32_000);
  });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      messages.push(message);
      if (messages.length > 2_000) messages.shift();
      if (!forcedStop && stopWhen?.(message, messages)) {
        forcedStop = terminateProcessGroup(child, { graceMs: 500, killWaitMs: 2_000 });
      }
    } catch {
      messages.push({ type: "diagnostic", malformed: sanitizeTerminalText(line) });
    }
  });

  if (inputMessage) {
    child.stdin.write(`${JSON.stringify(inputMessage)}\n`);
  }

  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  const timeout = setTimeout(() => {
    if (!forcedStop) forcedStop = terminateProcessGroup(child, { graceMs: 500, killWaitMs: 2_000 });
  }, timeoutMs);
  const outcome = await closed;
  clearTimeout(timeout);
  lines.close();
  if (forcedStop) await forcedStop;
  return { messages, stderr: redactOpaqueIds(stderr), ...outcome };
}

function summarizeTurn(run, expectedSessionId) {
  const init = run.messages.find((message) => message.type === "system" && message.subtype === "init");
  const result = run.messages.findLast((message) => message.type === "result");
  const deltaText = run.messages
    .filter((message) => message.type === "stream_event" && message.event?.type === "content_block_delta")
    .map((message) => message.event?.delta?.text ?? "")
    .join("");
  return {
    event_types: [...new Set(run.messages.map((message) => `${message.type}:${message.subtype ?? message.event?.type ?? ""}`))],
    event_count: run.messages.length,
    effective_model: init?.model ? sanitizeProviderIdentifier(init.model) : null,
    session_id_present: typeof init?.session_id === "string",
    session_id_matches: init?.session_id === expectedSessionId,
    result_subtype: result?.subtype ?? null,
    is_error: result?.is_error ?? null,
    duration_ms: result?.duration_ms ?? null,
    num_turns: result?.num_turns ?? null,
    text: deltaText || result?.result || null,
    exit_code: run.exitCode,
    signal: run.signal,
  };
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "splitlane-live-claude-"));
try {
  const sessionId = randomUUID();
  const first = await runClaude({
    cwd: tempRoot,
    args: [
      ...baseArgs(),
      "--permission-mode",
      "plan",
      "--tools",
      "",
      "--session-id",
      sessionId,
      "Reply with exactly SPLITLANE_CLAUDE_OK. Do not use tools.",
    ],
  });
  const firstSummary = summarizeTurn(first, sessionId);

  const resumed = await runClaude({
    cwd: tempRoot,
    args: [
      ...baseArgs(),
      "--permission-mode",
      "plan",
      "--tools",
      "",
      "--resume",
      sessionId,
      "Reply with exactly SPLITLANE_CLAUDE_RESUMED. Do not use tools.",
    ],
  });

  const interrupted = await runClaude({
    cwd: tempRoot,
    args: [
      ...baseArgs(),
      "--permission-mode",
      "plan",
      "--tools",
      "",
      "--session-id",
      randomUUID(),
      "Write ten numbered one-sentence observations about safe process cancellation.",
    ],
    stopWhen: (message) => message.type === "stream_event" && message.event?.type === "message_start",
  });

  const approval = await runClaude({
    cwd: tempRoot,
    args: [
      ...baseArgs(),
      "--input-format",
      "stream-json",
      "--replay-user-messages",
      "--permission-mode",
      "manual",
      "--tools",
      "Bash",
    ],
    inputMessage: {
      type: "user",
      message: {
        role: "user",
        content: "Use Bash to run: printf SPLITLANE_APPROVAL_SHOULD_NOT_RUN. Do not answer before attempting the command.",
      },
    },
    stopWhen: (message) => message.type === "control_request" && message.request?.subtype === "can_use_tool",
    timeoutMs: 45_000,
  });
  const approvalRequest = approval.messages.find(
    (message) => message.type === "control_request" && message.request?.subtype === "can_use_tool",
  );

  const report = {
    schema_version: 1,
    provider: "claude",
    captured_at: new Date().toISOString(),
    cli_version: "2.1.220",
    model_turns_started: 4,
    first: firstSummary,
    resumed: summarizeTurn(resumed, sessionId),
    interrupted: {
      stream_started: interrupted.messages.some(
        (message) => message.type === "stream_event" && message.event?.type === "message_start",
      ),
      result_emitted: interrupted.messages.some((message) => message.type === "result"),
      exit_code: interrupted.exitCode,
      signal: interrupted.signal,
    },
    approval: {
      request_emitted: Boolean(approvalRequest),
      request_subtype: approvalRequest?.request?.subtype ?? null,
      tool_name: approvalRequest?.request?.tool_name ?? null,
      request_id_present: typeof approvalRequest?.request_id === "string",
      response_proven: false,
      blocker: "Raw CLI control_response is not used because its wire shape is not a documented public contract; use the official Agent SDK canUseTool callback candidate.",
      tool_result_emitted: approval.messages.some((message) =>
        JSON.stringify(message).includes("tool_result"),
      ),
      exit_code: approval.exitCode,
      signal: approval.signal,
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
