import React from "react";
import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import stringWidth from "string-width";
import { CompareOrchestrator } from "./core/orchestrator.ts";
import { AsyncQueue } from "./core/async-queue.ts";
import { event } from "./core/events.ts";
import type {
  AppSnapshot,
  NormalizedEvent,
  ProviderAdapter,
  ProviderId,
  ProviderProbe,
  ProviderTurn,
  SessionHandle,
  SessionOptions,
  TurnOptions,
} from "./domain.ts";
import { appendBounded, sanitizeTerminalText } from "./terminal/sanitize.ts";
import { ClaudeAdapter, parseClaudeMessage } from "./providers/claude.ts";
import { parseCodexNotification } from "./providers/codex.ts";
import { CodexRpcClient } from "./providers/codex-rpc.ts";
import { parseStatus } from "./git/observer.ts";
import { SplitlaneView } from "./ui/app.tsx";
import { selectLayout } from "./ui/layout.ts";
import { removeLastGrapheme } from "./ui/text.ts";

type Scenario = "complete" | "fail" | "hold" | "approval";

class FakeAdapter implements ProviderAdapter {
  readonly sessions: SessionOptions[] = [];
  readonly prompts: string[] = [];
  readonly interrupted: string[] = [];
  readonly #active = new Map<string, AsyncQueue<NormalizedEvent>>();

  constructor(readonly provider: ProviderId, readonly scenario: Scenario = "complete") {}

  async probe(): Promise<ProviderProbe> {
    return { provider: this.provider, available: true, version: "fake/1", error: null };
  }

  async startSession(options: SessionOptions): Promise<SessionHandle> {
    this.sessions.push(options);
    return {
      provider: this.provider,
      id: `${this.provider}-session`,
      requestedModel: options.requestedModel,
      effectiveModel: options.requestedModel,
    };
  }

  async startTurn(session: SessionHandle, prompt: string, _options: TurnOptions): Promise<ProviderTurn> {
    this.prompts.push(prompt);
    const id = `${this.provider}-turn-${this.prompts.length}`;
    const queue = new AsyncQueue<NormalizedEvent>();
    this.#active.set(id, queue);
    queueMicrotask(() => {
      queue.push(event(this.provider, "turn.started", { sessionId: session.id, turnId: id }));
      queue.push(event(this.provider, "message.delta", {
        sessionId: session.id,
        turnId: id,
        payload: { text: `${this.provider}:한글` },
      }));
      if (this.scenario === "fail") {
        queue.push(event(this.provider, "turn.failed", { sessionId: session.id, turnId: id, payload: { error: "fake failure" } }));
        queue.close();
      } else if (this.scenario === "complete") {
        queue.push(event(this.provider, "turn.completed", { sessionId: session.id, turnId: id }));
        queue.close();
      } else if (this.scenario === "approval") {
        queue.push(event(this.provider, "approval.requested", { sessionId: session.id, turnId: id }));
      }
    });
    return { id, events: queue };
  }

  resolveApproval(): void {
    const [turnId, queue] = [...this.#active.entries()].at(-1) ?? [];
    if (!turnId || !queue) return;
    queue.push(event(this.provider, "approval.resolved", { turnId }));
    queue.push(event(this.provider, "turn.completed", { turnId }));
    queue.close();
  }

  async interrupt(turnId: string): Promise<void> {
    this.interrupted.push(turnId);
    const queue = this.#active.get(turnId);
    queue?.push(event(this.provider, "turn.cancelled", { turnId }));
    queue?.close();
  }

  async close(): Promise<void> {
    for (const queue of this.#active.values()) queue.close();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for state");
    await Bun.sleep(5);
  }
}

function setup(claudeScenario: Scenario = "complete", codexScenario: Scenario = "complete") {
  const claude = new FakeAdapter("claude", claudeScenario);
  const codex = new FakeAdapter("codex", codexScenario);
  const orchestrator = new CompareOrchestrator(process.cwd(), { claude, codex });
  return { orchestrator, claude, codex };
}

describe("production orchestrator", () => {
  test("broadcast reserves both lanes atomically and refuses a second send", async () => {
    const { orchestrator, claude, codex } = setup("hold", "hold");
    await orchestrator.initialize();
    expect(await orchestrator.dispatch("same prompt")).toBe(true);
    expect(orchestrator.getSnapshot().lanes.claude.status).toBe("STARTING");
    expect(orchestrator.getSnapshot().lanes.codex.status).toBe("STARTING");
    expect(await orchestrator.dispatch("must not partially send")).toBe(false);
    await waitFor(() => claude.prompts.length === 1 && codex.prompts.length === 1);
    expect(claude.prompts).toEqual(["same prompt"]);
    expect(codex.prompts).toEqual(["same prompt"]);
    await orchestrator.close();
  });

  test("one lane can fail without cancelling the other", async () => {
    const { orchestrator } = setup("fail", "complete");
    await orchestrator.initialize();
    await orchestrator.dispatch("compare");
    await waitFor(() => orchestrator.getSnapshot().lanes.codex.status === "COMPLETED");
    expect(orchestrator.getSnapshot().lanes.claude.status).toBe("FAILED");
    expect(orchestrator.getSnapshot().lanes.codex.output).toContain("codex:한글");
    await orchestrator.close();
  });

  test("lane-local cancellation leaves the other lane running", async () => {
    const { orchestrator, claude, codex } = setup("hold", "hold");
    await orchestrator.initialize();
    await orchestrator.dispatch("compare");
    await waitFor(() => orchestrator.getSnapshot().lanes.claude.status === "RUNNING");
    await orchestrator.cancel("claude");
    await waitFor(() => orchestrator.getSnapshot().lanes.claude.status === "CANCELLED");
    expect(claude.interrupted).toHaveLength(1);
    expect(codex.interrupted).toHaveLength(0);
    expect(orchestrator.getSnapshot().lanes.codex.status).toBe("RUNNING");
    await orchestrator.close();
  });

  test("approval is visible as blocked and model changes reset only that session", async () => {
    const { orchestrator, claude, codex } = setup("approval", "complete");
    await orchestrator.initialize();
    orchestrator.setTarget("claude");
    orchestrator.setModel("claude", "claude-test-exact");
    await orchestrator.dispatch("inspect");
    await waitFor(() => orchestrator.getSnapshot().lanes.claude.status === "BLOCKED");
    expect(claude.sessions[0]?.requestedModel).toBe("claude-test-exact");
    expect(codex.sessions).toHaveLength(0);
    claude.resolveApproval();
    await waitFor(() => orchestrator.getSnapshot().lanes.claude.status === "COMPLETED");
    orchestrator.setModel("claude", "default");
    expect(orchestrator.getSnapshot().lanes.claude.sessionId).toBeNull();
    await orchestrator.close();
  });
});

describe("terminal rendering", () => {
  test("sanitizes terminal escape injection and bounds output", () => {
    expect(sanitizeTerminalText("ok\u001b]2;owned\u0007\u001b[31m!\u001b[0m")).toBe("ok!");
    expect(appendBounded("1234", "56", 4)).toBe("3456");
  });

  test("selects responsive layouts and handles graphemes", () => {
    expect(selectLayout(99)).toBe("focused");
    expect(selectLayout(100)).toBe("stacked");
    expect(selectLayout(180)).toBe("columns");
    expect(stringWidth("한글")).toBe(4);
    expect(removeLastGrapheme("A👨‍👩‍👧‍👦한")).toBe("A👨‍👩‍👧‍👦");
    expect(parseStatus("## No commits yet on main\n?? 한글.txt\n M src/a.ts\n")).toEqual({
      branch: "main",
      files: ["한글.txt", "src/a.ts"],
    });
  });

  test("renders a narrow Korean-safe screen without a live terminal", () => {
    const { orchestrator } = setup();
    const base = orchestrator.getSnapshot();
    const snapshot: AppSnapshot = {
      ...base,
      lanes: {
        ...base.lanes,
        claude: { ...base.lanes.claude, output: "안녕하세요", status: "RUNNING" },
      },
    };
    const output = renderToString(<SplitlaneView snapshot={snapshot} prompt="변경점을 비교해줘" columns={90} rows={30} />, { columns: 90 });
    expect(output).toContain("SPLITLANE");
    expect(output).toContain("안녕하세요");
    expect(output).toContain("COMPARE");
    expect(output).toContain("writer NONE");
  });
});

describe("captured provider event compatibility", () => {
  test("normalizes Claude session, streaming, tools, failures, and malformed events", async () => {
    const fixture = await Bun.file("test/fixtures/claude-sdk-stream.redacted.json").json() as {
      events: unknown[];
      error_event: unknown;
    };
    let sawTextDelta = false;
    const kinds: NormalizedEvent["kind"][] = [];
    let sessionId: string | undefined;
    for (const raw of fixture.events) {
      const parsed = parseClaudeMessage(raw, sawTextDelta);
      sawTextDelta = parsed.sawTextDelta;
      sessionId = parsed.sessionId ?? sessionId;
      kinds.push(...parsed.events.map(({ kind }) => kind));
    }
    expect(sessionId).toBe("<opaque-id>");
    expect(kinds).toEqual(["message.delta", "tool.started", "turn.completed", "provider.warning"]);
    expect(parseClaudeMessage(fixture.error_event, false).events[0]?.kind).toBe("turn.failed");
  });

  test("normalizes Codex deltas, tools, terminal statuses, unknown, and malformed events", async () => {
    const fixture = await Bun.file("test/fixtures/codex-app-server-stream.redacted.json").json() as {
      events: Parameters<typeof parseCodexNotification>[0][];
      failed_event: Parameters<typeof parseCodexNotification>[0];
      cancelled_event: Parameters<typeof parseCodexNotification>[0];
    };
    const parsed = fixture.events.flatMap(parseCodexNotification);
    expect(parsed.map(({ kind }) => kind)).toEqual([
      "turn.started",
      "message.delta",
      "tool.started",
      "tool.completed",
      "turn.completed",
      "provider.warning",
    ]);
    expect(parseCodexNotification(fixture.failed_event)[0]?.kind).toBe("turn.failed");
    expect(parseCodexNotification(fixture.cancelled_event)[0]?.kind).toBe("turn.cancelled");
  });

  test("turns an abrupt Claude SDK stream end into an explicit failure", async () => {
    let closeCalled = false;
    async function* abruptStream() {
      yield { type: "system", subtype: "init", session_id: "session", model: "fake" };
    }
    const fakeQuery = () => {
      const stream = abruptStream();
      return Object.assign(stream, { close: () => { closeCalled = true; } });
    };
    const adapter = new ClaudeAdapter(fakeQuery as never);
    const session = await adapter.startSession({ projectRoot: process.cwd(), requestedModel: "default" });
    const turn = await adapter.startTurn(session, "read only", { requestedModel: "default" });
    const kinds: NormalizedEvent["kind"][] = [];
    for await (const item of turn.events) kinds.push(item.kind);
    expect(kinds).toEqual(["session.started", "turn.started", "turn.failed"]);
    expect(closeCalled).toBe(true);
  });

  test("production JSONL transport reports malformed input and abrupt process exit", async () => {
    const notifications: string[] = [];
    const exitErrors: Error[] = [];
    const client = new CodexRpcClient(
      (message) => { if (message.method) notifications.push(message.method); },
      () => {},
      (error) => { exitErrors.push(error); },
      process.execPath,
      ["test/fixtures/fake-jsonl-server.mjs"],
    );
    await client.start();
    const initialized = await client.request<{ userAgent: string }>("initialize", {});
    expect(initialized.userAgent).toBe("fake-app-server/1.0");
    client.notify("emit/malformed");
    await waitFor(() => notifications.includes("diagnostic/malformed"));
    client.notify("exit/abrupt");
    await waitFor(() => exitErrors.length > 0);
    expect(exitErrors[0]?.message).toContain("code=17");
    await client.close();
  });
});
