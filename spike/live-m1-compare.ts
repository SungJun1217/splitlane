#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";
import { CompareOrchestrator } from "../src/core/orchestrator.ts";
import type { LaneStatus, ProviderId } from "../src/domain.ts";
import { runCommand } from "../src/process/child.ts";
import { ClaudeAdapter } from "../src/providers/claude.ts";
import { CodexAdapter } from "../src/providers/codex.ts";

const CONSENT_FLAG = "--i-understand-this-starts-20-model-turns";
const TERMINAL = new Set<LaneStatus>(["COMPLETED", "FAILED", "CANCELLED", "UNAVAILABLE"]);
const EXCLUDED_ROOTS = new Set([".git", "dist", "node_modules"]);

if (!process.argv.includes(CONSENT_FLAG)) {
  process.stderr.write(`Refusing live M1 gate without ${CONSENT_FLAG}\n`);
  process.exit(2);
}

interface ProcessIdentity {
  pid: number;
  ppid: number;
  command: string;
}

async function processTable(): Promise<ProcessIdentity[]> {
  const result = await runCommand("ps", ["-axo", "pid=,ppid=,command="], { timeoutMs: 5_000 });
  return result.stdout.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return match
      ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }]
      : [];
  });
}

async function descendants(rootPid: number): Promise<ProcessIdentity[]> {
  const rows = await processTable();
  const descendantIds = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendantIds.has(row.ppid) && !descendantIds.has(row.pid)) {
        descendantIds.add(row.pid);
        changed = true;
      }
    }
  }
  return rows.filter(({ pid }) => pid !== rootPid && descendantIds.has(pid));
}

async function workspaceFingerprint(root: string): Promise<string> {
  const entries: string[] = [];
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      if (!relativeDirectory && EXCLUDED_ROOTS.has(child.name)) continue;
      const relative = path.join(relativeDirectory, child.name);
      const absolute = path.join(directory, child.name);
      const metadata = await lstat(absolute);
      if (metadata.isDirectory()) await visit(absolute, relative);
      else if (metadata.isSymbolicLink()) entries.push(`${relative}\0link\0${await readlink(absolute)}`);
      else if (metadata.isFile()) {
        const digest = createHash("sha256").update(await readFile(absolute)).digest("hex");
        entries.push(`${relative}\0file\0${digest}`);
      }
    }
  }
  await visit(root, "");
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

async function waitForPair(
  orchestrator: CompareOrchestrator,
  capturedProcesses: Map<number, ProcessIdentity>,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let nextProcessSample = 0;
  while (true) {
    const snapshot = orchestrator.getSnapshot();
    if (TERMINAL.has(snapshot.lanes.claude.status) && TERMINAL.has(snapshot.lanes.codex.status)) return;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for both providers to finish");
    if (Date.now() >= nextProcessSample) {
      for (const row of await descendants(process.pid)) capturedProcesses.set(row.pid, row);
      nextProcessSample = Date.now() + 1_000;
    }
    await Bun.sleep(50);
  }
}

const root = process.cwd();
const orchestrator = new CompareOrchestrator(root, {
  claude: new ClaudeAdapter(),
  codex: new CodexAdapter(),
});
const capturedProcesses = new Map<number, ProcessIdentity>();
const startedAt = Date.now();
const beforeFingerprint = await workspaceFingerprint(root);
let completedPairs = 0;
let startedPairs = 0;
let firstSessions: Record<ProviderId, string | null> | null = null;
let sessionsStable = true;
let outputsIsolated = true;
let failure: string | null = null;

try {
  await orchestrator.initialize();
  const initial = orchestrator.getSnapshot();
  if (initial.mode !== "compare" || initial.writer !== null || initial.target !== "both") {
    throw new Error("Unsafe initial routing state");
  }
  for (let index = 1; index <= 10; index += 1) {
    const marker = `SPLITLANE_M1_GATE_${String(index).padStart(2, "0")}`;
    const before = orchestrator.getSnapshot();
    const offsets = {
      claude: before.lanes.claude.output.length,
      codex: before.lanes.codex.output.length,
    };
    const accepted = await orchestrator.dispatch(
      `Without using tools, reply with exactly ${marker} and nothing else.`,
    );
    if (!accepted) throw new Error(`Pair ${index} was refused before dispatch`);
    startedPairs = index;
    await waitForPair(orchestrator, capturedProcesses);
    const after = orchestrator.getSnapshot();
    const statuses = {
      claude: after.lanes.claude.status,
      codex: after.lanes.codex.status,
    };
    const segments = {
      claude: after.lanes.claude.output.slice(offsets.claude),
      codex: after.lanes.codex.output.slice(offsets.codex),
    };
    const markerObserved = {
      claude: segments.claude.includes(marker),
      codex: segments.codex.includes(marker),
    };
    outputsIsolated &&= markerObserved.claude && markerObserved.codex;
    if (statuses.claude !== "COMPLETED" || statuses.codex !== "COMPLETED") {
      throw new Error(`Pair ${index} failed: claude=${statuses.claude}, codex=${statuses.codex}`);
    }
    if (!markerObserved.claude || !markerObserved.codex) {
      throw new Error(`Pair ${index} lost its expected marker`);
    }
    const sessions = {
      claude: after.lanes.claude.sessionId,
      codex: after.lanes.codex.sessionId,
    };
    if (!firstSessions) firstSessions = sessions;
    else sessionsStable &&= sessions.claude === firstSessions.claude && sessions.codex === firstSessions.codex;
    completedPairs = index;
    process.stdout.write(`${JSON.stringify({ pair: index, statuses, marker_observed: markerObserved, sessions_stable: sessionsStable })}\n`);
  }
} catch (error) {
  failure = (error as Error).message;
} finally {
  for (const row of await descendants(process.pid)) capturedProcesses.set(row.pid, row);
  await orchestrator.close();
}

let lingeringProcesses: ProcessIdentity[] = [];
const cleanupDeadline = Date.now() + 10_000;
do {
  const currentProcesses = new Map((await processTable()).map((row) => [row.pid, row]));
  lingeringProcesses = [...capturedProcesses.values()].filter((captured) => {
    const current = currentProcesses.get(captured.pid);
    return current?.command === captured.command;
  });
  if (lingeringProcesses.length === 0) break;
  await Bun.sleep(100);
} while (Date.now() < cleanupDeadline);
const afterFingerprint = await workspaceFingerprint(root);
const snapshot = orchestrator.getSnapshot();
const crossProviderEventRejected = snapshot.diagnostics.some((line) => line.includes("Cross-provider event rejected"));
const redactCommand = (command: string): string => command
  .replaceAll(root, "<project-root>")
  .replace(/--resume(?:=|\s+)\S+/g, "--resume=<redacted>")
  .replace(/--session-id(?:=|\s+)\S+/g, "--session-id=<redacted>")
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<opaque-id>");
const result = {
  schema_version: 1,
  provider_turns_started: startedPairs * 2,
  completed_pairs: completedPairs,
  passed: completedPairs === 10 && sessionsStable && outputsIsolated && beforeFingerprint === afterFingerprint && lingeringProcesses.length === 0 && !crossProviderEventRejected && failure === null,
  sessions_stable: sessionsStable,
  expected_markers_observed: outputsIsolated,
  workspace_unchanged: beforeFingerprint === afterFingerprint,
  captured_child_processes: capturedProcesses.size,
  lingering_processes: lingeringProcesses.map(({ command }) => redactCommand(command)),
  cross_provider_event_rejected: crossProviderEventRejected,
  duration_ms: Date.now() - startedAt,
  failure,
};
process.stdout.write(`M1_LIVE_GATE_RESULT=${JSON.stringify(result)}\n`);
if (!result.passed) process.exitCode = 1;
