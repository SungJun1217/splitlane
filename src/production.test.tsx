import React from "react";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { renderToString } from "ink";
import stringWidth from "string-width";
import { CompareOrchestrator } from "./core/orchestrator.ts";
import { AsyncQueue } from "./core/async-queue.ts";
import { event } from "./core/events.ts";
import type {
  ApprovalDecision,
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
import { ClaudeAdapter, claudePermissionResult, parseClaudeMessage } from "./providers/claude.ts";
import { CodexAdapter, codexApprovalResponse, parseCodexApprovalRequest, parseCodexNotification, supportsCodexNativeReviewSchema } from "./providers/codex.ts";
import { CodexRpcClient } from "./providers/codex-rpc.ts";
import { GitObserver, parseStatus } from "./git/observer.ts";
import { SplitlaneView } from "./ui/app.tsx";
import { selectLayout } from "./ui/layout.ts";
import { removeLastGrapheme } from "./ui/text.ts";
import { WorkspaceGuard, isPathInsideWorkspace } from "./workspace/guard.ts";
import { captureReviewPatch, createReviewEnvelope, REVIEW_PATCH_LIMIT } from "./review/envelope.ts";
import { FINDINGS_END, FINDINGS_START, parseReviewFindings } from "./review/findings.ts";
import { loadFindingPreview } from "./review/preview.ts";

type Scenario = "complete" | "fail" | "hold" | "approval" | "double_approval" | "network_approval" | "outside_approval" | "unknown_file_approval" | "review_findings" | "review_delayed";

class FakeAdapter implements ProviderAdapter {
  readonly sessions: SessionOptions[] = [];
  readonly prompts: string[] = [];
  readonly interrupted: string[] = [];
  readonly turnOptions: TurnOptions[] = [];
  readonly approvalDecisions: ApprovalDecision[] = [];
  readonly nativeReviewPrompts: string[] = [];
  readonly reviewMechanisms?: readonly ("claude_generic" | "codex_generic" | "codex_native")[];
  readonly #active = new Map<string, AsyncQueue<NormalizedEvent>>();

  constructor(readonly provider: ProviderId, readonly scenario: Scenario = "complete", nativeReview = false) {
    this.reviewMechanisms = provider === "codex" && nativeReview ? ["codex_native", "codex_generic"] : [`${provider}_generic`];
  }

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

  async startTurn(session: SessionHandle, prompt: string, options: TurnOptions): Promise<ProviderTurn> {
    this.prompts.push(prompt);
    this.turnOptions.push(options);
    const id = `${this.provider}-turn-${this.prompts.length}`;
    const queue = new AsyncQueue<NormalizedEvent>();
    this.#active.set(id, queue);
    queueMicrotask(() => {
      queue.push(event(this.provider, "turn.started", { sessionId: session.id, turnId: id }));
      const reviewOutput = [
        FINDINGS_START,
        JSON.stringify({ findings: [{
          id: "finding-1",
          severity: "high",
          title: "Regression risk",
          body: "The changed branch lacks a guard.",
          file: "existing.txt",
          lineStart: 1,
          lineEnd: 1,
          verification: "Run the focused test.",
        }] }),
        FINDINGS_END,
      ].join("\n");
      queue.push(event(this.provider, "message.delta", {
        sessionId: session.id,
        turnId: id,
        payload: { text: ["review_findings", "review_delayed"].includes(this.scenario) ? reviewOutput : `${this.provider}:한글` },
      }));
      if (this.scenario === "fail") {
        queue.push(event(this.provider, "turn.failed", { sessionId: session.id, turnId: id, payload: { error: "fake failure" } }));
        queue.close();
      } else if (this.scenario === "complete" || this.scenario === "review_findings") {
        queue.push(event(this.provider, "turn.completed", { sessionId: session.id, turnId: id }));
        queue.close();
      } else if (this.scenario === "review_delayed") {
        setTimeout(() => {
          queue.push(event(this.provider, "turn.completed", { sessionId: session.id, turnId: id }));
          queue.close();
        }, 80);
      } else if (["approval", "double_approval", "network_approval", "outside_approval", "unknown_file_approval"].includes(this.scenario)) {
        const count = this.scenario === "double_approval" ? 2 : 1;
        const requests = Array.from({ length: count }, (_, index) => {
          queue.push(event(this.provider, "approval.requested", { sessionId: session.id, turnId: id }));
          return options.requestApproval({
            providerRequestId: `${this.provider}-approval-${index}`,
            kind: "file_change",
            tool: `Fake write ${index + 1}`,
            command: `touch approved-${index + 1}.txt`,
            cwd: options.projectRoot,
            path: this.scenario === "unknown_file_approval"
              ? null
              : this.scenario === "outside_approval"
              ? resolve(options.projectRoot, "..", "outside.txt")
              : `approved-${index + 1}.txt`,
            paths: this.scenario === "unknown_file_approval" ? [] : [this.scenario === "outside_approval"
              ? resolve(options.projectRoot, "..", "outside.txt")
              : `approved-${index + 1}.txt`],
            reason: "test approval",
            networkEffect: this.scenario === "network_approval" ? "requested" : "off",
          });
        });
        void Promise.all(requests).then((decisions) => {
          this.approvalDecisions.push(...decisions);
          for (const decision of decisions) {
            queue.push(event(this.provider, "approval.resolved", { sessionId: session.id, turnId: id, payload: { decision } }));
          }
          queue.push(event(this.provider, decisions.includes("cancel_turn") ? "turn.cancelled" : "turn.completed", {
            sessionId: session.id,
            turnId: id,
          }));
          queue.close();
        });
      }
    });
    return { id, events: queue };
  }

  async startReview(session: SessionHandle, prompt: string, options: TurnOptions): Promise<ProviderTurn> {
    this.nativeReviewPrompts.push(prompt);
    return this.startTurn(session, prompt, options);
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

function readOnlyTurnOptions(): TurnOptions {
  return {
    requestedModel: "default",
    projectRoot: process.cwd(),
    workspaceAccess: "read_only",
    writerLease: null,
    requestApproval: async () => "deny",
  };
}

async function gitCommand(root: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(await new Response(child.stderr).text());
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
    expect(await orchestrator.promoteWriter("claude", true)).toBe(true);
    orchestrator.setTarget("claude");
    orchestrator.setModel("claude", "claude-test-exact");
    await orchestrator.dispatch("inspect");
    await waitFor(() => orchestrator.getSnapshot().lanes.claude.status === "BLOCKED");
    expect(orchestrator.getSnapshot().approvals).toHaveLength(1);
    expect(claude.sessions[0]?.requestedModel).toBe("claude-test-exact");
    expect(codex.sessions).toHaveLength(0);
    const approval = orchestrator.getSnapshot().approvals[0];
    expect(approval && orchestrator.resolveApproval(approval.id, "allow_once")).toBe(true);
    await waitFor(() => orchestrator.getSnapshot().lanes.claude.status === "COMPLETED");
    expect(claude.approvalDecisions).toEqual(["allow_once"]);
    orchestrator.setModel("claude", "default");
    expect(orchestrator.getSnapshot().lanes.claude.sessionId).toBeNull();
    await orchestrator.close();
  });

  test("a lane stays blocked until every concurrent approval is resolved", async () => {
    const { orchestrator, claude } = setup("double_approval", "complete");
    await orchestrator.initialize();
    expect(await orchestrator.promoteWriter("claude", true)).toBe(true);
    orchestrator.setTarget("claude");
    await orchestrator.dispatch("two approvals");
    await waitFor(() => orchestrator.getSnapshot().approvals.length === 2);
    const first = orchestrator.getSnapshot().approvals[0];
    expect(first && orchestrator.resolveApproval(first.id, "allow_once")).toBe(true);
    expect(orchestrator.getSnapshot().approvals).toHaveLength(1);
    expect(orchestrator.getSnapshot().lanes.claude.status).toBe("BLOCKED");
    const second = orchestrator.getSnapshot().approvals[0];
    expect(second && orchestrator.resolveApproval(second.id, "deny")).toBe(true);
    await waitFor(() => orchestrator.getSnapshot().lanes.claude.status === "COMPLETED");
    expect(claude.approvalDecisions).toEqual(["allow_once", "deny"]);
    await orchestrator.close();
  });

  test("one writer lease routes build broadcast as writer plus read-only peer", async () => {
    const { orchestrator, claude, codex } = setup();
    await orchestrator.initialize();
    const promotions = await Promise.all([
      orchestrator.promoteWriter("claude", true),
      orchestrator.promoteWriter("codex", true),
    ]);
    expect(promotions).toEqual([true, false]);
    expect(orchestrator.getSnapshot().writer).toBe("claude");
    expect(orchestrator.getSnapshot().target).toBe("both");
    await orchestrator.dispatch("build once, review once");
    await waitFor(() => claude.turnOptions.length === 1 && codex.turnOptions.length === 1);
    expect(claude.turnOptions[0]?.workspaceAccess).toBe("workspace_write");
    expect(claude.turnOptions[0]?.writerLease?.provider).toBe("claude");
    expect(codex.turnOptions[0]?.workspaceAccess).toBe("read_only");
    expect(codex.turnOptions[0]?.writerLease).toBeNull();
    await orchestrator.close();
  });

  test("read-only peer approval is denied without entering the inbox", async () => {
    const { orchestrator, codex } = setup("complete", "approval");
    await orchestrator.initialize();
    expect(await orchestrator.promoteWriter("claude", true)).toBe(true);
    orchestrator.setTarget("codex");
    await orchestrator.dispatch("review read only");
    await waitFor(() => orchestrator.getSnapshot().lanes.codex.status === "COMPLETED");
    expect(codex.approvalDecisions).toEqual(["deny"]);
    expect(orchestrator.getSnapshot().approvals).toHaveLength(0);
    expect(orchestrator.getSnapshot().diagnostics.join("\n")).toContain("read-only lane was denied");
    await orchestrator.close();
  });

  test("writer network approval is denied even in build mode", async () => {
    const { orchestrator, claude } = setup("network_approval", "complete");
    await orchestrator.initialize();
    expect(await orchestrator.promoteWriter("claude", true)).toBe(true);
    orchestrator.setTarget("claude");
    await orchestrator.dispatch("try network");
    await waitFor(() => orchestrator.getSnapshot().lanes.claude.status === "COMPLETED");
    expect(claude.approvalDecisions).toEqual(["deny"]);
    expect(orchestrator.getSnapshot().approvals).toHaveLength(0);
    expect(orchestrator.getSnapshot().notice).toContain("network access is disabled");
    await orchestrator.close();
  });

  test("writer approval outside the project root is denied without entering the inbox", async () => {
    const { orchestrator, claude } = setup("outside_approval", "complete");
    await orchestrator.initialize();
    expect(await orchestrator.promoteWriter("claude", true)).toBe(true);
    orchestrator.setTarget("claude");
    await orchestrator.dispatch("try outside root");
    await waitFor(() => orchestrator.getSnapshot().lanes.claude.status === "COMPLETED");
    expect(claude.approvalDecisions).toEqual(["deny"]);
    expect(orchestrator.getSnapshot().approvals).toHaveLength(0);
    expect(orchestrator.getSnapshot().notice).toContain("outside the writer workspace");
    await orchestrator.close();
  });

  test("writer file approval with an unknown boundary is denied without entering the inbox", async () => {
    const { orchestrator, claude } = setup("unknown_file_approval", "complete");
    await orchestrator.initialize();
    expect(await orchestrator.promoteWriter("claude", true)).toBe(true);
    orchestrator.setTarget("claude");
    await orchestrator.dispatch("try unknown file boundary");
    await waitFor(() => orchestrator.getSnapshot().lanes.claude.status === "COMPLETED");
    expect(claude.approvalDecisions).toEqual(["deny"]);
    expect(orchestrator.getSnapshot().approvals).toHaveLength(0);
    expect(orchestrator.getSnapshot().notice).toContain("file-change boundary is unknown");
    await orchestrator.close();
  });

  test("cancelling an approval cancels the writer turn and revokes the lease", async () => {
    const { orchestrator, claude } = setup("approval", "complete");
    await orchestrator.initialize();
    expect(await orchestrator.promoteWriter("claude", true)).toBe(true);
    orchestrator.setTarget("claude");
    await orchestrator.dispatch("request then cancel");
    await waitFor(() => orchestrator.getSnapshot().lanes.claude.status === "BLOCKED");
    const approval = orchestrator.getSnapshot().approvals[0];
    expect(approval && orchestrator.resolveApproval(approval.id, "cancel_turn")).toBe(true);
    await waitFor(() => orchestrator.getSnapshot().mode === "compare");
    expect(orchestrator.getSnapshot().writer).toBeNull();
    expect(claude.interrupted).toHaveLength(1);
    await orchestrator.close();
  });

  test("closing with a pending approval fails closed and removes the writer lease", async () => {
    const { orchestrator, claude } = setup("approval", "complete");
    await orchestrator.initialize();
    expect(await orchestrator.promoteWriter("claude", true)).toBe(true);
    orchestrator.setTarget("claude");
    await orchestrator.dispatch("request then close");
    await waitFor(() => orchestrator.getSnapshot().lanes.claude.status === "BLOCKED");
    await orchestrator.close();
    await waitFor(() => claude.approvalDecisions.length === 1);
    expect(claude.approvalDecisions).toEqual(["cancel_turn"]);
    expect(orchestrator.getSnapshot().approvals).toHaveLength(0);
    expect(orchestrator.getSnapshot().writer).toBeNull();
    expect(orchestrator.getSnapshot().mode).toBe("compare");
  });

  test("a writer failure revokes the lease while leaving the peer result intact", async () => {
    const { orchestrator } = setup("fail", "complete");
    await orchestrator.initialize();
    expect(await orchestrator.promoteWriter("claude", true)).toBe(true);
    await orchestrator.dispatch("writer fails, peer continues");
    await waitFor(() => orchestrator.getSnapshot().lanes.codex.status === "COMPLETED");
    expect(orchestrator.getSnapshot().lanes.claude.status).toBe("FAILED");
    expect(orchestrator.getSnapshot().mode).toBe("compare");
    expect(orchestrator.getSnapshot().writer).toBeNull();
    expect(orchestrator.getSnapshot().lanes.codex.output).toContain("codex:한글");
    await orchestrator.close();
  });

  test("revoking an active writer cancels only that lane and restores compare", async () => {
    const { orchestrator, claude, codex } = setup("hold", "hold");
    await orchestrator.initialize();
    expect(await orchestrator.promoteWriter("claude", true)).toBe(true);
    orchestrator.setTarget("claude");
    await orchestrator.dispatch("hold writer");
    await waitFor(() => orchestrator.getSnapshot().lanes.claude.status === "RUNNING");
    await orchestrator.revokeWriter();
    await waitFor(() => orchestrator.getSnapshot().mode === "compare");
    expect(orchestrator.getSnapshot().writer).toBeNull();
    expect(claude.interrupted).toHaveLength(1);
    expect(codex.interrupted).toHaveLength(0);
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

  test("renders writer confirmation and approval safety details", () => {
    const { orchestrator } = setup();
    const base = orchestrator.getSnapshot();
    const writer = renderToString(
      <SplitlaneView snapshot={base} prompt="" columns={120} rows={30} overlay="writer" writerConfirm />,
      { columns: 120 },
    );
    expect(writer).toContain("ENTER BUILD · SINGLE WRITER · CONFIRM");
    expect(writer).toContain("network off");

    const approvalSnapshot: AppSnapshot = {
      ...base,
      approvals: [{
        id: "approval",
        provider: "claude",
        turnId: "turn",
        providerRequestId: "provider-request",
        kind: "file_change",
        requestedAt: new Date(0).toISOString(),
        tool: "Run command",
        command: "touch approved.txt",
        cwd: process.cwd(),
        path: "approved.txt",
        paths: ["approved.txt"],
        reason: "write output",
        networkEffect: "off",
        outsideWorkspace: false,
      }],
    };
    const approval = renderToString(
      <SplitlaneView snapshot={approvalSnapshot} prompt="" columns={120} rows={30} overlay="approval" />,
      { columns: 120 },
    );
    expect(approval).toContain("APPROVAL INBOX · 1 PENDING");
    expect(approval).toContain("A allow once · D deny · X cancel turn");
  });

  test("renders review confirmation and stale Korean findings in a narrow terminal", () => {
    const { orchestrator } = setup();
    const base = orchestrator.getSnapshot();
    const envelope = createReviewEnvelope({
      writer: "claude",
      reviewer: "codex",
      mechanism: "codex_generic",
      objective: "한글 경계를 유지해줘",
      acceptanceCriteria: "",
      projectRoot: process.cwd(),
      baselineFingerprint: "baseline",
      patch: {
        branch: "main",
        head: "1234567890abcdef",
        files: [{ path: "한글.ts", classification: "writer-hinted" }],
        diff: "diff --git a/한글.ts b/한글.ts",
        diffBytes: 36,
        diffHash: "a".repeat(64),
      },
    });
    const reviewSnapshot: AppSnapshot = {
      ...base,
      mode: "review",
      review: {
        status: "completed",
        writer: "claude",
        reviewer: "codex",
        mechanism: "codex_generic",
        availableMechanisms: ["codex_generic"],
        envelope: { ...envelope, acceptanceCriteria: "회귀 없음" },
        stale: true,
        parseError: null,
        findings: [{
          id: "finding-ko",
          provider: "codex",
          mechanism: "codex_generic",
          severity: "high",
          title: "한글 경계 오류",
          body: "너비 계산을 확인하세요.",
          file: "한글.ts",
          lineStart: 3,
          lineEnd: 3,
          verification: "좁은 터미널 테스트",
          selected: true,
        }],
        activeFindingId: "finding-ko",
        preview: {
          file: "한글.ts",
          lineStart: 3,
          lineEnd: 3,
          content: "    3 │ 너비 계산",
          error: null,
        },
      },
    };
    const confirmation = renderToString(
      <SplitlaneView snapshot={{ ...reviewSnapshot, mode: "build" }} prompt="" columns={90} rows={30} overlay="review" reviewCriteria="회귀 없음" />,
      { columns: 90 },
    );
    expect(confirmation).toContain("REVOKE WRITER THEN READ ONLY");
    expect(confirmation).toContain("회귀 없음");
    expect(confirmation).toContain("codex_generic [stable]");
    const findings = renderToString(
      <SplitlaneView snapshot={reviewSnapshot} prompt="" columns={90} rows={30} overlay="findings" staleAcknowledged />,
      { columns: 90 },
    );
    expect(findings).toContain("STALE");
    expect(findings).toContain("한글 경계 오류");
    expect(findings).toContain("paused CLAUDE");
  });
});

describe("M2 workspace guard", () => {
  test("dirty trees require explicit acknowledgement before promotion", async () => {
    const root = await mkdtemp(join(tmpdir(), "splitlane-m2-dirty-"));
    try {
      await gitCommand(root, "init", "-q");
      await Bun.write(join(root, "existing.txt"), "pre-existing\n");
      const claude = new FakeAdapter("claude");
      const codex = new FakeAdapter("codex");
      const orchestrator = new CompareOrchestrator(root, { claude, codex });
      await orchestrator.initialize();
      expect(orchestrator.getSnapshot().git.dirty).toBe(true);
      expect(await orchestrator.promoteWriter("claude", false)).toBe(false);
      expect(orchestrator.getSnapshot().mode).toBe("compare");
      expect(await orchestrator.promoteWriter("claude", true)).toBe(true);
      await orchestrator.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Git baseline preserves pre-existing labels and attributes only explicit writer hints", async () => {
    const root = await mkdtemp(join(tmpdir(), "splitlane-m2-git-"));
    try {
      await gitCommand(root, "init", "-q");
      await gitCommand(root, "config", "user.email", "test@example.invalid");
      await gitCommand(root, "config", "user.name", "Splitlane Test");
      await Bun.write(join(root, "existing.txt"), "committed\n");
      await gitCommand(root, "add", "existing.txt");
      await gitCommand(root, "commit", "-qm", "baseline");
      await Bun.write(join(root, "existing.txt"), "dirty before lease\n");

      const observer = new GitObserver(root);
      await observer.captureBaseline();
      expect(observer.snapshot.evidence).toContainEqual({ path: "existing.txt", classification: "pre-existing" });

      await Bun.write(join(root, "external.txt"), "unknown source\n");
      observer.noteWriterChange(join(root, "writer.txt"));
      await Bun.write(join(root, "writer.txt"), "provider hint\n");
      const snapshot = await observer.refresh();
      expect(snapshot.evidence).toContainEqual({ path: "existing.txt", classification: "pre-existing" });
      expect(snapshot.evidence).toContainEqual({ path: "writer.txt", classification: "writer-hinted" });
      expect(snapshot.evidence).toContainEqual({ path: "external.txt", classification: "unknown/external" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("provider adapters reject workspace-write without a matching lease", async () => {
    const options: TurnOptions = {
      ...readOnlyTurnOptions(),
      workspaceAccess: "workspace_write",
      writerLease: null,
    };
    const claude = new ClaudeAdapter((() => { throw new Error("must not start"); }) as never);
    const claudeSession = await claude.startSession({ projectRoot: process.cwd(), requestedModel: "default" });
    await expect(claude.startTurn(claudeSession, "write", options)).rejects.toThrow("matching writer lease");

    const codex = new CodexAdapter();
    const codexSession: SessionHandle = {
      provider: "codex",
      id: "thread",
      requestedModel: "default",
      effectiveModel: "default",
    };
    await expect(codex.startTurn(codexSession, "write", options)).rejects.toThrow("matching writer lease");

    const forged = {
      id: "forged",
      provider: "claude" as const,
      projectRoot: process.cwd(),
      grantedAt: new Date(0).toISOString(),
      baselineFingerprint: "forged",
    };
    await expect(claude.startTurn(claudeSession, "write", {
      ...options,
      writerLease: forged,
    })).rejects.toThrow("matching writer lease");
  });

  test("workspace boundary resolves symlink ancestors before approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "splitlane-m2-boundary-"));
    const outside = await mkdtemp(join(tmpdir(), "splitlane-m2-outside-"));
    try {
      await Bun.write(join(outside, "existing.txt"), "outside\n");
      await symlink(outside, join(root, "escape"), "dir");
      expect(isPathInsideWorkspace(root, "inside/new.txt")).toBe(true);
      expect(isPathInsideWorkspace(root, join("escape", "new.txt"))).toBe(false);
      expect(isPathInsideWorkspace(root, join(outside, "existing.txt"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("M3 reviewer handoff", () => {
  async function reviewRepository(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "splitlane-m3-review-"));
    await gitCommand(root, "init", "-q");
    await gitCommand(root, "config", "user.email", "test@example.invalid");
    await gitCommand(root, "config", "user.name", "Splitlane Test");
    await Bun.write(join(root, "existing.txt"), "baseline\n");
    await gitCommand(root, "add", "existing.txt");
    await gitCommand(root, "commit", "-qm", "baseline");
    return root;
  }

  test("review confirmation revokes the writer and runs only the peer read-only", async () => {
    const root = await reviewRepository();
    try {
      const claude = new FakeAdapter("claude", "complete");
      const codex = new FakeAdapter("codex", "review_findings");
      const orchestrator = new CompareOrchestrator(root, { claude, codex });
      await orchestrator.initialize();
      expect(await orchestrator.promoteWriter("claude", false)).toBe(true);
      orchestrator.setTarget("claude");
      await orchestrator.dispatch("Implement the guarded change");
      await waitFor(() => orchestrator.getSnapshot().lanes.claude.status === "COMPLETED");
      await Bun.write(join(root, "existing.txt"), "changed\n");

      expect(await orchestrator.prepareReview()).toBe(true);
      const draft = orchestrator.getSnapshot().review;
      expect(draft).toMatchObject({ status: "draft", writer: "claude", reviewer: "codex", mechanism: "codex_generic" });
      expect(orchestrator.getSnapshot().writer).toBe("claude");
      const starts = await Promise.all([
        orchestrator.startReview("The guard is tested and preserves existing behavior."),
        orchestrator.startReview("A concurrent handoff must lose."),
      ]);
      expect(starts).toEqual([true, false]);
      expect(orchestrator.getSnapshot().mode).toBe("review");
      expect(orchestrator.getSnapshot().writer).toBeNull();
      expect(orchestrator.getSnapshot().writerLease).toBeNull();
      await waitFor(() => orchestrator.getSnapshot().review?.status === "completed");
      expect(codex.turnOptions.at(-1)?.workspaceAccess).toBe("read_only");
      expect(codex.turnOptions.at(-1)?.writerLease).toBeNull();
      expect(codex.prompts.at(-1)).toContain("Implement the guarded change");
      expect(orchestrator.getSnapshot().review?.findings[0]).toMatchObject({
        id: "finding-1",
        provider: "codex",
        file: "existing.txt",
        lineStart: 1,
        selected: false,
      });
      await orchestrator.selectFinding("finding-1");
      expect(orchestrator.getSnapshot().review?.preview).toMatchObject({ file: "existing.txt", lineStart: 1, error: null });
      expect(orchestrator.getSnapshot().review?.preview?.content).toContain("changed");
      orchestrator.toggleFinding("finding-1");
      const relay = orchestrator.returnSelectedFindings(false);
      expect(relay).toContain("source: codex via codex_generic");
      expect(relay).toContain("The changed branch lacks a guard.");
      expect(orchestrator.getSnapshot().mode).toBe("compare");
      expect(orchestrator.getSnapshot().review?.status).toBe("returned");
      await orchestrator.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a changed diff must be reconfirmed before the writer lease is revoked", async () => {
    const root = await reviewRepository();
    try {
      const claude = new FakeAdapter("claude", "complete");
      const codex = new FakeAdapter("codex", "review_findings");
      const orchestrator = new CompareOrchestrator(root, { claude, codex });
      await orchestrator.initialize();
      await orchestrator.promoteWriter("claude", false);
      orchestrator.setTarget("claude");
      await orchestrator.dispatch("Change the file");
      await waitFor(() => orchestrator.getSnapshot().lanes.claude.status === "COMPLETED");
      await Bun.write(join(root, "existing.txt"), "first\n");
      await orchestrator.prepareReview();
      const firstHash = orchestrator.getSnapshot().review?.envelope.diffHash;
      await Bun.write(join(root, "existing.txt"), "second\n");
      expect(await orchestrator.startReview("Match the criteria")).toBe(false);
      expect(orchestrator.getSnapshot().mode).toBe("build");
      expect(orchestrator.getSnapshot().writer).toBe("claude");
      expect(orchestrator.getSnapshot().writerLease).not.toBeNull();
      expect(orchestrator.getSnapshot().review?.envelope.diffHash).not.toBe(firstHash);
      await orchestrator.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("review includes changes committed after writer promotion", async () => {
    const root = await reviewRepository();
    try {
      const claude = new FakeAdapter("claude", "complete");
      const codex = new FakeAdapter("codex", "review_findings");
      const orchestrator = new CompareOrchestrator(root, { claude, codex });
      await orchestrator.initialize();
      await orchestrator.promoteWriter("claude", false);
      orchestrator.setTarget("claude");
      await orchestrator.dispatch("Commit the implementation");
      await waitFor(() => orchestrator.getSnapshot().lanes.claude.status === "COMPLETED");
      await Bun.write(join(root, "existing.txt"), "committed by writer\n");
      await gitCommand(root, "add", "existing.txt");
      await gitCommand(root, "commit", "-qm", "writer change");
      await orchestrator.refreshGit();
      expect(orchestrator.getSnapshot().git.dirty).toBe(false);
      expect(await orchestrator.prepareReview()).toBe(true);
      expect(orchestrator.getSnapshot().review?.envelope.diff).toContain("committed by writer");
      expect(orchestrator.getSnapshot().review?.envelope.files).toContainEqual({
        path: "existing.txt",
        classification: "unknown/external",
      });
      await orchestrator.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("external workspace drift marks completed findings stale", async () => {
    const root = await reviewRepository();
    try {
      const claude = new FakeAdapter("claude", "complete");
      const codex = new FakeAdapter("codex", "review_delayed");
      const orchestrator = new CompareOrchestrator(root, { claude, codex });
      await orchestrator.initialize();
      await orchestrator.promoteWriter("claude", false);
      orchestrator.setTarget("claude");
      await orchestrator.dispatch("Change the file");
      await waitFor(() => orchestrator.getSnapshot().lanes.claude.status === "COMPLETED");
      await Bun.write(join(root, "existing.txt"), "review basis\n");
      await orchestrator.prepareReview();
      await orchestrator.startReview("No regressions");
      await waitFor(() => orchestrator.getSnapshot().review?.status === "running");
      await Bun.write(join(root, "existing.txt"), "external drift\n");
      await waitFor(() => orchestrator.getSnapshot().review?.status === "completed");
      expect(orchestrator.getSnapshot().review?.stale).toBe(true);
      orchestrator.toggleFinding("finding-1");
      expect(orchestrator.returnSelectedFindings(false)).toBeNull();
      expect(orchestrator.returnSelectedFindings(true)).toContain("finding-1");
      await orchestrator.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reviewer permission requests fail closed without entering the inbox", async () => {
    const root = await reviewRepository();
    try {
      const claude = new FakeAdapter("claude", "complete");
      const codex = new FakeAdapter("codex", "approval");
      const orchestrator = new CompareOrchestrator(root, { claude, codex });
      await orchestrator.initialize();
      await orchestrator.promoteWriter("claude", false);
      orchestrator.setTarget("claude");
      await orchestrator.dispatch("Change the file");
      await waitFor(() => orchestrator.getSnapshot().lanes.claude.status === "COMPLETED");
      await Bun.write(join(root, "existing.txt"), "changed\n");
      await orchestrator.prepareReview();
      await orchestrator.startReview("No writes during review");
      await waitFor(() => orchestrator.getSnapshot().review?.status === "completed");
      expect(codex.approvalDecisions).toEqual(["deny"]);
      expect(orchestrator.getSnapshot().approvals).toHaveLength(0);
      expect(orchestrator.getSnapshot().diagnostics.join("\n")).toContain("read-only lane was denied");
      await orchestrator.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("review patch captures symlinks as metadata and refuses oversized packets", async () => {
    const root = await reviewRepository();
    const outside = await mkdtemp(join(tmpdir(), "splitlane-m3-outside-"));
    try {
      await Bun.write(join(outside, "secret.txt"), "must not be followed\n");
      await symlink(join(outside, "secret.txt"), join(root, "linked.txt"));
      const patch = await captureReviewPatch(root, []);
      expect(patch.diff).toContain("<symlink:");
      expect(patch.diff).not.toContain("must not be followed");
      const preview = await loadFindingPreview(root, {
        id: "linked",
        provider: "codex",
        mechanism: "codex_generic",
        severity: "high",
        title: "linked",
        body: "linked",
        file: "linked.txt",
        lineStart: 1,
        lineEnd: 1,
        verification: null,
        selected: false,
      });
      expect(preview?.error).toContain("outside");
      expect(preview?.content).toBe("");
      await Bun.write(join(root, "large.txt"), "x".repeat(REVIEW_PATCH_LIMIT + 1));
      await expect(captureReviewPatch(root, [])).rejects.toThrow(/exceeds|Unable to capture/);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("structured findings reject duplicate IDs and outside-root paths", () => {
    const duplicate = `${FINDINGS_START}{"findings":[{"id":"same","severity":"high","title":"a","body":"a"},{"id":"same","severity":"low","title":"b","body":"b"}]}${FINDINGS_END}`;
    expect(parseReviewFindings(duplicate, "codex", "codex_generic", process.cwd()).error).toContain("unique");
    const outside = `${FINDINGS_START}{"findings":[{"id":"outside","severity":"high","title":"a","body":"a","file":"../secret"}]}${FINDINGS_END}`;
    expect(parseReviewFindings(outside, "codex", "codex_generic", process.cwd()).error).toContain("outside");
  });

  test("capability-gated native Codex review is visible, selectable, and explicitly invoked", async () => {
    const root = await reviewRepository();
    try {
      const claude = new FakeAdapter("claude", "complete");
      const codex = new FakeAdapter("codex", "review_findings", true);
      const orchestrator = new CompareOrchestrator(root, { claude, codex });
      await orchestrator.initialize();
      await orchestrator.promoteWriter("claude", false);
      orchestrator.setTarget("claude");
      await orchestrator.dispatch("Implement native-review target");
      await waitFor(() => orchestrator.getSnapshot().lanes.claude.status === "COMPLETED");
      await Bun.write(join(root, "existing.txt"), "native review\n");
      await orchestrator.prepareReview();
      expect(orchestrator.getSnapshot().review).toMatchObject({
        mechanism: "codex_native",
        availableMechanisms: ["codex_native", "codex_generic"],
        envelope: { mechanismStability: "preview" },
      });
      expect(orchestrator.setReviewMechanism("codex_generic")).toBe(true);
      expect(orchestrator.getSnapshot().review?.envelope.mechanismStability).toBe("stable");
      expect(orchestrator.setReviewMechanism("codex_native")).toBe(true);
      await orchestrator.startReview("Native review stays read-only");
      await waitFor(() => orchestrator.getSnapshot().review?.status === "completed");
      expect(codex.nativeReviewPrompts).toHaveLength(1);
      expect(orchestrator.getSnapshot().review?.mechanism).toBe("codex_native");
      await orchestrator.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  test("maps captured Codex approval requests to temporary UI decisions", async () => {
    const fixture = await Bun.file("test/fixtures/codex-m2-approvals.redacted.json").json() as {
      requests: Parameters<typeof parseCodexApprovalRequest>[0][];
    };
    const [command, file] = fixture.requests.map(parseCodexApprovalRequest);
    expect(command).toMatchObject({ tool: "Command execution", command: "touch output.txt", networkEffect: "off" });
    expect(file).toMatchObject({ providerRequestId: "file-42", tool: "File change", path: "<project-root>" });
    expect(codexApprovalResponse("allow_once")).toEqual({ decision: "accept" });
    expect(codexApprovalResponse("deny")).toEqual({ decision: "decline" });
    expect(codexApprovalResponse("cancel_turn")).toEqual({ decision: "cancel" });
    expect(parseCodexApprovalRequest({ id: 99, method: "unknown/request", params: {} })).toBeNull();
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
    const turn = await adapter.startTurn(session, "read only", readOnlyTurnOptions());
    const kinds: NormalizedEvent["kind"][] = [];
    for await (const item of turn.events) kinds.push(item.kind);
    expect(kinds).toEqual(["session.started", "turn.started", "turn.failed"]);
    expect(closeCalled).toBe(true);
  });

  test("Claude build approval maps allow-once without persistent permission updates", async () => {
    let permissionResult: Record<string, unknown> | null = null;
    let capturedOptions: Record<string, unknown> | null = null;
    let capturedRequest: unknown = null;
    const fakeQuery = ({ options }: { options: Record<string, unknown> }) => {
      capturedOptions = options;
      async function* stream() {
        yield { type: "system", subtype: "init", session_id: "session", model: "fake" };
        const callback = options.canUseTool as (
          tool: string,
          input: Record<string, unknown>,
          context: Record<string, unknown>,
        ) => Promise<Record<string, unknown>>;
        permissionResult = await callback("Bash", { command: "touch approved.txt" }, {
          signal: new AbortController().signal,
          toolUseID: "tool-use",
          requestId: "request-id",
          displayName: "Run command",
          decisionReason: "write a file",
        });
        yield { type: "result", subtype: "success", is_error: false };
      }
      return Object.assign(stream(), { close: () => {} });
    };
    const adapter = new ClaudeAdapter(fakeQuery as never);
    const session = await adapter.startSession({ projectRoot: process.cwd(), requestedModel: "default" });
    const guard = new WorkspaceGuard(process.cwd());
    const turn = await adapter.startTurn(session, "write once", {
      requestedModel: "default",
      projectRoot: process.cwd(),
      workspaceAccess: "workspace_write",
      writerLease: guard.grant("claude", "baseline"),
      requestApproval: async (request) => {
        capturedRequest = request;
        return "allow_once";
      },
    });
    for await (const _event of turn.events) {}
    expect(capturedRequest).toMatchObject({ tool: "Run command", command: "touch approved.txt", networkEffect: "off" });
    expect(permissionResult).toMatchObject({ behavior: "allow", decisionClassification: "user_temporary" });
    expect(permissionResult).not.toHaveProperty("updatedPermissions");
    expect(capturedOptions).toMatchObject({ permissionMode: "default" });
    expect(claudePermissionResult("deny", "tool-use")).toMatchObject({
      behavior: "deny",
      interrupt: false,
      decisionClassification: "user_reject",
    });
    expect(claudePermissionResult("cancel_turn", "tool-use")).toMatchObject({
      behavior: "deny",
      interrupt: true,
      decisionClassification: "user_reject",
    });
  });

  test("production JSONL transport reports malformed input and abrupt process exit", async () => {
    const notifications: string[] = [];
    const exitErrors: Error[] = [];
    let client: CodexRpcClient;
    client = new CodexRpcClient(
      (message) => { if (message.method) notifications.push(message.method); },
      (message) => {
        if (message.id !== undefined) client.respond(message.id, { decision: "decline" });
      },
      (error) => { exitErrors.push(error); },
      process.execPath,
      ["test/fixtures/fake-jsonl-server.mjs"],
    );
    await client.start();
    const initialized = await client.request<{ userAgent: string }>("initialize", {});
    expect(initialized.userAgent).toBe("fake-app-server/1.0");
    client.notify("emit/malformed");
    await waitFor(() => notifications.includes("diagnostic/malformed"));
    client.notify("request/server");
    await waitFor(() => notifications.includes("approval/observed"));
    client.notify("exit/abrupt");
    await waitFor(() => exitErrors.length > 0);
    expect(exitErrors[0]?.message).toContain("code=17");
    await client.close();
  });

  test("Codex native review/start streams and cancels through a fake app-server", async () => {
    const adapter = new CodexAdapter({
      nativeReviewAvailable: true,
      rpcFactory: (onNotification, onServerRequest, onExit) => new CodexRpcClient(
        onNotification,
        onServerRequest,
        onExit,
        process.execPath,
        ["test/fixtures/fake-codex-review-app-server.mjs"],
      ),
    });
    const session = await adapter.startSession({ projectRoot: process.cwd(), requestedModel: "default" });
    expect(adapter.reviewMechanisms).toEqual(["codex_native", "codex_generic"]);
    const turn = await adapter.startReview(session, "review envelope", readOnlyTurnOptions());
    const events: NormalizedEvent[] = [];
    for await (const item of turn.events) events.push(item);
    expect(events.map(({ kind }) => kind)).toEqual(["turn.started", "message.delta", "turn.completed"]);
    expect(events.find(({ kind }) => kind === "message.delta")?.payload.text).toContain(FINDINGS_START);

    const early = await adapter.startReview(session, "early-native-review", readOnlyTurnOptions());
    const earlyEvents: NormalizedEvent[] = [];
    for await (const item of early.events) earlyEvents.push(item);
    expect(earlyEvents.map(({ kind }) => kind)).toEqual(["turn.started", "message.delta", "turn.completed"]);
    expect(earlyEvents.every(({ turn_id }) => turn_id === early.id)).toBe(true);

    let nativeApproval: unknown = null;
    const approvalTurn = await adapter.startReview(session, "approval-native-review", {
      ...readOnlyTurnOptions(),
      requestApproval: async (request) => {
        nativeApproval = request;
        return "deny";
      },
    });
    const approvalEvents: NormalizedEvent[] = [];
    for await (const item of approvalTurn.events) approvalEvents.push(item);
    expect(nativeApproval).toMatchObject({ kind: "file_change", reason: "native review must remain read-only" });
    expect(approvalEvents.map(({ kind }) => kind)).toEqual([
      "turn.started",
      "approval.requested",
      "approval.resolved",
      "message.delta",
      "turn.completed",
    ]);

    const held = await adapter.startReview(session, "hold-native-review", readOnlyTurnOptions());
    await adapter.interrupt(held.id);
    const cancelled: NormalizedEvent[] = [];
    for await (const item of held.events) cancelled.push(item);
    expect(cancelled.map(({ kind }) => kind)).toEqual(["turn.started", "turn.cancelled"]);
    await adapter.close();
  });

  test("captured Codex review schema enables native review without a model turn", async () => {
    const fixture = await Bun.file("test/fixtures/codex-m3-review-start.redacted.json").json() as {
      model_turn_started: boolean;
      schema_markers: string[];
      request: { method: string; params: Record<string, unknown> };
      cancellation_method: string;
    };
    expect(fixture.model_turn_started).toBe(false);
    expect(supportsCodexNativeReviewSchema(fixture.schema_markers.join(" "))).toBe(true);
    expect(fixture.request).toMatchObject({ method: "review/start", params: { delivery: "inline", target: { type: "custom" } } });
    expect(fixture.request.params).not.toHaveProperty("sandboxPolicy");
    expect(fixture.cancellation_method).toBe("turn/interrupt");
  });

  test("Codex runtime probe enables native review only after local schema generation", async () => {
    const adapter = new CodexAdapter({
      command: join(process.cwd(), "test/fixtures/fake-codex-schema-cli.mjs"),
    });
    expect(adapter.reviewMechanisms).toEqual(["codex_generic"]);
    expect(await adapter.probe()).toMatchObject({ available: true, version: "codex-cli 0.145.0" });
    expect(adapter.reviewMechanisms).toEqual(["codex_native", "codex_generic"]);
    await adapter.close();
  });
});
