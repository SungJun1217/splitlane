import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
  AppSnapshot,
  LaneSnapshot,
  NormalizedEvent,
  PendingApproval,
  PromptEnvelope,
  PromptTarget,
  ProviderApprovalRequest,
  ProviderAdapter,
  ProviderId,
  RoleId,
  RoleProfile,
  SessionHandle,
  WriterLease,
} from "../domain.ts";
import { GitObserver } from "../git/observer.ts";
import { appendBounded, sanitizeTerminalText } from "../terminal/sanitize.ts";
import { isPathInsideWorkspace, WorkspaceGuard } from "../workspace/guard.ts";

// Visible M1 routing hypotheses only; this is not the approved v0.1 default profile.
const M1_PREVIEW_ROLES: RoleProfile = {
  scout: "claude",
  architect: "claude",
  builder: "codex",
  debugger: "codex",
  intent_reviewer: "claude",
  correctness_reviewer: "codex",
};

const blankLane = (provider: ProviderId): LaneSnapshot => ({
  provider,
  status: "READY",
  requestedModel: "default",
  effectiveModel: "default",
  sessionId: null,
  turnId: null,
  output: "",
  toolSummary: null,
  error: null,
});

const canAccept = (lane: LaneSnapshot): boolean =>
  ["READY", "COMPLETED", "FAILED", "CANCELLED"].includes(lane.status);

export class CompareOrchestrator {
  readonly #listeners = new Set<() => void>();
  readonly #sessions = new Map<ProviderId, SessionHandle>();
  readonly #approvalResolvers = new Map<string, (decision: ApprovalDecision) => void>();
  readonly #git: GitObserver;
  readonly #workspace: WorkspaceGuard;
  #revokeAfterTurn: ProviderId | null = null;
  #gitRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  #promotionPending = false;
  #snapshot: AppSnapshot;

  constructor(
    readonly projectRoot: string,
    readonly adapters: Record<ProviderId, ProviderAdapter>,
  ) {
    this.#git = new GitObserver(projectRoot);
    this.#workspace = new WorkspaceGuard(projectRoot);
    this.#snapshot = {
      mode: "compare",
      writer: null,
      writerLease: null,
      writerRevoking: false,
      target: "both",
      focusedProvider: "claude",
      inspectorVisible: true,
      lanes: { claude: blankLane("claude"), codex: blankLane("codex") },
      git: this.#git.snapshot,
      roles: { ...M1_PREVIEW_ROLES },
      approvals: [],
      diagnostics: [],
      notice: null,
    };
  }

  getSnapshot = (): AppSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #publish(next: AppSnapshot): void {
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }

  #patch(patch: Partial<AppSnapshot>): void {
    this.#publish({ ...this.#snapshot, ...patch });
  }

  #patchLane(provider: ProviderId, patch: Partial<LaneSnapshot>): void {
    this.#publish({
      ...this.#snapshot,
      lanes: {
        ...this.#snapshot.lanes,
        [provider]: { ...this.#snapshot.lanes[provider], ...patch },
      },
    });
  }

  #diagnose(provider: ProviderId, message: unknown): void {
    const clean = sanitizeTerminalText(message).trim();
    if (!clean) return;
    this.#patch({ diagnostics: [...this.#snapshot.diagnostics, `${provider}: ${clean}`].slice(-100) });
  }

  async initialize(): Promise<void> {
    const [claude, codex, git] = await Promise.all([
      this.adapters.claude.probe(),
      this.adapters.codex.probe(),
      this.#git.refresh(),
    ]);
    const claudeError = claude.available ? null : sanitizeTerminalText(claude.error ?? "Claude unavailable");
    const codexError = codex.available ? null : sanitizeTerminalText(codex.error ?? "Codex unavailable");
    this.#publish({
      ...this.#snapshot,
      git,
      diagnostics: [
        ...this.#snapshot.diagnostics,
        ...(claudeError ? [`claude: ${claudeError}`] : []),
        ...(codexError ? [`codex: ${codexError}`] : []),
      ].slice(-100),
      lanes: {
        claude: claude.available
          ? this.#snapshot.lanes.claude
          : { ...this.#snapshot.lanes.claude, status: "UNAVAILABLE", error: claudeError },
        codex: codex.available
          ? this.#snapshot.lanes.codex
          : { ...this.#snapshot.lanes.codex, status: "UNAVAILABLE", error: codexError },
      },
    });
  }

  setTarget(target: PromptTarget): void {
    this.#patch({ target, notice: null });
  }

  cycleTarget(): void {
    const targets: PromptTarget[] = ["both", "claude", "codex"];
    const index = targets.indexOf(this.#snapshot.target);
    this.setTarget(targets[(index + 1) % targets.length] ?? "both");
  }

  focus(provider: ProviderId): void {
    this.#patch({ focusedProvider: provider });
  }

  toggleInspector(): void {
    this.#patch({ inspectorVisible: !this.#snapshot.inspectorVisible });
  }

  setModel(provider: ProviderId, model: string): void {
    const requestedModel = model.trim() || "default";
    this.#sessions.delete(provider);
    this.#patchLane(provider, {
      requestedModel,
      effectiveModel: requestedModel,
      sessionId: null,
    });
    this.#patch({ notice: `${provider} model set for next request; provider session reset.` });
  }

  setRole(role: RoleId, provider: ProviderId): void {
    this.#patch({
      roles: { ...this.#snapshot.roles, [role]: provider },
      notice: `${role} role set to ${provider}; prompt routing did not change.`,
    });
  }

  async promoteWriter(provider: ProviderId, dirtyTreeAcknowledged: boolean): Promise<boolean> {
    if (this.#snapshot.writer || this.#snapshot.writerLease || this.#promotionPending) {
      this.#patch({ notice: `A writer lease already belongs to ${this.#snapshot.writer}.` });
      return false;
    }
    if (!canAccept(this.#snapshot.lanes[provider])) {
      this.#patch({ notice: `${provider} cannot become writer while its lane is active.` });
      return false;
    }
    this.#promotionPending = true;
    try {
      const git = await this.#git.refresh();
      this.#patch({ git });
      if (git.error) {
        this.#patch({ notice: `Build mode requires a Git repository: ${git.error}` });
        return false;
      }
      if (git.dirty && !dirtyTreeAcknowledged) {
        this.#patch({ notice: "Dirty working tree must be acknowledged before writer promotion." });
        return false;
      }
      const baselineFingerprint = await this.#git.captureBaseline();
      const lease = this.#workspace.grant(provider, baselineFingerprint);
      this.#patch({
        mode: "build",
        writer: provider,
        writerLease: lease,
        writerRevoking: false,
        git: this.#git.snapshot,
        notice: `${provider} is the only writer. Network access remains off; prompt target did not change.`,
      });
      return true;
    } catch (error) {
      this.#patch({ notice: `Writer promotion failed: ${sanitizeTerminalText((error as Error).message)}` });
      return false;
    } finally {
      this.#promotionPending = false;
    }
  }

  async revokeWriter(): Promise<void> {
    const writer = this.#snapshot.writer;
    if (!writer) return;
    const lane = this.#snapshot.lanes[writer];
    if (["STARTING", "RUNNING", "BLOCKED", "CANCELLING"].includes(lane.status)) {
      this.#revokeAfterTurn = writer;
      this.#patch({ writerRevoking: true, notice: `Cancelling ${writer} before revoking its writer lease.` });
      await this.cancel(writer);
      return;
    }
    this.#completeRevocation(writer);
  }

  #completeRevocation(provider: ProviderId): void {
    if (this.#snapshot.writer !== provider) return;
    const lease = this.#snapshot.writerLease;
    this.#resolveApprovalsFor(provider, "cancel_turn");
    if (lease) this.#workspace.revoke(lease.id);
    this.#git.clearBaseline();
    this.#revokeAfterTurn = null;
    this.#patch({
      mode: "compare",
      writer: null,
      writerLease: null,
      writerRevoking: false,
      git: this.#git.snapshot,
      notice: `${provider} writer lease revoked; compare mode restored.`,
    });
  }

  resolveApproval(id: string, decision: ApprovalDecision): boolean {
    const approval = this.#snapshot.approvals.find((item) => item.id === id);
    const resolve = this.#approvalResolvers.get(id);
    if (!approval || !resolve) return false;
    this.#approvalResolvers.delete(id);
    const remaining = this.#snapshot.approvals.filter((item) => item.id !== id);
    this.#patch({ approvals: remaining });
    resolve(decision);
    if (decision === "cancel_turn") void this.cancel(approval.provider);
    else if (
      !remaining.some((item) => item.provider === approval.provider) &&
      this.#snapshot.lanes[approval.provider].status === "BLOCKED"
    ) {
      this.#patchLane(approval.provider, { status: "RUNNING" });
    }
    return true;
  }

  #resolveApprovalsFor(provider: ProviderId, decision: ApprovalDecision): void {
    const matching = this.#snapshot.approvals.filter((item) => item.provider === provider);
    for (const approval of matching) {
      const resolve = this.#approvalResolvers.get(approval.id);
      this.#approvalResolvers.delete(approval.id);
      resolve?.(decision);
    }
    if (matching.length) {
      const ids = new Set(matching.map(({ id }) => id));
      this.#patch({ approvals: this.#snapshot.approvals.filter((item) => !ids.has(item.id)) });
    }
  }

  async #requestApproval(
    provider: ProviderId,
    turnId: string,
    request: ProviderApprovalRequest,
  ): Promise<ApprovalDecision> {
    const lease = this.#snapshot.writerLease;
    const allowedWriter = this.#snapshot.mode === "build" &&
      this.#snapshot.writer === provider &&
      this.#workspace.validate(lease, provider);
    if (!allowedWriter) {
      this.#diagnose(provider, "Unexpected approval request from a read-only lane was denied.");
      this.#patchLane(provider, { toolSummary: "unexpected approval denied (read-only)" });
      return "deny";
    }
    const id = randomUUID();
    const requestedPaths = [...request.paths, request.path, request.cwd].filter((value): value is string => Boolean(value));
    const outsideWorkspace = requestedPaths.some((path) => !isPathInsideWorkspace(this.projectRoot, path));
    const unknownFileBoundary = request.kind === "file_change" && request.paths.length === 0 && !request.path;
    if (outsideWorkspace || unknownFileBoundary || request.networkEffect === "requested") {
      const reason = outsideWorkspace
        ? "outside the writer workspace"
        : unknownFileBoundary
          ? "file-change boundary is unknown"
          : "network access is disabled";
      this.#diagnose(provider, `Approval request denied: ${reason}.`);
      this.#patch({ notice: `${provider} approval denied: ${reason}.` });
      this.#patchLane(provider, { toolSummary: `approval denied: ${reason}` });
      return "deny";
    }
    const approval: PendingApproval = {
      ...request,
      id,
      provider,
      turnId,
      requestedAt: new Date().toISOString(),
      outsideWorkspace,
    };
    this.#patch({
      approvals: [...this.#snapshot.approvals, approval],
      notice: `${provider} is blocked on approval: ${request.tool}`,
    });
    this.#patchLane(provider, { status: "BLOCKED", toolSummary: `approval: ${request.tool}` });
    return new Promise<ApprovalDecision>((resolve) => this.#approvalResolvers.set(id, resolve));
  }

  async dispatch(prompt: string): Promise<boolean> {
    const cleanPrompt = prompt.trim();
    if (!cleanPrompt) {
      this.#patch({ notice: "Prompt is empty." });
      return false;
    }
    const selected: ProviderId[] =
      this.#snapshot.target === "both" ? ["claude", "codex"] : [this.#snapshot.target];
    const unavailable = selected.find((provider) => !canAccept(this.#snapshot.lanes[provider]));
    if (unavailable) {
      this.#patch({
        notice: this.#snapshot.target === "both"
          ? `${unavailable} cannot accept a turn; nothing was sent. Choose another target explicitly or wait.`
          : `${unavailable} cannot accept a turn.`,
      });
      return false;
    }

    const envelope: PromptEnvelope = Object.freeze({
      envelopeId: randomUUID(),
      createdAt: new Date().toISOString(),
      prompt: cleanPrompt,
    });
    for (const provider of selected) {
      this.#patchLane(provider, { status: "STARTING", error: null, toolSummary: null });
    }
    this.#patch({ notice: null });
    void Promise.allSettled(selected.map((provider) => this.#runLane(provider, envelope)));
    return true;
  }

  async #runLane(provider: ProviderId, envelope: PromptEnvelope): Promise<void> {
    const adapter = this.adapters[provider];
    try {
      let session = this.#sessions.get(provider);
      const requestedModel = this.#snapshot.lanes[provider].requestedModel;
      if (!session) {
        session = await adapter.startSession({ projectRoot: this.projectRoot, requestedModel });
        this.#sessions.set(provider, session);
        this.#patchLane(provider, {
          sessionId: session.id || null,
          effectiveModel: session.effectiveModel,
        });
      }
      const lease = this.#snapshot.writerLease;
      const workspaceAccess = this.#snapshot.mode === "build" &&
          this.#snapshot.writer === provider &&
          this.#workspace.validate(lease, provider)
        ? "workspace_write"
        : "read_only";
      const turn = await adapter.startTurn(session, envelope.prompt, {
        requestedModel,
        projectRoot: this.projectRoot,
        workspaceAccess,
        writerLease: workspaceAccess === "workspace_write" ? lease : null,
        requestApproval: (request) => this.#requestApproval(
          provider,
          this.#snapshot.lanes[provider].turnId ?? "starting",
          request,
        ),
      });
      this.#patchLane(provider, { turnId: turn.id });
      if (this.#revokeAfterTurn === provider) await this.cancel(provider);
      for await (const providerEvent of turn.events) this.#applyEvent(provider, providerEvent);
    } catch (error) {
      this.#diagnose(provider, (error as Error).message);
      this.#patchLane(provider, {
        status: "FAILED",
        error: sanitizeTerminalText((error as Error).message),
        turnId: null,
      });
      if (this.#snapshot.writer === provider || this.#revokeAfterTurn === provider) this.#completeRevocation(provider);
    }
  }

  #applyEvent(provider: ProviderId, providerEvent: NormalizedEvent): void {
    if (providerEvent.provider !== provider) {
      this.#diagnose(provider, "Cross-provider event rejected.");
      this.#patchLane(provider, { status: "FAILED", error: "Cross-provider event rejected." });
      if (this.#snapshot.writer === provider) this.#completeRevocation(provider);
      return;
    }
    const lane = this.#snapshot.lanes[provider];
    switch (providerEvent.kind) {
      case "session.started":
      case "session.resumed":
        this.#patchLane(provider, {
          sessionId: providerEvent.session_id,
          effectiveModel: typeof providerEvent.payload.effective_model === "string"
            ? providerEvent.payload.effective_model
            : lane.effectiveModel,
        });
        break;
      case "turn.started":
        this.#patchLane(provider, { status: "RUNNING", turnId: providerEvent.turn_id });
        break;
      case "message.delta":
        this.#patchLane(provider, {
          output: appendBounded(lane.output, String(providerEvent.payload.text ?? "")),
        });
        break;
      case "tool.started":
        this.#patchLane(provider, { toolSummary: `tool: ${String(providerEvent.payload.tool ?? "unknown")}` });
        break;
      case "tool.completed":
        this.#patchLane(provider, { toolSummary: `tool completed: ${String(providerEvent.payload.tool ?? "unknown")}` });
        break;
      case "file.changed": {
        const path = typeof providerEvent.payload.path === "string" ? providerEvent.payload.path : null;
        if (this.#snapshot.writer === provider) this.#git.noteWriterChange(path);
        if (this.#gitRefreshTimer) clearTimeout(this.#gitRefreshTimer);
        this.#gitRefreshTimer = setTimeout(() => {
          this.#gitRefreshTimer = null;
          void this.refreshGit();
        }, 150);
        break;
      }
      case "approval.requested":
        if (this.#snapshot.approvals.some((approval) => approval.provider === provider)) {
          this.#patchLane(provider, { status: "BLOCKED" });
        }
        break;
      case "approval.resolved":
        if (!this.#snapshot.approvals.some((approval) => approval.provider === provider)) {
          this.#patchLane(provider, { status: "RUNNING" });
        }
        break;
      case "turn.completed":
        this.#resolveApprovalsFor(provider, "cancel_turn");
        this.#patchLane(provider, { status: "COMPLETED", turnId: null });
        void this.refreshGit();
        if (this.#revokeAfterTurn === provider) this.#completeRevocation(provider);
        break;
      case "turn.cancelled":
        this.#resolveApprovalsFor(provider, "cancel_turn");
        this.#patchLane(provider, { status: "CANCELLED", turnId: null });
        void this.refreshGit();
        if (this.#snapshot.writer === provider || this.#revokeAfterTurn === provider) this.#completeRevocation(provider);
        break;
      case "turn.failed":
        this.#resolveApprovalsFor(provider, "cancel_turn");
        this.#diagnose(provider, providerEvent.payload.error ?? "Provider turn failed");
        this.#patchLane(provider, {
          status: "FAILED",
          turnId: null,
          error: sanitizeTerminalText(providerEvent.payload.error ?? "Provider turn failed"),
        });
        void this.refreshGit();
        if (this.#snapshot.writer === provider || this.#revokeAfterTurn === provider) this.#completeRevocation(provider);
        break;
      case "provider.warning":
        this.#diagnose(provider, providerEvent.payload.message ?? "Provider warning");
        this.#patchLane(provider, { error: sanitizeTerminalText(providerEvent.payload.message ?? "Provider warning") });
        break;
    }
  }

  async cancel(provider: ProviderId): Promise<void> {
    const lane = this.#snapshot.lanes[provider];
    if (!lane.turnId || !["STARTING", "RUNNING", "BLOCKED"].includes(lane.status)) return;
    this.#resolveApprovalsFor(provider, "cancel_turn");
    this.#patchLane(provider, { status: "CANCELLING" });
    try {
      await this.adapters[provider].interrupt(lane.turnId);
    } catch (error) {
      this.#diagnose(provider, (error as Error).message);
      this.#patchLane(provider, { status: "FAILED", error: sanitizeTerminalText((error as Error).message) });
      if (this.#snapshot.writer === provider) this.#completeRevocation(provider);
    }
  }

  async refreshGit(): Promise<void> {
    const git = await this.#git.refresh();
    this.#patch({ git });
  }

  async close(): Promise<void> {
    if (this.#gitRefreshTimer) clearTimeout(this.#gitRefreshTimer);
    this.#gitRefreshTimer = null;
    this.#resolveApprovalsFor("claude", "cancel_turn");
    this.#resolveApprovalsFor("codex", "cancel_turn");
    await Promise.allSettled(Object.values(this.adapters).map((adapter) => adapter.close()));
    if (this.#snapshot.writer) this.#completeRevocation(this.#snapshot.writer);
  }
}
