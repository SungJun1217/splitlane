import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
  AppSnapshot,
  LaneActivity,
  LaneActivityKind,
  LaneActivityStatus,
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
  ReviewMechanism,
  ReviewSnapshot,
  SessionHandle,
  TurnOptions,
  WriterLease,
} from "../domain.ts";
import { GitObserver } from "../git/observer.ts";
import { appendBounded, sanitizeTerminalText } from "../terminal/sanitize.ts";
import { isPathInsideWorkspace, WorkspaceGuard } from "../workspace/guard.ts";
import { captureReviewPatch, createReviewEnvelope, reviewMechanismStability } from "../review/envelope.ts";
import { buildFindingsRelay, buildReviewPrompt, parseReviewFindings } from "../review/findings.ts";
import { loadFindingPreview } from "../review/preview.ts";
import { classifyProviderError } from "./provider-error.ts";

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
  errorKind: null,
  activities: [],
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
  #reviewPending = false;
  #lastWriterPrompt: string | null = null;
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
      review: null,
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

  #addActivity(
    provider: ProviderId,
    activity: Omit<LaneActivity, "timestamp" | "completedAt" | "durationMs"> & {
      timestamp?: string;
      completedAt?: string | null;
      durationMs?: number | null;
    },
  ): void {
    const lane = this.#snapshot.lanes[provider];
    const detail = activity.detail ? sanitizeTerminalText(activity.detail).slice(0, 4_096) : null;
    this.#patchLane(provider, {
      activities: [...lane.activities, {
        ...activity,
        title: sanitizeTerminalText(activity.title).slice(0, 256),
        detail,
        safetyEffect: activity.safetyEffect ? sanitizeTerminalText(activity.safetyEffect).slice(0, 256) : null,
        timestamp: activity.timestamp ?? new Date().toISOString(),
        completedAt: activity.completedAt ?? (activity.status === "running" || activity.status === "blocked" ? null : activity.timestamp ?? new Date().toISOString()),
        durationMs: activity.durationMs ?? (activity.status === "running" || activity.status === "blocked" ? null : 0),
      }].slice(-100),
    });
  }

  #resolveActivity(
    provider: ProviderId,
    kind: LaneActivityKind,
    status: LaneActivityStatus,
    detail?: string | null,
  ): void {
    const lane = this.#snapshot.lanes[provider];
    const index = lane.activities.findLastIndex((item) =>
      item.kind === kind && ["running", "blocked"].includes(item.status)
    );
    if (index < 0) return;
    const completedAt = new Date().toISOString();
    this.#patchLane(provider, {
      activities: lane.activities.map((item, itemIndex) => itemIndex === index
        ? {
            ...item,
            status,
            detail: detail ? sanitizeTerminalText(detail).slice(0, 4_096) : item.detail,
            completedAt,
            durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(item.timestamp)),
          }
        : item),
    });
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
          : { ...this.#snapshot.lanes.claude, status: "UNAVAILABLE", error: claudeError, errorKind: classifyProviderError(claudeError) },
        codex: codex.available
          ? this.#snapshot.lanes.codex
          : { ...this.#snapshot.lanes.codex, status: "UNAVAILABLE", error: codexError, errorKind: classifyProviderError(codexError) },
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

  showNotice(message: string): void {
    this.#patch({ notice: sanitizeTerminalText(message).trim().slice(0, 1_024) || null });
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
    if (this.#reviewPending) {
      this.#patch({ notice: "Wait for the review handoff check to finish." });
      return false;
    }
    if (this.#snapshot.mode !== "compare") {
      this.#patch({ notice: "Writer promotion is available only from compare mode." });
      return false;
    }
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
      this.#lastWriterPrompt = null;
      return true;
    } catch (error) {
      this.#patch({ notice: `Writer promotion failed: ${sanitizeTerminalText((error as Error).message)}` });
      return false;
    } finally {
      this.#promotionPending = false;
    }
  }

  async revokeWriter(): Promise<void> {
    if (this.#reviewPending) {
      this.#patch({ notice: "Wait for the review handoff check to finish before revoking the writer." });
      return;
    }
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
      review: this.#snapshot.review?.status === "draft" ? null : this.#snapshot.review,
      notice: `${provider} writer lease revoked; compare mode restored.`,
    });
  }

  async prepareReview(): Promise<boolean> {
    if (this.#reviewPending || this.#snapshot.mode !== "build" || !this.#snapshot.writer || !this.#snapshot.writerLease) {
      this.#patch({ notice: "Review handoff requires an active build writer lease." });
      return false;
    }
    const writer = this.#snapshot.writer;
    const reviewer: ProviderId = writer === "claude" ? "codex" : "claude";
    if (!canAccept(this.#snapshot.lanes[writer]) || !canAccept(this.#snapshot.lanes[reviewer])) {
      this.#patch({ notice: "Review handoff requires both writer and reviewer lanes to be idle." });
      return false;
    }
    if (this.#snapshot.approvals.length) {
      this.#patch({ notice: "Resolve every pending approval before review handoff." });
      return false;
    }
    if (!this.#lastWriterPrompt) {
      this.#patch({ notice: "Review handoff requires a completed writer prompt as its objective." });
      return false;
    }
    this.#reviewPending = true;
    try {
      const git = await this.#git.refresh();
      this.#patch({ git });
      if (git.error) throw new Error(git.error);
      const baselineHead = this.#git.baselineHead;
      if (!baselineHead) throw new Error("Review handoff lost its Git baseline revision.");
      const patch = await captureReviewPatch(git.root, git.evidence, { baseRevision: baselineHead });
      const generic = `${reviewer}_generic` as ReviewMechanism;
      const advertised = this.adapters[reviewer].reviewMechanisms ?? [generic];
      const availableMechanisms = advertised.filter((mechanism) =>
        mechanism === generic || (reviewer === "codex" && mechanism === "codex_native")
      );
      const mechanism = availableMechanisms.includes("codex_native") ? "codex_native" : generic;
      const envelope = createReviewEnvelope({
        writer,
        reviewer,
        mechanism,
        objective: this.#lastWriterPrompt,
        acceptanceCriteria: "",
        projectRoot: this.projectRoot,
        baselineFingerprint: this.#snapshot.writerLease.baselineFingerprint,
        patch,
      });
      this.#patch({
        git: this.#git.snapshot,
        review: {
          status: "draft",
          writer,
          reviewer,
          mechanism,
          availableMechanisms: availableMechanisms.length ? availableMechanisms : [generic],
          envelope,
          findings: [],
          activeFindingId: null,
          preview: null,
          stale: false,
          parseError: null,
        },
        notice: `Review draft ready for ${reviewer}; writer lease remains active until confirmation.`,
      });
      return true;
    } catch (error) {
      this.#patch({ notice: `Review handoff refused: ${sanitizeTerminalText((error as Error).message)}` });
      return false;
    } finally {
      this.#reviewPending = false;
    }
  }

  async startReview(acceptanceCriteria: string): Promise<boolean> {
    const review = this.#snapshot.review;
    const lease = this.#snapshot.writerLease;
    const criteria = sanitizeTerminalText(acceptanceCriteria).trim();
    if (this.#reviewPending || !review || review.status !== "draft" || this.#snapshot.mode !== "build" || !lease || !criteria) {
      this.#patch({ notice: criteria ? "Review draft is no longer valid." : "Acceptance criteria are required." });
      return false;
    }
    if (!this.#workspace.validate(lease, review.writer) || this.#snapshot.writer !== review.writer) {
      this.#patch({ notice: "Review handoff lost its matching writer lease." });
      return false;
    }
    this.#reviewPending = true;
    try {
      const git = await this.#git.refresh();
      const current = await captureReviewPatch(git.root, git.evidence, { baseRevision: review.envelope.head });
      if (
        this.#snapshot.mode !== "build" ||
        this.#snapshot.review?.envelope.id !== review.envelope.id ||
        this.#snapshot.writer !== review.writer ||
        this.#snapshot.writerLease !== lease ||
        !this.#workspace.validate(lease, review.writer)
      ) {
        throw new Error("Review handoff state changed while the diff was being verified.");
      }
      if (current.diffHash !== review.envelope.diffHash) {
        const envelope = createReviewEnvelope({
          writer: review.writer,
          reviewer: review.reviewer,
          mechanism: review.mechanism,
          objective: review.envelope.objective,
          acceptanceCriteria: "",
          projectRoot: this.projectRoot,
          baselineFingerprint: lease.baselineFingerprint,
          patch: current,
        });
        this.#patch({ git, review: { ...review, envelope }, notice: "Diff changed while confirming review; inspect and confirm the refreshed hash." });
        return false;
      }
      if (!this.#workspace.revoke(lease.id)) throw new Error("Writer lease revocation failed before review.");
      const envelope = Object.freeze({ ...review.envelope, acceptanceCriteria: criteria });
      const running: ReviewSnapshot = { ...review, status: "running", envelope, findings: [], activeFindingId: null, preview: null, stale: false, parseError: null };
      this.#patchLane(review.reviewer, { output: "", error: null, errorKind: null, toolSummary: "read-only review" });
      this.#patch({
        mode: "review",
        writer: null,
        writerLease: null,
        writerRevoking: false,
        review: running,
        focusedProvider: review.reviewer,
        notice: `${review.writer} paused; ${review.reviewer} review started read-only via ${review.mechanism}.`,
      });
      void this.#runReview(running);
      return true;
    } catch (error) {
      this.#patch({ notice: `Review start failed: ${sanitizeTerminalText((error as Error).message)}` });
      return false;
    } finally {
      this.#reviewPending = false;
    }
  }

  setReviewMechanism(mechanism: ReviewMechanism): boolean {
    const review = this.#snapshot.review;
    if (!review || review.status !== "draft" || !review.availableMechanisms.includes(mechanism)) return false;
    this.#patch({
      review: {
        ...review,
        mechanism,
        envelope: Object.freeze({
          ...review.envelope,
          mechanism,
          mechanismStability: reviewMechanismStability(mechanism),
        }),
      },
      notice: `Review mechanism set to ${mechanism}; no provider turn was started.`,
    });
    return true;
  }

  async #runReview(review: ReviewSnapshot): Promise<void> {
    const envelope: PromptEnvelope = Object.freeze({
      envelopeId: review.envelope.id,
      createdAt: review.envelope.createdAt,
      prompt: buildReviewPrompt(review.envelope),
    });
    await this.#runLane(review.reviewer, envelope, review.mechanism);
    if (this.#snapshot.mode !== "review" || this.#snapshot.review?.envelope.id !== review.envelope.id) return;
    let stale = true;
    try {
      const git = await this.#git.refresh();
      const current = await captureReviewPatch(git.root, git.evidence, { baseRevision: review.envelope.head });
      stale = current.diffHash !== review.envelope.diffHash;
      this.#patch({ git });
    } catch {}
    const lane = this.#snapshot.lanes[review.reviewer];
    const parsed = lane.status === "COMPLETED"
      ? parseReviewFindings(lane.output, review.reviewer, review.mechanism, this.projectRoot)
      : { findings: [], error: lane.error ?? `Review ended with ${lane.status}.` };
    const status: ReviewSnapshot["status"] = lane.status === "COMPLETED"
      ? "completed"
      : lane.status === "CANCELLED"
        ? "cancelled"
        : "failed";
    this.#patch({
      review: { ...review, status, findings: parsed.findings, activeFindingId: parsed.findings[0]?.id ?? null, preview: null, stale, parseError: parsed.error },
      notice: parsed.error
        ? `Review finished without structured findings: ${parsed.error}`
        : `Review completed with ${parsed.findings.length} finding(s)${stale ? " · STALE" : ""}.`,
    });
  }

  toggleFinding(id: string): void {
    const review = this.#snapshot.review;
    if (!review) return;
    this.#patch({
      review: {
        ...review,
        findings: review.findings.map((finding) => finding.id === id ? { ...finding, selected: !finding.selected } : finding),
      },
    });
  }

  async selectFinding(id: string): Promise<void> {
    const review = this.#snapshot.review;
    const finding = review?.findings.find((item) => item.id === id);
    if (!review || !finding) return;
    this.#patch({ review: { ...review, activeFindingId: id, preview: null } });
    const preview = await loadFindingPreview(this.projectRoot, finding);
    if (this.#snapshot.review?.envelope.id !== review.envelope.id || this.#snapshot.review.activeFindingId !== id) return;
    this.#patch({ review: { ...this.#snapshot.review, preview } });
  }

  finishReview(action: "accept" | "exit"): boolean {
    const review = this.#snapshot.review;
    if (!review || this.#snapshot.mode !== "review" || review.status === "running") return false;
    this.#git.clearBaseline();
    this.#patch({
      mode: "compare",
      review: { ...review, status: action === "accept" ? "accepted" : "exited" },
      git: this.#git.snapshot,
      notice: action === "accept" ? "Review accepted; no commit or writer lease was created." : "Review exited without action.",
    });
    return true;
  }

  returnSelectedFindings(staleAcknowledged: boolean): string | null {
    const review = this.#snapshot.review;
    if (!review || this.#snapshot.mode !== "review" || review.status !== "completed") return null;
    if (review.stale && !staleAcknowledged) {
      this.#patch({ notice: "Review is stale; acknowledge the changed workspace before returning findings." });
      return null;
    }
    if (!review.findings.some((finding) => finding.selected)) {
      this.#patch({ notice: "Select at least one finding to return." });
      return null;
    }
    const relay = buildFindingsRelay(review.envelope, review.findings);
    this.#git.clearBaseline();
    this.#patch({
      mode: "compare",
      review: { ...review, status: "returned" },
      git: this.#git.snapshot,
      notice: `Selected findings prepared for ${review.writer}; writer promotion still requires confirmation.`,
    });
    return relay;
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
    if (this.#reviewPending) {
      this.#patch({ notice: "Wait for the review handoff check to finish before dispatching." });
      return false;
    }
    if (this.#snapshot.mode === "review") {
      this.#patch({ notice: "Use review actions while review mode is active; ordinary dispatch is paused." });
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
    if (this.#snapshot.mode === "build" && this.#snapshot.writer && selected.includes(this.#snapshot.writer)) {
      this.#lastWriterPrompt = cleanPrompt;
    }
    for (const provider of selected) {
      this.#patchLane(provider, { status: "STARTING", error: null, errorKind: null, toolSummary: null });
    }
    this.#patch({ notice: null });
    void Promise.allSettled(selected.map((provider) => this.#runLane(provider, envelope)));
    return true;
  }

  async #runLane(provider: ProviderId, envelope: PromptEnvelope, reviewMechanism?: ReviewMechanism): Promise<void> {
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
      const turnOptions: TurnOptions = {
        requestedModel,
        projectRoot: this.projectRoot,
        workspaceAccess,
        writerLease: workspaceAccess === "workspace_write" ? lease : null,
        requestApproval: (request) => this.#requestApproval(
          provider,
          this.#snapshot.lanes[provider].turnId ?? "starting",
          request,
        ),
      };
      if (reviewMechanism === "codex_native" && !adapter.startReview) {
        throw new Error("Selected native review mechanism is unavailable.");
      }
      const turn = reviewMechanism === "codex_native"
        ? await adapter.startReview!(session, envelope.prompt, turnOptions)
        : await adapter.startTurn(session, envelope.prompt, turnOptions);
      this.#patchLane(provider, { turnId: turn.id });
      if (this.#revokeAfterTurn === provider) await this.cancel(provider);
      for await (const providerEvent of turn.events) this.#applyEvent(provider, providerEvent);
    } catch (error) {
      this.#diagnose(provider, (error as Error).message);
      this.#patchLane(provider, {
        status: "FAILED",
        error: sanitizeTerminalText((error as Error).message),
        errorKind: classifyProviderError((error as Error).message),
        turnId: null,
      });
      this.#addActivity(provider, {
        id: randomUUID(),
        kind: "error",
        status: "failed",
        title: "Provider turn failed to start",
        detail: (error as Error).message,
        safetyEffect: null,
      });
      if (this.#snapshot.writer === provider || this.#revokeAfterTurn === provider) this.#completeRevocation(provider);
    }
  }

  #applyEvent(provider: ProviderId, providerEvent: NormalizedEvent): void {
    if (providerEvent.provider !== provider) {
      this.#diagnose(provider, "Cross-provider event rejected.");
      this.#patchLane(provider, { status: "FAILED", error: "Cross-provider event rejected.", errorKind: "protocol" });
      this.#addActivity(provider, {
        id: providerEvent.event_id,
        kind: "error",
        status: "failed",
        title: "Cross-provider event rejected",
        detail: null,
        safetyEffect: "provider isolation preserved",
        timestamp: providerEvent.timestamp,
      });
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
        this.#addActivity(provider, {
          id: providerEvent.event_id,
          kind: "tool",
          status: "running",
          title: String(providerEvent.payload.tool ?? "Tool"),
          detail: [providerEvent.payload.command, providerEvent.payload.path]
            .filter((value): value is string => typeof value === "string")
            .join(" · ") || null,
          safetyEffect: providerEvent.safety_effect ?? null,
          timestamp: providerEvent.timestamp,
        });
        break;
      case "tool.completed":
        this.#patchLane(provider, { toolSummary: `tool completed: ${String(providerEvent.payload.tool ?? "unknown")}` });
        this.#resolveActivity(provider, "tool", "completed");
        break;
      case "file.changed": {
        const path = typeof providerEvent.payload.path === "string" ? providerEvent.payload.path : null;
        this.#addActivity(provider, {
          id: providerEvent.event_id,
          kind: "file",
          status: "completed",
          title: path ? "File changed" : "File change reported",
          detail: path,
          safetyEffect: this.#snapshot.writer === provider ? "writer workspace" : "read-only anomaly",
          timestamp: providerEvent.timestamp,
        });
        if (this.#snapshot.writer === provider) this.#git.noteWriterChange(path);
        if (this.#gitRefreshTimer) clearTimeout(this.#gitRefreshTimer);
        this.#gitRefreshTimer = setTimeout(() => {
          this.#gitRefreshTimer = null;
          void this.refreshGit();
        }, 150);
        break;
      }
      case "approval.requested":
        this.#addActivity(provider, {
          id: providerEvent.event_id,
          kind: "approval",
          status: "blocked",
          title: String(providerEvent.payload.tool ?? "Approval requested"),
          detail: [providerEvent.payload.command, providerEvent.payload.path]
            .filter((value): value is string => typeof value === "string")
            .join(" · ") || null,
          safetyEffect: this.#snapshot.writer === provider ? "temporary writer approval" : "deny-only read-only request",
          timestamp: providerEvent.timestamp,
        });
        if (this.#snapshot.approvals.some((approval) => approval.provider === provider)) {
          this.#patchLane(provider, { status: "BLOCKED" });
        }
        break;
      case "approval.resolved":
        this.#resolveActivity(provider, "approval", "resolved", `decision: ${String(providerEvent.payload.decision ?? "unknown")}`);
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
          errorKind: classifyProviderError(providerEvent.payload.error ?? "Provider turn failed"),
        });
        this.#addActivity(provider, {
          id: providerEvent.event_id,
          kind: "error",
          status: "failed",
          title: "Provider turn failed",
          detail: String(providerEvent.payload.error ?? "Provider turn failed"),
          safetyEffect: null,
          timestamp: providerEvent.timestamp,
        });
        void this.refreshGit();
        if (this.#snapshot.writer === provider || this.#revokeAfterTurn === provider) this.#completeRevocation(provider);
        break;
      case "provider.warning":
        this.#diagnose(provider, providerEvent.payload.message ?? "Provider warning");
        this.#patchLane(provider, {
          error: sanitizeTerminalText(providerEvent.payload.message ?? "Provider warning"),
          errorKind: classifyProviderError(providerEvent.payload.message ?? "Provider warning"),
        });
        this.#addActivity(provider, {
          id: providerEvent.event_id,
          kind: "warning",
          status: "failed",
          title: "Provider warning",
          detail: String(providerEvent.payload.message ?? "Provider warning"),
          safetyEffect: null,
          timestamp: providerEvent.timestamp,
        });
        break;
    }
  }

  async cancel(provider: ProviderId): Promise<void> {
    const lane = this.#snapshot.lanes[provider];
    if (!lane.turnId || !["STARTING", "RUNNING", "BLOCKED"].includes(lane.status)) {
      this.#patch({ notice: `${provider} has no cancellable turn.` });
      return;
    }
    this.#resolveApprovalsFor(provider, "cancel_turn");
    this.#patchLane(provider, { status: "CANCELLING" });
    try {
      await this.adapters[provider].interrupt(lane.turnId);
    } catch (error) {
      this.#diagnose(provider, (error as Error).message);
      this.#patchLane(provider, {
        status: "FAILED",
        error: sanitizeTerminalText((error as Error).message),
        errorKind: classifyProviderError((error as Error).message),
      });
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
