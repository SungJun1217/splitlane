#!/usr/bin/env node
import { access, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runCommand } from "./lib/run-command.mjs";
import { redactOpaqueIds, sanitizeProviderIdentifier, sanitizeTerminalText } from "./lib/sanitize.mjs";

const CONSENT_FLAG = "--i-understand-this-starts-model-turns";
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk@0.3.220";

if (!process.argv.includes(CONSENT_FLAG)) {
  process.stderr.write(`Refusing live run without ${CONSENT_FLAG}\n`);
  process.exit(2);
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const installRoot = await mkdtemp(path.join(os.tmpdir(), "splitlane-claude-sdk-"));
const workspace = await mkdtemp(path.join(os.tmpdir(), "splitlane-live-claude-sdk-workspace-"));
try {
  const installed = await runCommand(
    "npm",
    [
      "install",
      "--prefix",
      installRoot,
      "--no-audit",
      "--no-fund",
      "--save=false",
      SDK_PACKAGE,
    ],
    { timeoutMs: 60_000, maxOutput: 64_000 },
  );
  if (installed.exitCode !== 0) {
    throw new Error(`Temporary SDK install failed: ${sanitizeTerminalText(installed.stderr)}`);
  }

  const requireFromTemp = createRequire(path.join(installRoot, "package.json"));
  const sdkEntry = requireFromTemp.resolve("@anthropic-ai/claude-agent-sdk");
  const { query } = await import(pathToFileURL(sdkEntry));
  const proofPath = path.join(workspace, "approval-sdk-proof.txt");
  const messages = [];
  const callbacks = [];

  for await (const message of query({
    prompt:
      "Use Bash to run exactly: touch approval-sdk-proof.txt. Do not use another tool and do not answer before attempting the command.",
    options: {
      cwd: workspace,
      tools: ["Bash"],
      permissionMode: "default",
      settingSources: [],
      maxTurns: 2,
      canUseTool: async (toolName, input, context) => {
        callbacks.push({
          tool_name: toolName,
          input_keys: Object.keys(input).sort(),
          tool_use_id_present: typeof context?.toolUseID === "string",
          suggestions_present: Array.isArray(context?.suggestions),
        });
        return {
          behavior: "deny",
          message: "Denied by Splitlane M0 approval compatibility proof.",
        };
      },
    },
  })) {
    messages.push(message);
    if (messages.length > 2_000) messages.shift();
  }

  const init = messages.find((message) => message.type === "system" && message.subtype === "init");
  const result = messages.findLast((message) => message.type === "result");
  const report = {
    schema_version: 1,
    provider: "claude",
    transport: "official-agent-sdk",
    captured_at: new Date().toISOString(),
    sdk_version: "0.3.220",
    model_turns_started: 1,
    event_types: [
      ...new Set(messages.map((message) => `${message.type}:${message.subtype ?? ""}`)),
    ],
    effective_model: init?.model ? sanitizeProviderIdentifier(init.model) : null,
    session_id_present: typeof init?.session_id === "string",
    callback: callbacks[0] ?? null,
    callback_count: callbacks.length,
    response_decision: callbacks.length > 0 ? "deny" : null,
    result_subtype: result?.subtype ?? null,
    is_error: result?.is_error ?? null,
    file_created: await fileExists(proofPath),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${redactOpaqueIds(sanitizeTerminalText(error.stack ?? error.message))}\n`);
  process.exitCode = 1;
} finally {
  await rm(workspace, { recursive: true, force: true });
  await rm(installRoot, { recursive: true, force: true });
}
