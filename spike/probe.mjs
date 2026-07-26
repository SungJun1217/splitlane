#!/usr/bin/env node
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { detectClaudeCapabilities, detectCodexCapabilities } from "./lib/capabilities.mjs";
import { JsonlRpcProcess } from "./lib/jsonl-rpc.mjs";
import { runCommand } from "./lib/run-command.mjs";
import { parseClaudeAuth, parseCodexAuth, redactOpaqueIds, redactValue, sanitizeTerminalText } from "./lib/sanitize.mjs";

const clean = (result) => sanitizeTerminalText(result.stdout || result.stderr).trim();

async function loadEvidence(file, installedVersion) {
  try {
    const evidence = JSON.parse(await readFile(new URL(`../test/fixtures/${file}`, import.meta.url), "utf8"));
    if (!installedVersion.includes(evidence.cli_version)) return null;
    return evidence;
  } catch {
    return null;
  }
}

async function probeClaude() {
  const version = await runCommand("claude", ["--version"]);
  if (!version.available) return { provider: "claude", available: false, error: "binary not found", capabilities: [] };
  const [help, auth] = await Promise.all([
    runCommand("claude", ["--help"]),
    runCommand("claude", ["auth", "status"]),
  ]);
  const helpText = clean(help);
  const evidence = await loadEvidence("claude-live-compatibility.redacted.json", clean(version));
  let sdkEvidence = null;
  try {
    sdkEvidence = JSON.parse(
      await readFile(new URL("../test/fixtures/claude-agent-sdk-approval.redacted.json", import.meta.url), "utf8"),
    );
  } catch {}
  return {
    provider: "claude",
    available: true,
    version: clean(version),
    auth: parseClaudeAuth(auth.stdout),
    compatibility_evidence: evidence
      ? { captured_at: evidence.captured_at, cli_version: evidence.cli_version, sdk_version: sdkEvidence?.sdk_version ?? null }
      : null,
    capabilities: detectClaudeCapabilities(helpText, {
      resume: evidence?.resume?.same_session_id === true,
      interactiveApproval:
        sdkEvidence?.approval?.response_accepted === true && sdkEvidence?.approval?.file_created === false,
    }),
    diagnostics: auth.exitCode === 0 ? [] : ["authentication status probe failed"],
  };
}

async function probeCodexAppServer() {
  const rpc = new JsonlRpcProcess("codex", ["app-server", "--stdio"]);
  try {
    await rpc.start();
    const initialized = await rpc.request("initialize", {
      clientInfo: { name: "splitlane-protocol-spike", title: "Splitlane Protocol Spike", version: "0.0.0" },
      capabilities: { experimentalApi: false },
    });
    rpc.notify("initialized", {});
    const started = await rpc.request("thread/start", {
      cwd: process.cwd(),
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
    });
    let resume;
    try {
      await rpc.request("thread/resume", {
        threadId: started.thread.id,
        cwd: process.cwd(),
        sandbox: "read-only",
        approvalPolicy: "never",
      });
      resume = { ok: true };
    } catch (error) {
      resume = { ok: false, error: redactOpaqueIds(sanitizeTerminalText(error.message)) };
    }
    return {
      ok: true,
      initialize: redactValue(initialized),
      ephemeral_thread: {
        started: true,
        ephemeral: started.thread?.ephemeral === true,
        effective_model: started.model ?? null,
        model_provider: started.modelProvider ?? null,
        approval_policy: started.approvalPolicy ?? null,
        sandbox: started.sandbox ?? null,
        resume,
      },
      diagnostics: rpc.notifications.filter(({ method }) => method === "diagnostic/malformed"),
    };
  } catch (error) {
    return { ok: false, error: sanitizeTerminalText(error.message), stderr: redactValue(rpc.stderr) };
  } finally {
    await rpc.close();
  }
}

async function probeCodex() {
  const version = await runCommand("codex", ["--version"]);
  if (!version.available) return { provider: "codex", available: false, error: "binary not found", capabilities: [] };
  const [help, execHelp, reviewHelp, appServerHelp, auth] = await Promise.all([
    runCommand("codex", ["--help"]),
    runCommand("codex", ["exec", "--help"]),
    runCommand("codex", ["review", "--help"]),
    runCommand("codex", ["app-server", "--help"]),
    runCommand("codex", ["login", "status"]),
  ]);

  const schemaDir = await mkdtemp(path.join(os.tmpdir(), "splitlane-codex-schema-"));
  let schemaText = "";
  let schemaError = null;
  try {
    const generated = await runCommand("codex", ["app-server", "generate-json-schema", "--out", schemaDir], { timeoutMs: 10_000 });
    if (generated.exitCode !== 0) schemaError = clean(generated) || "schema generation failed";
    else {
      const [clientRequests, serverRequests] = await Promise.all([
        readFile(path.join(schemaDir, "ClientRequest.json"), "utf8"),
        readFile(path.join(schemaDir, "ServerRequest.json"), "utf8"),
      ]);
      schemaText = `${clientRequests}\n${serverRequests}`;
    }
  } catch (error) {
    schemaError = sanitizeTerminalText(error.message);
  } finally {
    await rm(schemaDir, { recursive: true, force: true });
  }

  const appServer = schemaText ? await probeCodexAppServer() : { ok: false, error: "schema unavailable" };
  const evidence = await loadEvidence("codex-live-compatibility.redacted.json", clean(version));
  return {
    provider: "codex",
    available: true,
    version: clean(version),
    auth: parseCodexAuth(auth.stdout || auth.stderr, auth.exitCode),
    app_server_initialize: appServer,
    compatibility_evidence: evidence
      ? { captured_at: evidence.captured_at, cli_version: evidence.cli_version }
      : null,
    capabilities: detectCodexCapabilities({
      help: clean(help),
      execHelp: clean(execHelp),
      reviewHelp: clean(reviewHelp),
      appServerHelp: clean(appServerHelp),
      schemaText,
      liveEvidence: {
        resume: evidence?.resume?.same_thread_id === true,
        interactiveApproval:
          evidence?.approval?.response_accepted === true && evidence?.approval?.file_created === false,
      },
    }),
    diagnostics: schemaError ? [schemaError] : [],
  };
}

const startedAt = new Date();
const [claude, codex] = await Promise.all([probeClaude(), probeCodex()]);
const report = redactValue({
  schema_version: 1,
  probe: "splitlane-m0-no-model-turn",
  started_at: startedAt.toISOString(),
  completed_at: new Date().toISOString(),
  safety: {
    model_turns_started: 0,
    bypass_flags_used: false,
    provider_config_modified: false,
  },
  providers: { claude, codex },
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
