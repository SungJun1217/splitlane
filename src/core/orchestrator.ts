import { createHash, randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
  AppSnapshot,
  CapabilitySnapshot,
  HandoffPacket,
  IsolatedRunSnapshot,
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
  QueueItem,
  RoleId,
  RoleProfile,
  ReviewMechanism,
  ReviewLensSnapshot,
  ReviewSnapshot,
  RestorableSession,
  SessionHandle,
  TurnOptions,
  WriterLease,
} from "../domain.ts";
import type { EffectiveConfig } from "../config/config.ts";
import { GitObserver } from "../git/observer.ts";
import { appendBounded, sanitizeTerminalText } from "../terminal/sanitize.ts";
import { isPathInsideWorkspace, WorkspaceGuard } from "../workspace/guard.ts";
import { captureReviewPatch, createReviewEnvelope, reviewMechanismStability } from "../review/envelope.ts";
import { buildFindingsRelay, buildReviewPrompt, parseReviewFindings } from "../review/findings.ts";
import { loadFindingPreview } from "../review/preview.ts";
import { classifyProviderError, ProviderSessionInvalidatedError } from "./provider-error.ts";
import { SessionStore, type SessionRecord } from "../session/store.ts";
import { WorktreeManager } from "../worktree/manager.ts";
import { SharedMetaSession, type MetaDispatch } from "../meta/session.ts";
import type { UpdateResult } from "../update/updater.ts";

// Visible M1 routing hypotheses only; this is not the approved v0.1 default profile.
const M1_PREVIEW_ROLES: RoleProfile = {
  scout: "claude",
  architect: "claude",
  builder: "codex",
  debugger: "codex",
  intent_reviewer: "claude",
  correctness_reviewer: "claude",
};

const blankLane = (provider: ProviderId, config?: EffectiveConfig): LaneSnapshot => ({
  provider,
  status: "READY",
  requestedModel: config?.providers[provider].model ?? "default",
  effectiveModel: null,
  modelSource: config?.providers[provider].source ?? "provider_default",
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

const commonCapabilities: readonly CapabilitySnapshot[] = [
  { id: "common.send", provider: "common", label: "Send to selected target", access: "Enter", stability: "stable", status: "available", reason: null },
  { id: "common.meta_context", provider: "common", label: "Share bounded peer context", access: "automatic", stability: "stable", status: "available", reason: null },
  { id: "common.cancel", provider: "common", label: "Cancel focused lane", access: "Ctrl+X", stability: "stable", status: "available", reason: null },
  { id: "common.writer", provider: "common", label: "Single-writer lease", access: "Ctrl+B / Ctrl+W", stability: "stable", status: "available", reason: null },
  { id: "common.approvals", provider: "common", label: "Approval inbox", access: "Ctrl+A", stability: "stable", status: "available", reason: null },
  { id: "common.review", provider: "common", label: "Read-only review handoff", access: "Ctrl+V", stability: "stable", status: "available", reason: null },
];

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
  #queueScheduling = false;
  readonly #allowPreview: boolean;
  readonly #sessionStore: SessionStore | null;
  readonly #worktreeManager: WorktreeManager | null;
  readonly #isolatedGuards = new Map<ProviderId, WorkspaceGuard>();
  readonly #isolatedLeases = new Map<ProviderId, WriterLease>();
  readonly #providerVersions = new Map<ProviderId, string | null>();
  readonly #sessionWrites = new Map<ProviderId, Promise<unknown>>();
  #worktreeWrite: Promise<unknown> = Promise.resolve();
  #metaSession = new SharedMetaSession();
  readonly #metaDispatches = new Map<ProviderId, MetaDispatch>();
  readonly #metaTextBuffers = new Map<ProviderId, string>();
  #twoLensPriorSessions: Map<ProviderId, SessionHandle> | null = null;
  /** Monotonic per-lane run token. Abandoning a lane that is stuck in startup
   * bumps it, which is how the abandoned run's own patches and events are
   * recognized as stale and dropped. */
  readonly #laneRun: Record<ProviderId, number> = { claude: 0, codex: 0 };
  #snapshot: AppSnapshot;

  constructor(
    readonly projectRoot: string,
    readonly adapters: Record<ProviderId, ProviderAdapter>,
    config?: EffectiveConfig,
  ) {
    this.#git = new GitObserver(projectRoot);
    this.#workspace = new WorkspaceGuard(projectRoot);
    this.#allowPreview = config?.capabilities.allowPreview ?? true;
    this.#sessionStore = config ? new SessionStore(config.stateDirectory, projectRoot) : null;
    this.#worktreeManager = config ? new WorktreeManager(config.stateDirectory, projectRoot) : null;
    this.#snapshot = {
      metaSession: this.#metaSession.snapshot,
      mode: "compare",
      writer: null,
      writerLease: null,
      writerRevoking: false,
      target: "codex",
      focusedProvider: "codex",
      inspectorVisible: config?.ui.inspector ?? true,
      lanes: { claude: blankLane("claude", config), codex: blankLane("codex", config) },
      git: this.#git.snapshot,
      roles: { ...(config?.roles ?? M1_PREVIEW_ROLES) },
      handoffPhase: "scout",
      handoff: null,
      isolated: null,
      approvals: [],
      review: null,
      queue: [],
      queueOffer: null,
      queueLimit: config?.queue.limit ?? 10,
      configuration: {
        userPath: config?.paths.user ?? "not loaded",
        projectPath: config?.paths.project ?? `${projectRoot}/.splitlane/config.json`,
        loadedUser: config?.loaded.user ?? false,
        loadedProject: config?.loaded.project ?? false,
        allowPreview: this.#allowPreview,
        showTools: config?.ui.showTools ?? "collapsed",
        restoreSessions: config?.ui.restoreSessions ?? "ask",
        updateMode: config?.updates.mode ?? "auto",
      },
      capabilities: commonCapabilities,
      evidencePreview: null,
      restorableSessions: [],
      diagnostics: [],
      notice: null,
    };
  }

  getSnapshot = (): AppSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  reportUpdate(result: UpdateResult): void {
    if (!["available", "updated", "failed"].includes(result.outcome)) return;
    this.#patch({
      notice: sanitizeTerminalText(result.message),
      diagnostics: result.outcome === "failed"
        ? [...this.#snapshot.diagnostics, `update: ${sanitizeTerminalText(result.message)}`].slice(-100)
        : this.#snapshot.diagnostics,
    });
  }

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
    this.#providerVersions.set("claude", claude.version);
    this.#providerVersions.set("codex", codex.version);
    const records = this.#sessionStore
      ? await Promise.all((["claude", "codex"] as const).map(async (provider) => {
          try { return await this.#sessionStore!.load(provider); }
          catch (error) { this.#diagnose(provider, `Session metadata ignored: ${(error as Error).message}`); return null; }
        }))
      : [];
    const restorableSessions = records.filter((record): record is SessionRecord => Boolean(record)).map((record): RestorableSession => ({
      provider: record.provider,
      sessionId: record.sessionId,
      requestedModel: record.requestedModel,
      effectiveModel: record.effectiveModel,
      providerVersion: record.providerVersion,
      updatedAt: record.updatedAt,
      interrupted: !record.clean,
      metaSessionId: record.metaSessionId,
      metaEpoch: record.metaEpoch,
    }));
    let recoverable: IsolatedRunSnapshot | null = null;
    let recoverableCount = 0;
    if (this.#worktreeManager) {
      try {
        const runs = await this.#worktreeManager.recoverable();
        for (const warning of this.#worktreeManager.recoveryWarnings) this.#diagnose("claude", `Isolated recovery entry ignored: ${warning}`);
        recoverable = runs[0] ?? null;
        recoverableCount = runs.length;
      }
      catch (error) { this.#diagnose("claude", `Isolated recovery scan failed: ${(error as Error).message}`); }
    }
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
      restorableSessions: this.#snapshot.configuration.restoreSessions === "never" ? [] : restorableSessions,
      capabilities: [
        ...commonCapabilities,
        { id: "claude.plan", provider: "claude", label: "Read-only planning", access: "compare", stability: "stable", status: claude.available ? "available" : "unavailable", reason: claude.error },
        { id: "claude.build", provider: "claude", label: "Sandboxed build", access: "build", stability: "stable", status: claude.available ? "available" : "unavailable", reason: claude.error },
        { id: "codex.app_server", provider: "codex", label: "App-server streaming", access: "runtime probe", stability: "preview", status: codex.available && this.#allowPreview ? "available" : codex.available ? "blocked" : "unavailable", reason: codex.available ? this.#allowPreview ? null : "Preview capabilities are disabled." : codex.error },
        { id: "codex.native_review", provider: "codex", label: "Native review", access: "runtime probe", stability: "preview", status: !codex.available ? "unavailable" : !this.#allowPreview ? "blocked" : this.adapters.codex.reviewMechanisms?.includes("codex_native") ? "available" : "unavailable", reason: !codex.available ? codex.error : !this.#allowPreview ? "Preview capabilities are disabled." : this.adapters.codex.reviewMechanisms?.includes("codex_native") ? null : "Local app-server schema does not advertise review/start." },
        { id: "codex.workspace_write", provider: "codex", label: "Network-off workspace write", access: "build", stability: "preview", status: codex.available && this.#allowPreview ? "available" : codex.available ? "blocked" : "unavailable", reason: codex.available ? this.#allowPreview ? null : "Preview capabilities are disabled." : codex.error },
      ],
      isolated: recoverable,
      notice: recoverable ? `${recoverableCount} retained isolated run${recoverableCount === 1 ? "" : "s"} found; inspect, keep, or clean ${recoverable.runId} explicitly.` : this.#snapshot.notice,
    });
    if (this.#snapshot.configuration.restoreSessions === "always" && restorableSessions.length) await this.restoreSessions();
  }

  async restoreSessions(): Promise<void> {
    const records = [...this.#snapshot.restorableSessions];
    const metaIds = [...new Set(records.map((record) => record.metaSessionId).filter((value): value is string => Boolean(value)))];
    const restoredMeta = metaIds.length === 1
      ? new SharedMetaSession(metaIds[0]!, Math.max(0, ...records.map((record) => record.metaEpoch ?? 0)) + 1, true)
      : new SharedMetaSession(undefined, 1, records.length > 0);
    this.#metaSession = restoredMeta;
    for (const record of records) {
      const lane = this.#snapshot.lanes[record.provider];
      const currentVersion = this.#providerVersions.get(record.provider) ?? null;
      if (lane.status === "UNAVAILABLE") continue;
      if (record.providerVersion && currentVersion && record.providerVersion !== currentVersion) {
        this.#diagnose(record.provider, `Session restore refused: provider version changed from ${record.providerVersion} to ${currentVersion}.`);
        this.#patchLane(record.provider, { error: "Stored session provider version is incompatible.", errorKind: "configuration" });
        continue;
      }
      if (record.requestedModel !== lane.requestedModel) {
        this.#patchLane(record.provider, { error: `Stored session model ${record.requestedModel} does not match selected model ${lane.requestedModel}.`, errorKind: "invalid_model" });
        continue;
      }
      try {
        const session = await this.adapters[record.provider].resumeSession(record.sessionId, { projectRoot: this.projectRoot, requestedModel: record.requestedModel });
        if (!session.effectiveModel || (session.effectiveModel === record.requestedModel && record.effectiveModel !== record.requestedModel)) {
          session.effectiveModel = record.effectiveModel;
        }
        this.#sessions.set(record.provider, session);
        this.#patchLane(record.provider, { sessionId: session.id, effectiveModel: session.effectiveModel, error: null, errorKind: null });
      } catch (error) {
        this.#diagnose(record.provider, `Session restore failed: ${(error as Error).message}`);
        this.#patchLane(record.provider, { error: sanitizeTerminalText((error as Error).message), errorKind: classifyProviderError(error) });
      }
    }
    this.#patch({
      metaSession: this.#metaSession.snapshot,
      restorableSessions: [],
      notice: metaIds.length > 1
        ? "Provider metadata belonged to different meta sessions; child sessions restored under a new visible synchronization epoch. No transcript was replayed."
        : "Child sessions restored under one shared meta-session epoch; previously delivered native context remains, but no unavailable transcript was replayed.",
    });
  }

  async startNewSessions(): Promise<void> {
    await Promise.allSettled((["claude", "codex"] as const).map((provider) => this.#removeSessionMetadata(provider)));
    this.#metaSession = new SharedMetaSession();
    this.#sessions.clear();
    this.#patch({ metaSession: this.#metaSession.snapshot, restorableSessions: [], notice: "Stored Splitlane session metadata removed; a new shared meta session started and provider-owned history was not modified." });
  }

  async resetSession(provider: ProviderId): Promise<boolean> {
    if (!canAccept(this.#snapshot.lanes[provider])) {
      this.#patch({ notice: `${provider} session cannot reset while its lane is active.` });
      return false;
    }
    this.#sessions.delete(provider);
    this.#metaSession.resyncProvider(provider);
    await this.#removeSessionMetadata(provider);
    this.#patchLane(provider, { sessionId: null, effectiveModel: null, output: "", activities: [], error: null, errorKind: null });
    this.#patch({ metaSession: this.#metaSession.snapshot, notice: `${provider} Splitlane session metadata reset; retained shared context will resync on its next turn and the other lane is unchanged.` });
    return true;
  }

  #persistSession(provider: ProviderId, clean: boolean): void {
    if (this.#snapshot.mode === "isolated") return;
    if (this.#snapshot.mode === "review" && this.#snapshot.review?.twoLens) return;
    const session = this.#sessions.get(provider);
    if (!this.#sessionStore || !session?.id || !session.effectiveModel) return;
    const confirmedSession = { ...session, effectiveModel: session.effectiveModel };
    const prior = this.#sessionWrites.get(provider) ?? Promise.resolve();
    const write = prior.then(() => this.#sessionStore!.save(
      provider,
      confirmedSession,
      this.#providerVersions.get(provider) ?? null,
      clean,
      { id: this.#metaSession.id, epoch: this.#metaSession.epoch },
    ))
      .catch((error) => this.#diagnose(provider, `Session metadata write failed: ${(error as Error).message}`));
    this.#sessionWrites.set(provider, write);
    void write.finally(() => { if (this.#sessionWrites.get(provider) === write) this.#sessionWrites.delete(provider); });
  }

  async #removeSessionMetadata(provider: ProviderId): Promise<void> {
    await this.#sessionWrites.get(provider);
    await this.#sessionStore?.remove(provider);
  }

  setTarget(target: PromptTarget): void {
    this.#patch({ target, notice: null });
  }

  cycleTarget(): void {
    const targets: PromptTarget[] = ["codex", "claude", "both"];
    const index = targets.indexOf(this.#snapshot.target);
    this.setTarget(targets[(index + 1) % targets.length] ?? "codex");
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

  /** A notice describes one past decision, not current state. Clearing it keeps
   * a stale refusal from reading as the lane's present condition. */
  clearNotice(): void {
    if (this.#snapshot.notice !== null) this.#patch({ notice: null });
  }

  setModel(provider: ProviderId, model: string): void {
    const requestedModel = model.trim() || "default";
    if (requestedModel.length > 256 || /[\r\n\0]/.test(requestedModel)) {
      this.#patch({ notice: `${provider} model ID must be one line and at most 256 characters.` });
      return;
    }
    if (["STARTING", "RUNNING", "BLOCKED", "CANCELLING"].includes(this.#snapshot.lanes[provider].status)) {
      this.#patch({ notice: `${provider} model cannot change while its lane is active; cancel or wait for completion first.` });
      return;
    }
    this.#sessions.delete(provider);
    this.#metaSession.resyncProvider(provider);
    void this.#removeSessionMetadata(provider);
    this.#patchLane(provider, {
      requestedModel,
      effectiveModel: null,
      modelSource: "request",
      sessionId: null,
    });
    this.#patch({ metaSession: this.#metaSession.snapshot, notice: `${provider} model set for next request; provider session reset and retained shared context marked for resync.` });
  }

  #selectedProviders(target: PromptTarget): readonly ProviderId[] {
    return target === "both" ? ["claude", "codex"] : [target];
  }

  #freezeQueueItem(prompt: string, target: PromptTarget = this.#snapshot.target): QueueItem {
    const createdAt = new Date().toISOString();
    return Object.freeze({
      id: randomUUID(),
      target,
      providers: Object.freeze([...this.#selectedProviders(target)]),
      envelope: Object.freeze({ envelopeId: randomUUID(), createdAt, prompt }),
      models: Object.freeze({
        claude: this.#snapshot.lanes.claude.requestedModel,
        codex: this.#snapshot.lanes.codex.requestedModel,
      }),
      mode: this.#snapshot.mode as Exclude<AppSnapshot["mode"], "review">,
      writer: this.#snapshot.writer,
      writerLeaseId: this.#snapshot.writerLease?.id ?? null,
      status: "queued" as const,
      createdAt,
    });
  }

  #queueDepth(provider: ProviderId): number {
    return this.#snapshot.queue.filter((item) => item.providers.includes(provider)).length;
  }

  confirmQueueOffer(): boolean {
    const offer = this.#snapshot.queueOffer;
    if (!offer) return false;
    const full = offer.providers.find((provider) => this.#queueDepth(provider) >= this.#snapshot.queueLimit);
    if (full) {
      this.#patch({ notice: `${full} queue is full (${this.#snapshot.queueLimit}). Remove an item first.` });
      return false;
    }
    this.#patch({
      queue: [...this.#snapshot.queue, offer],
      queueOffer: null,
      notice: `${offer.target} request queued · ${offer.id.slice(0, 8)} · authority frozen.`,
    });
    void this.#scheduleQueue();
    return true;
  }

  cancelQueueOffer(): void {
    if (!this.#snapshot.queueOffer) return;
    this.#patch({ queueOffer: null, notice: "Pending queue request discarded; nothing was sent." });
  }

  removeQueued(id: string): boolean {
    const item = this.#snapshot.queue.find((candidate) => candidate.id === id);
    if (!item) return false;
    this.#patch({ queue: this.#snapshot.queue.filter((candidate) => candidate.id !== id), notice: `Queued request ${id.slice(0, 8)} removed.` });
    void this.#scheduleQueue();
    return true;
  }

  confirmQueued(id: string): boolean {
    const existing = this.#snapshot.queue.find((item) => item.id === id && item.status === "needs_confirmation");
    if (!existing) return false;
    if (this.#snapshot.mode === "review") {
      this.#patch({ notice: "Queued prompts cannot be confirmed while review mode is active." });
      return false;
    }
    const confirmed: QueueItem = Object.freeze({
      ...existing,
      mode: this.#snapshot.mode,
      writer: this.#snapshot.writer,
      writerLeaseId: this.#snapshot.writerLease?.id ?? null,
      status: "queued",
    });
    this.#patch({
      queue: this.#snapshot.queue.map((item) => item.id === id ? confirmed : item),
      notice: `Queued request ${id.slice(0, 8)} confirmed for the current safety mode.`,
    });
    void this.#scheduleQueue();
    return true;
  }

  setRole(role: RoleId, provider: ProviderId): void {
    this.#patch({
      roles: { ...this.#snapshot.roles, [role]: provider },
      notice: `${role} role set to ${provider}; prompt routing did not change.`,
    });
  }

  async prepareRoleHandoff(objective: string): Promise<boolean> {
    const cleanObjective = sanitizeTerminalText(objective).trim();
    const from = this.#snapshot.handoffPhase;
    if (from === "builder") {
      this.#patch({ notice: "Builder is the final v0.1 handoff phase; reset the workflow explicitly to begin another chain." });
      return false;
    }
    const sourceProvider = this.#snapshot.focusedProvider;
    const lane = this.#snapshot.lanes[sourceProvider];
    if (!canAccept(lane) || !lane.output.trim()) {
      this.#patch({ notice: "Role handoff requires completed output in the focused source lane." });
      return false;
    }
    if (!cleanObjective) {
      this.#patch({ notice: "Role handoff requires an explicit objective in the shared prompt editor." });
      return false;
    }
    const git = await this.#git.refresh();
    this.#patch({ git });
    const to = from === "scout" ? "architect" : "builder";
    const questionLines = lane.output.split("\n").map((line) => sanitizeTerminalText(line).trim()).filter((line) => line.includes("?")).slice(0, 5);
    const packet: HandoffPacket = Object.freeze({
      schemaVersion: "handoff-packet/v1",
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      from,
      to,
      recommendedProvider: this.#snapshot.roles[to],
      objective: cleanObjective.slice(0, 2_048),
      constraints: Object.freeze([
        "Do not infer hidden transcript context; use only this packet and repository evidence.",
        "Preserve Splitlane workspace and permission invariants.",
        to === "builder" ? "Writing still requires an explicit build-mode writer lease." : "Remain read-only unless the user separately promotes a writer.",
      ]),
      relevantFiles: Object.freeze(git.files.slice(0, 50)),
      openQuestions: Object.freeze(questionLines.length ? questionLines : ["Which assumptions require user confirmation before the next phase?"]),
      acceptanceCriteria: Object.freeze([
        `Produce a bounded ${to} artifact that directly addresses the stated objective.`,
        "Identify unresolved risks and cite relevant files where possible.",
      ]),
      sourceProvider,
      sourceSessionId: lane.sessionId,
      baselineFingerprint: git.baselineFingerprint ?? createHash("sha256").update(JSON.stringify({ branch: git.branch, files: git.files, diff: git.diff })).digest("hex"),
      sourceExcerpt: sanitizeTerminalText(lane.output).slice(-8_192),
    });
    this.#patch({ handoff: packet, notice: `${from} → ${to} packet ready for inspection; no prompt was sent and target did not change.` });
    return true;
  }

  confirmRoleHandoff(): string | null {
    const packet = this.#snapshot.handoff;
    if (!packet) return null;
    const prompt = [
      `SPLITLANE HANDOFF ${packet.from.toUpperCase()} → ${packet.to.toUpperCase()}`,
      `Objective:\n${packet.objective}`,
      `Constraints:\n${packet.constraints.map((item) => `- ${item}`).join("\n")}`,
      `Relevant files:\n${packet.relevantFiles.length ? packet.relevantFiles.map((item) => `- ${item}`).join("\n") : "- none recorded"}`,
      `Open questions:\n${packet.openQuestions.map((item) => `- ${item}`).join("\n")}`,
      `Acceptance criteria:\n${packet.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
      `Source: ${packet.sourceProvider} session ${packet.sourceSessionId?.slice(0, 12) ?? "new"} · baseline ${packet.baselineFingerprint?.slice(0, 12) ?? "none"}`,
      `Source artifact:\n${packet.sourceExcerpt}`,
    ].join("\n\n");
    this.#patch({
      handoffPhase: packet.to,
      handoff: null,
      notice: `${packet.to} handoff prompt prepared for recommended ${packet.recommendedProvider}; routing remains user-controlled.`,
    });
    return prompt;
  }

  cancelRoleHandoff(): void {
    if (this.#snapshot.handoff) this.#patch({ handoff: null, notice: "Role handoff packet discarded; nothing was sent." });
  }

  resetRoleHandoffChain(): void {
    this.#patch({ handoffPhase: "scout", handoff: null, notice: "Role handoff chain reset to scout; no routing or provider state changed." });
  }

  async prepareIsolated(): Promise<boolean> {
    if (!this.#worktreeManager) {
      this.#patch({ notice: "Isolated mode requires the configured user state directory." });
      return false;
    }
    if (this.#snapshot.mode !== "compare" || this.#snapshot.queue.length || this.#snapshot.queueOffer || this.#snapshot.approvals.length) {
      this.#patch({ notice: "Isolated mode requires compare mode with empty queues and no pending approvals." });
      return false;
    }
    if ((["claude", "codex"] as const).some((provider) => !canAccept(this.#snapshot.lanes[provider]))) {
      this.#patch({ notice: "Isolated mode requires both provider lanes to be idle and available." });
      return false;
    }
    if (this.#snapshot.isolated && this.#snapshot.isolated.lifecycle !== "cleaned") {
      this.#patch({ notice: `Resolve retained isolated run ${this.#snapshot.isolated.runId} before creating another.` });
      return false;
    }
    try {
      const retained = await this.#worktreeManager.recoverable();
      if (retained.length) {
        this.#patch({ isolated: retained[0]!, notice: `Resolve retained isolated run ${retained[0]!.runId} before creating another.` });
        return false;
      }
      const plan = await this.#worktreeManager.plan();
      this.#patch({ isolated: plan, notice: "Isolated worktree plan ready; no directories or branches have been created yet." });
      return true;
    } catch (error) {
      this.#patch({ notice: `Isolated mode refused: ${sanitizeTerminalText((error as Error).message)}` });
      return false;
    }
  }

  async startIsolated(): Promise<boolean> {
    const plan = this.#snapshot.isolated;
    if (!this.#worktreeManager || !plan || plan.lifecycle !== "preview" || this.#snapshot.mode !== "compare") return false;
    // A preview survives closing the overlay, so it can be confirmed long after
    // prepareIsolated checked these. Activation resets both lanes, which would
    // otherwise discard a running turn's output and let a second turn start in
    // the same lane.
    if (this.#snapshot.queue.length || this.#snapshot.queueOffer || this.#snapshot.approvals.length) {
      this.#patch({ notice: "Isolated mode requires empty queues and no pending approvals; the preview was kept." });
      return false;
    }
    if ((["claude", "codex"] as const).some((provider) => !canAccept(this.#snapshot.lanes[provider]))) {
      this.#patch({ notice: "Isolated mode requires both provider lanes to be idle; the preview was kept." });
      return false;
    }
    try {
      const active = await this.#worktreeManager.create(plan);
      if (this.#snapshot.mode !== "compare" || (["claude", "codex"] as const).some((provider) => !canAccept(this.#snapshot.lanes[provider]))) {
        let retained = active;
        try { retained = await this.#worktreeManager.retain(active); } catch {}
        this.#patch({ isolated: retained, notice: "Lane state changed while the worktrees were being created, so the run was retained instead of activated. Ctrl+L resolves it." });
        return false;
      }
      // Isolated mode redefines what each lane's tree even is, so a primary-tree
      // baseline can no longer describe anything.
      this.#git.clearBaseline();
      for (const provider of ["claude", "codex"] as const) {
        const guard = new WorkspaceGuard(active.lanes[provider].path);
        const lease = guard.grant(provider, active.baseCommit);
        this.#isolatedGuards.set(provider, guard);
        this.#isolatedLeases.set(provider, lease);
        this.#sessions.delete(provider);
        this.#metaSession.resyncProvider(provider);
        void this.#removeSessionMetadata(provider);
        this.#patchLane(provider, { sessionId: null, output: "", activities: [], error: null, errorKind: null, status: "READY" });
      }
      this.#patch({
        metaSession: this.#metaSession.snapshot,
        mode: "isolated",
        writer: null,
        writerLease: null,
        review: null,
        isolated: active,
        git: this.#git.snapshot,
        notice: "Isolated mode active: each provider writes only in its own worktree; primary tree remains read-only.",
      });
      return true;
    } catch (error) {
      let failed = plan;
      try { failed = await this.#worktreeManager.inspect({ ...plan, lifecycle: "failed", error: sanitizeTerminalText((error as Error).message) }); } catch {}
      this.#patch({ isolated: failed, notice: `Isolated creation failed and any created worktree was retained: ${sanitizeTerminalText((error as Error).message)}` });
      return false;
    }
  }

  cancelIsolatedPlan(): void {
    if (this.#snapshot.isolated?.lifecycle !== "preview") return;
    this.#patch({ isolated: null, notice: "Isolated preview discarded; no branch or worktree was created." });
  }

  async refreshIsolated(): Promise<void> {
    if (!this.#worktreeManager || !this.#snapshot.isolated || this.#snapshot.isolated.lifecycle === "preview") return;
    const task = this.#worktreeWrite.then(async () => {
      const current = this.#snapshot.isolated;
      if (!current || current.lifecycle === "preview" || current.lifecycle === "cleaned") return;
      this.#patch({ isolated: await this.#worktreeManager!.inspect(current) });
    });
    this.#worktreeWrite = task.catch((error) => {
      this.#patch({ notice: `Isolated inspection failed: ${sanitizeTerminalText((error as Error).message)}` });
    });
    await this.#worktreeWrite;
  }

  async retainIsolated(): Promise<boolean> {
    const run = this.#snapshot.isolated;
    if (!this.#worktreeManager || !run || run.lifecycle === "preview" || run.lifecycle === "cleaned") return false;
    if (this.#snapshot.queue.length || this.#snapshot.queueOffer) {
      this.#patch({ notice: "Remove queued isolated requests before retaining the run; frozen authority will not be changed silently." });
      return false;
    }
    if ((["claude", "codex"] as const).some((provider) => !canAccept(this.#snapshot.lanes[provider]))) {
      this.#patch({ notice: "Isolated retain requires both provider processes to be idle." });
      return false;
    }
    try {
      await this.#worktreeWrite;
      const retained = await this.#worktreeManager.retain(this.#snapshot.isolated ?? run);
      this.#leaveIsolatedSessions();
      this.#patch({ mode: "compare", isolated: retained, notice: `Isolated run ${run.runId} retained. Primary tree and branches were not modified.` });
      return true;
    } catch (error) {
      this.#patch({ notice: `Unable to retain isolated run metadata: ${sanitizeTerminalText((error as Error).message)}` });
      return false;
    }
  }

  async cleanupIsolated(): Promise<boolean> {
    const run = this.#snapshot.isolated;
    if (!this.#worktreeManager || !run || run.lifecycle === "preview" || run.lifecycle === "cleaned") return false;
    if (this.#snapshot.queue.length || this.#snapshot.queueOffer) {
      this.#patch({ notice: "Remove queued isolated requests before cleanup; frozen authority will not be changed silently." });
      return false;
    }
    if ((["claude", "codex"] as const).some((provider) => !canAccept(this.#snapshot.lanes[provider]))) {
      this.#patch({ notice: "Isolated cleanup requires both provider processes to be idle." });
      return false;
    }
    try {
      await this.#worktreeWrite;
      const cleaned = await this.#worktreeManager.cleanup(this.#snapshot.isolated ?? run);
      this.#leaveIsolatedSessions();
      const remaining = await this.#worktreeManager.recoverable();
      this.#patch({
        mode: "compare",
        isolated: remaining[0] ?? cleaned,
        notice: remaining.length
          ? `Clean isolated worktrees removed; ${remaining.length} retained run${remaining.length === 1 ? "" : "s"} remain for explicit recovery.`
          : "Clean isolated worktrees removed. Branches were retained; no merge or branch deletion ran.",
      });
      return true;
    } catch (error) {
      let retained = run;
      try { retained = await this.#worktreeManager.retain(run); } catch {}
      this.#leaveIsolatedSessions();
      this.#patch({ mode: "compare", isolated: retained, notice: `Isolated worktrees retained for recovery: ${sanitizeTerminalText((error as Error).message)}` });
      return false;
    }
  }

  /** Cleanup refuses any run it cannot prove is safe to remove, which for a run
   * whose worktrees are dirty or were never created means it can never succeed —
   * and a tracked run blocks every new isolated run. Discarding drops only
   * Splitlane's tracking and reports exactly what is left on disk. */
  async discardIsolated(): Promise<boolean> {
    const run = this.#snapshot.isolated;
    if (!this.#worktreeManager || !run || run.lifecycle === "preview" || run.lifecycle === "cleaned") return false;
    if (this.#snapshot.queue.length || this.#snapshot.queueOffer) {
      this.#patch({ notice: "Remove queued isolated requests before discarding the run; frozen authority will not be changed silently." });
      return false;
    }
    if ((["claude", "codex"] as const).some((provider) => !canAccept(this.#snapshot.lanes[provider]))) {
      this.#patch({ notice: "Discarding an isolated run requires both provider processes to be idle." });
      return false;
    }
    try {
      await this.#worktreeWrite;
      const { remainingPaths, remainingBranches } = await this.#worktreeManager.discard(this.#snapshot.isolated ?? run);
      this.#leaveIsolatedSessions();
      this.#revokeIsolatedLeases();
      const remaining = await this.#worktreeManager.recoverable();
      const left = [
        remainingPaths.length ? `${remainingPaths.length} worktree director${remainingPaths.length === 1 ? "y" : "ies"}` : "",
        remainingBranches.length ? `${remainingBranches.length} branch${remainingBranches.length === 1 ? "" : "es"}` : "",
      ].filter(Boolean).join(" and ");
      this.#patch({
        mode: "compare",
        isolated: remaining[0] ?? null,
        notice: left
          ? `Stopped tracking isolated run ${run.runId}. Nothing was deleted: ${left} remain on disk (${[...remainingPaths, ...remainingBranches].join(" · ")}).`
          : `Stopped tracking isolated run ${run.runId}; no worktree directory or branch was left behind.`,
      });
      return true;
    } catch (error) {
      this.#patch({ notice: `Unable to stop tracking the isolated run: ${sanitizeTerminalText((error as Error).message)}` });
      return false;
    }
  }

  isolatedIntegrationCommands(): Record<ProviderId, readonly string[]> | null {
    return this.#worktreeManager && this.#snapshot.isolated ? this.#worktreeManager.integrationCommands(this.#snapshot.isolated) : null;
  }

  #revokeIsolatedLeases(): void {
    for (const provider of ["claude", "codex"] as const) {
      const guard = this.#isolatedGuards.get(provider);
      const lease = this.#isolatedLeases.get(provider);
      if (guard && lease) guard.revoke(lease.id);
    }
    this.#isolatedGuards.clear();
    this.#isolatedLeases.clear();
  }

  #leaveIsolatedSessions(): void {
    this.#revokeIsolatedLeases();
    this.#sessions.clear();
    for (const provider of ["claude", "codex"] as const) this.#patchLane(provider, { sessionId: null, turnId: null });
  }

  #markIsolatedProcess(provider: ProviderId, processState: "idle" | "running"): void {
    const run = this.#snapshot.isolated;
    if (!this.#worktreeManager || this.#snapshot.mode !== "isolated" || !run || run.lifecycle !== "active") return;
    const next: IsolatedRunSnapshot = {
      ...run,
      lanes: { ...run.lanes, [provider]: { ...run.lanes[provider], processState } },
    };
    this.#patch({ isolated: next });
    this.#worktreeWrite = this.#worktreeWrite
      .then(() => this.#worktreeManager!.writeManifest(next))
      .catch((error) => this.#diagnose(provider, `Isolated process-state write failed: ${(error as Error).message}`));
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
    if (this.#snapshot.lanes[provider].status === "UNAVAILABLE") {
      this.#patch({ notice: `${provider} is unavailable; install and authenticate its CLI before granting a writer lease.` });
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
      // The baseline belongs to the build cycle, not to the lease. Capturing a
      // fresh one on every promotion would re-classify the edits an earlier
      // writer turn already made as pre-existing, silently dropping them from
      // the review diff after a cancelled or failed turn.
      const retainedBaseline = this.#git.snapshot.baselineFingerprint;
      const baselineFingerprint = retainedBaseline ?? await this.#git.captureBaseline();
      const lease = this.#workspace.grant(provider, baselineFingerprint);
      this.#patch({
        mode: "build",
        writer: provider,
        writerLease: lease,
        writerRevoking: false,
        git: this.#git.snapshot,
        notice: retainedBaseline
          ? `${provider} is the only writer, continuing from the retained baseline so earlier edits stay in the review diff. Network access remains off.`
          : `${provider} is the only writer. Network access remains off; prompt target did not change.`,
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

  async startGuidedBuild(prompt: string, dirtyTreeAcknowledged: boolean): Promise<boolean> {
    if (!prompt.trim()) {
      this.#patch({ notice: "Task is empty." });
      return false;
    }
    const promoted = await this.promoteWriter("codex", dirtyTreeAcknowledged);
    if (!promoted) return false;
    this.setTarget("codex");
    this.focus("codex");
    const sent = await this.dispatch(prompt);
    if (!sent) await this.revokeWriter();
    return sent;
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
    // The lease is always surrendered here, but the baseline is not: only
    // finishing or abandoning the review cycle ends it. See promoteWriter.
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
        mechanism === generic || (this.#allowPreview && reviewer === "codex" && mechanism === "codex_native")
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
          twoLens: false,
          activeLens: reviewer,
          lenses: {},
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
      const lens: ReviewLensSnapshot = { provider: review.reviewer, mechanism: review.mechanism, status: "running", envelope, findings: [], parseError: null };
      const running: ReviewSnapshot = { ...review, status: "running", envelope, findings: [], activeFindingId: null, preview: null, stale: false, parseError: null, twoLens: false, activeLens: review.reviewer, lenses: { [review.reviewer]: lens } };
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

  async startTwoLensReview(acceptanceCriteria: string): Promise<boolean> {
    const review = this.#snapshot.review;
    const lease = this.#snapshot.writerLease;
    const criteria = sanitizeTerminalText(acceptanceCriteria).trim();
    if (this.#reviewPending || !review || review.status !== "draft" || this.#snapshot.mode !== "build" || !lease || !criteria) {
      this.#patch({ notice: criteria ? "Two-lens review draft is no longer valid." : "Acceptance criteria are required." });
      return false;
    }
    if (!this.#workspace.validate(lease, review.writer) || this.#snapshot.writer !== review.writer) {
      this.#patch({ notice: "Two-lens review lost its matching writer lease." });
      return false;
    }
    if ((["claude", "codex"] as const).some((provider) => !canAccept(this.#snapshot.lanes[provider]))) {
      this.#patch({ notice: "Two-lens review requires both providers to be idle and available; nothing started." });
      return false;
    }
    this.#reviewPending = true;
    try {
      const git = await this.#git.refresh();
      const current = await captureReviewPatch(git.root, git.evidence, { baseRevision: review.envelope.head });
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
        this.#patch({ git, review: { ...review, envelope }, notice: "Diff changed while confirming two-lens review; inspect and confirm the refreshed hash." });
        return false;
      }
      if (!this.#workspace.revoke(lease.id)) throw new Error("Writer lease revocation failed before two-lens review.");
      const mechanisms = (provider: ProviderId): ReviewMechanism => {
        const generic = `${provider}_generic` as ReviewMechanism;
        return provider === "codex" && this.#allowPreview && this.adapters.codex.reviewMechanisms?.includes("codex_native")
          ? "codex_native"
          : generic;
      };
      const lenses = Object.fromEntries((["claude", "codex"] as const).map((provider) => {
        const mechanism = mechanisms(provider);
        const envelope = Object.freeze({
          ...review.envelope,
          reviewer: provider,
          mechanism,
          mechanismStability: reviewMechanismStability(mechanism),
          acceptanceCriteria: criteria,
        });
        const lens: ReviewLensSnapshot = { provider, mechanism, status: "running", envelope, findings: [], parseError: null };
        return [provider, lens];
      })) as Record<ProviderId, ReviewLensSnapshot>;
      this.#twoLensPriorSessions = new Map(this.#sessions);
      this.#sessions.delete("claude");
      this.#sessions.delete("codex");
      for (const provider of ["claude", "codex"] as const) {
        this.#patchLane(provider, { output: "", error: null, errorKind: null, toolSummary: "two-lens read-only review", sessionId: null, effectiveModel: null });
      }
      const running: ReviewSnapshot = {
        ...review,
        status: "running",
        envelope: lenses.claude.envelope,
        reviewer: "claude",
        mechanism: lenses.claude.mechanism,
        findings: [],
        activeFindingId: null,
        preview: null,
        stale: false,
        parseError: null,
        twoLens: true,
        activeLens: "claude",
        lenses,
      };
      this.#patch({
        mode: "review",
        writer: null,
        writerLease: null,
        writerRevoking: false,
        review: running,
        focusedProvider: "claude",
        notice: "Writer paused; Claude and Codex two-lens review started independently and read-only.",
      });
      void Promise.allSettled((["claude", "codex"] as const).map((provider) => this.#runTwoLens(provider, review.envelope.id)));
      return true;
    } catch (error) {
      this.#restoreTwoLensSessions();
      this.#patch({ notice: `Two-lens review start failed: ${sanitizeTerminalText((error as Error).message)}` });
      return false;
    } finally {
      this.#reviewPending = false;
    }
  }

  async #runTwoLens(provider: ProviderId, reviewId: string): Promise<void> {
    const lens = this.#snapshot.review?.lenses[provider];
    if (!lens) return;
    const envelope: PromptEnvelope = Object.freeze({ envelopeId: reviewId, createdAt: lens.envelope.createdAt, prompt: buildReviewPrompt(lens.envelope) });
    await this.#runLane(provider, envelope, lens.mechanism);
    const currentReview = this.#snapshot.review;
    if (this.#snapshot.mode !== "review" || !currentReview?.twoLens || currentReview.envelope.id !== reviewId) return;
    const lane = this.#snapshot.lanes[provider];
    const parsed = lane.status === "COMPLETED"
      ? parseReviewFindings(lane.output, provider, lens.mechanism, this.projectRoot)
      : { findings: [], error: lane.error ?? `Review lens ended with ${lane.status}.` };
    const status: ReviewLensSnapshot["status"] = lane.status === "COMPLETED" ? "completed" : lane.status === "CANCELLED" ? "cancelled" : "failed";
    const updatedLens: ReviewLensSnapshot = { ...lens, status, findings: parsed.findings, parseError: parsed.error };
    const lenses = { ...currentReview.lenses, [provider]: updatedLens };
    const active = currentReview.activeLens === provider ? updatedLens : lenses[currentReview.activeLens];
    this.#patch({
      review: {
        ...currentReview,
        lenses,
        findings: active?.findings ?? [],
        activeFindingId: active?.findings[0]?.id ?? null,
        parseError: active?.parseError ?? null,
      },
    });
    const all = (["claude", "codex"] as const).map((id) => this.#snapshot.review?.lenses[id]).filter(Boolean) as ReviewLensSnapshot[];
    if (all.length !== 2 || all.some((item) => item.status === "running")) return;
    let stale = true;
    try {
      const git = await this.#git.refresh();
      const patch = await captureReviewPatch(git.root, git.evidence, { baseRevision: lens.envelope.head });
      stale = patch.diffHash !== lens.envelope.diffHash;
      this.#patch({ git });
    } catch {}
    const review = this.#snapshot.review;
    if (!review?.twoLens || review.envelope.id !== reviewId) return;
    const completed = all.filter((item) => item.status === "completed").length;
    this.#restoreTwoLensSessions();
    this.#patch({
      review: { ...review, status: completed ? "completed" : "failed", stale },
      notice: `Two-lens review finished · Claude ${review.lenses.claude?.status} · Codex ${review.lenses.codex?.status}${stale ? " · STALE" : ""}.`,
    });
  }

  #restoreTwoLensSessions(): void {
    const prior = this.#twoLensPriorSessions;
    if (!prior) return;
    this.#twoLensPriorSessions = null;
    for (const provider of ["claude", "codex"] as const) {
      const session = prior.get(provider);
      if (session) this.#sessions.set(provider, session);
      else this.#sessions.delete(provider);
      this.#patchLane(provider, {
        sessionId: session?.id || null,
        effectiveModel: session?.effectiveModel ?? null,
      });
    }
  }

  selectReviewLens(provider: ProviderId): boolean {
    const review = this.#snapshot.review;
    const lens = review?.lenses[provider];
    if (!review?.twoLens || !lens) return false;
    this.#patch({
      focusedProvider: provider,
      review: {
        ...review,
        activeLens: provider,
        reviewer: provider,
        mechanism: lens.mechanism,
        envelope: lens.envelope,
        findings: lens.findings,
        activeFindingId: lens.findings[0]?.id ?? null,
        preview: null,
        parseError: lens.parseError,
      },
      notice: `${provider} review lens selected; findings remain provider-separated.`,
    });
    return true;
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
      review: { ...review, status, findings: parsed.findings, activeFindingId: parsed.findings[0]?.id ?? null, preview: null, stale, parseError: parsed.error, lenses: { [review.reviewer]: { provider: review.reviewer, mechanism: review.mechanism, status: status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed", envelope: review.envelope, findings: parsed.findings, parseError: parsed.error } } },
      notice: parsed.error
        ? `Review finished without structured findings: ${parsed.error}`
        : `Review completed with ${parsed.findings.length} finding(s)${stale ? " · STALE" : ""}.`,
    });
  }

  toggleFinding(id: string): void {
    const review = this.#snapshot.review;
    if (!review) return;
    const findings = review.findings.map((finding) => finding.id === id ? { ...finding, selected: !finding.selected } : finding);
    const activeLens = review.lenses[review.activeLens];
    this.#patch({
      review: {
        ...review,
        findings,
        lenses: review.twoLens && activeLens
          ? { ...review.lenses, [review.activeLens]: { ...activeLens, findings } }
          : review.lenses,
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
    // Returning findings starts a fix round on the same work, so the baseline
    // stays; the follow-up review must still cover everything the writer did.
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
    const workspace = this.#workspaceContext(provider);
    const allowedWriter = workspace.access === "workspace_write";
    if (!allowedWriter) {
      this.#diagnose(provider, "Unexpected approval request from a read-only lane was denied.");
      this.#patchLane(provider, { toolSummary: "unexpected approval denied (read-only)" });
      return "deny";
    }
    const id = randomUUID();
    const requestedPaths = [...request.paths, request.path, request.cwd].filter((value): value is string => Boolean(value));
    const outsideWorkspace = requestedPaths.some((path) => !isPathInsideWorkspace(workspace.root, path));
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
    if (this.#snapshot.queueOffer) {
      this.#patch({ notice: "Resolve the existing queue choice before sending another prompt." });
      return false;
    }
    const item = this.#freezeQueueItem(cleanPrompt);
    const unavailable = item.providers.find((provider) => this.#snapshot.lanes[provider].status === "UNAVAILABLE");
    if (unavailable) {
      this.#patch({ notice: `${unavailable} is unavailable; nothing was sent or queued.` });
      return false;
    }
    const busy = item.providers.some((provider) => !canAccept(this.#snapshot.lanes[provider]) || this.#queueDepth(provider) > 0);
    if (busy) {
      this.#patch({
        queueOffer: item,
        notice: `${item.target} cannot start atomically now. Queue the whole request or cancel; nothing was sent.`,
      });
      return false;
    }
    return this.#startQueueItem(item);
  }

  #queueContextMatches(item: QueueItem): boolean {
    return item.mode === this.#snapshot.mode &&
      item.writer === this.#snapshot.writer &&
      item.writerLeaseId === (this.#snapshot.writerLease?.id ?? null);
  }

  #startQueueItem(item: QueueItem): boolean {
    let metaDispatches: Record<ProviderId, MetaDispatch | null>;
    try {
      metaDispatches = this.#metaSession.prepareTurn(item.target, item.envelope.prompt);
    } catch (error) {
      this.#patch({ notice: sanitizeTerminalText((error as Error).message) });
      return false;
    }
    if (item.mode === "build" && item.writer && item.providers.includes(item.writer)) this.#lastWriterPrompt = item.envelope.prompt;
    for (const provider of item.providers) {
      this.#patchLane(provider, { status: "STARTING", error: null, errorKind: null, toolSummary: null });
    }
    this.#patch({ metaSession: this.#metaSession.snapshot, notice: null });
    void Promise.allSettled(item.providers.map((provider) => {
      const metaDispatch = metaDispatches[provider]!;
      this.#metaDispatches.set(provider, metaDispatch);
      this.#metaTextBuffers.set(provider, "");
      return this.#runLane(provider, { ...item.envelope, prompt: metaDispatch.prompt }, undefined, item.models[provider], metaDispatch);
    }));
    return true;
  }

  async #scheduleQueue(): Promise<void> {
    if (this.#queueScheduling) return;
    this.#queueScheduling = true;
    try {
      let changed = true;
      while (changed) {
        changed = false;
        const queue = [...this.#snapshot.queue];
        for (const item of queue) {
          if (item.status === "needs_confirmation") continue;
          const isHeadForEveryLane = item.providers.every((provider) =>
            this.#snapshot.queue.find((candidate) => candidate.providers.includes(provider))?.id === item.id
          );
          if (!isHeadForEveryLane || item.providers.some((provider) => !canAccept(this.#snapshot.lanes[provider]))) continue;
          if (!this.#queueContextMatches(item)) {
            this.#patch({
              queue: this.#snapshot.queue.map((candidate) => candidate.id === item.id
                ? Object.freeze({ ...candidate, status: "needs_confirmation" as const })
                : candidate),
              notice: `Queued request ${item.id.slice(0, 8)} needs confirmation because workspace authority changed.`,
            });
            changed = true;
            break;
          }
          this.#patch({ queue: this.#snapshot.queue.filter((candidate) => candidate.id !== item.id) });
          if (!this.#startQueueItem(item)) {
            this.#patch({
              queue: [...this.#snapshot.queue, Object.freeze({ ...item, status: "needs_confirmation" as const })],
              notice: "Queued request needs confirmation because the shared context window could not accept it.",
            });
          }
          changed = true;
          break;
        }
      }
    } finally {
      this.#queueScheduling = false;
    }
  }

  async #runLane(provider: ProviderId, envelope: PromptEnvelope, reviewMechanism?: ReviewMechanism, frozenModel?: string, metaDispatch?: MetaDispatch): Promise<void> {
    const adapter = this.adapters[provider];
    const run = ++this.#laneRun[provider];
    const current = () => this.#laneRun[provider] === run;
    this.#markIsolatedProcess(provider, "running");
    let providerTurnStarted = false;
    try {
      const workspace = this.#workspaceContext(provider);
      let session = this.#sessions.get(provider);
      const requestedModel = frozenModel ?? this.#snapshot.lanes[provider].requestedModel;
      if (session && session.requestedModel !== requestedModel) {
        this.#sessions.delete(provider);
        session = undefined;
      }
      if (!session) {
        session = await adapter.startSession({ projectRoot: workspace.root, requestedModel });
        if (!current()) return;
        this.#sessions.set(provider, session);
        this.#patchLane(provider, {
          sessionId: session.id || null,
          effectiveModel: session.effectiveModel,
        });
      }
      this.#persistSession(provider, false);
      const turnOptions: TurnOptions = {
        requestedModel,
        projectRoot: workspace.root,
        workspaceAccess: workspace.access,
        writerLease: workspace.lease,
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
      providerTurnStarted = true;
      // The lane may have been abandoned while the provider was still starting
      // up. The turn exists now, so interrupt it rather than stream it into a
      // lane the user has already been told is finished.
      if (!current()) {
        await adapter.interrupt(turn.id).catch((error: unknown) => this.#diagnose(provider, (error as Error).message));
        return;
      }
      this.#patchLane(provider, { turnId: turn.id });
      if (this.#revokeAfterTurn === provider) await this.cancel(provider);
      for await (const providerEvent of turn.events) {
        if (!current()) break;
        this.#applyEvent(provider, providerEvent);
      }
    } catch (error) {
      if (!current()) return;
      this.#diagnose(provider, (error as Error).message);
      this.#markIsolatedProcess(provider, "idle");
      const invalidated = error instanceof ProviderSessionInvalidatedError;
      if (invalidated) {
        this.#sessions.delete(provider);
        void this.#removeSessionMetadata(provider);
      }
      this.#patchLane(provider, {
        status: "FAILED",
        error: sanitizeTerminalText((error as Error).message),
        errorKind: classifyProviderError((error as Error).message),
        turnId: null,
        ...(invalidated ? { sessionId: null, effectiveModel: null } : {}),
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
      if (metaDispatch && providerTurnStarted) this.#completeMetaTurn(provider, "failed");
      else if (metaDispatch) this.#abandonMetaTurn(provider);
    } finally {
      if (current()) this.#markIsolatedProcess(provider, "idle");
      void this.#scheduleQueue();
    }
  }

  #completeMetaTurn(provider: ProviderId, outcome: "completed" | "cancelled" | "failed"): void {
    const dispatch = this.#metaDispatches.get(provider);
    if (!dispatch) return;
    this.#metaSession.acknowledge(dispatch);
    this.#metaSession.appendProviderResult(provider, this.#metaTextBuffers.get(provider) ?? "", outcome);
    this.#metaDispatches.delete(provider);
    this.#metaTextBuffers.delete(provider);
    this.#patch({
      metaSession: this.#metaSession.snapshot,
      notice: dispatch.injectedEntries
        ? `${provider} synchronized ${dispatch.injectedEntries} shared context entr${dispatch.injectedEntries === 1 ? "y" : "ies"} (${dispatch.injectedBytes} bytes).`
        : this.#snapshot.notice,
    });
  }

  #abandonMetaTurn(provider: ProviderId): void {
    this.#metaDispatches.delete(provider);
    this.#metaTextBuffers.delete(provider);
    this.#patch({ metaSession: this.#metaSession.snapshot });
  }

  #workspaceContext(provider: ProviderId): { root: string; access: "read_only" | "workspace_write"; lease: WriterLease | null } {
    const isolated = this.#snapshot.isolated;
    const isolatedGuard = this.#isolatedGuards.get(provider);
    const isolatedLease = this.#isolatedLeases.get(provider) ?? null;
    if (
      this.#snapshot.mode === "isolated" && isolated?.lifecycle === "active" &&
      isolatedGuard?.validate(isolatedLease, provider)
    ) {
      return { root: isolated.lanes[provider].path, access: "workspace_write", lease: isolatedLease };
    }
    const lease = this.#snapshot.writerLease;
    if (this.#snapshot.mode === "build" && this.#snapshot.writer === provider && this.#workspace.validate(lease, provider)) {
      return { root: this.projectRoot, access: "workspace_write", lease };
    }
    return { root: this.projectRoot, access: "read_only", lease: null };
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
        if (providerEvent.session_id) {
          const session = this.#sessions.get(provider);
          if (session) {
            session.id = providerEvent.session_id;
            if (typeof providerEvent.payload.effective_model === "string") session.effectiveModel = providerEvent.payload.effective_model;
          }
          this.#persistSession(provider, false);
        }
        break;
      case "turn.started":
        this.#patchLane(provider, { status: "RUNNING", turnId: providerEvent.turn_id });
        break;
      case "message.delta":
        if (this.#metaDispatches.has(provider)) {
          this.#metaTextBuffers.set(provider, appendBounded(this.#metaTextBuffers.get(provider) ?? "", String(providerEvent.payload.text ?? ""), 32_768));
        }
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
        const workspace = this.#workspaceContext(provider);
        this.#addActivity(provider, {
          id: providerEvent.event_id,
          kind: "file",
          status: "completed",
          title: path ? "File changed" : "File change reported",
          detail: path,
          safetyEffect: workspace.access === "workspace_write"
            ? this.#snapshot.mode === "isolated" ? "isolated provider worktree" : "writer workspace"
            : "read-only anomaly",
          timestamp: providerEvent.timestamp,
        });
        if (this.#snapshot.writer === provider) this.#git.noteWriterChange(path);
        if (this.#gitRefreshTimer) clearTimeout(this.#gitRefreshTimer);
        this.#gitRefreshTimer = setTimeout(() => {
          this.#gitRefreshTimer = null;
          this.#refreshEvidence();
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
          safetyEffect: this.#workspaceContext(provider).access === "workspace_write"
            ? this.#snapshot.mode === "isolated" ? "isolated worktree approval" : "temporary writer approval"
            : "deny-only read-only request",
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
        this.#completeMetaTurn(provider, "completed");
        this.#markIsolatedProcess(provider, "idle");
        this.#patchLane(provider, { status: "COMPLETED", turnId: null });
        this.#refreshEvidence();
        if (this.#revokeAfterTurn === provider) this.#completeRevocation(provider);
        this.#persistSession(provider, true);
        break;
      case "turn.cancelled":
        this.#resolveApprovalsFor(provider, "cancel_turn");
        this.#completeMetaTurn(provider, "cancelled");
        this.#markIsolatedProcess(provider, "idle");
        this.#patchLane(provider, { status: "CANCELLED", turnId: null });
        this.#refreshEvidence();
        if (this.#snapshot.writer === provider || this.#revokeAfterTurn === provider) this.#completeRevocation(provider);
        this.#persistSession(provider, true);
        break;
      case "turn.failed":
        this.#resolveApprovalsFor(provider, "cancel_turn");
        this.#completeMetaTurn(provider, "failed");
        this.#markIsolatedProcess(provider, "idle");
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
        this.#refreshEvidence();
        if (this.#snapshot.writer === provider || this.#revokeAfterTurn === provider) this.#completeRevocation(provider);
        this.#persistSession(provider, true);
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
    if (!["STARTING", "RUNNING", "BLOCKED"].includes(lane.status)) {
      this.#patch({ notice: `${provider} has no cancellable turn.` });
      return;
    }
    if (!lane.turnId) {
      // Startup has not produced a turn to interrupt. A wedged startSession
      // would otherwise pin the lane in STARTING forever, blocking the queue,
      // model changes, writer promotion, review, and isolated mode with no way
      // out but quitting. Abandon the run instead: its token is now stale, so
      // its patches and events are dropped, and #runLane interrupts the turn if
      // the provider ever produces one.
      this.#laneRun[provider] += 1;
      this.#resolveApprovalsFor(provider, "cancel_turn");
      this.#abandonMetaTurn(provider);
      this.#markIsolatedProcess(provider, "idle");
      this.#patchLane(provider, { status: "CANCELLED", turnId: null });
      this.#patch({ notice: `${provider} was abandoned during startup before a turn began; its CLI process is terminated when Splitlane exits.` });
      if (this.#snapshot.writer === provider || this.#revokeAfterTurn === provider) this.#completeRevocation(provider);
      void this.#scheduleQueue();
      return;
    }
    this.#resolveApprovalsFor(provider, "cancel_turn");
    this.#patchLane(provider, { status: "CANCELLING" });
    try {
      await this.adapters[provider].interrupt(lane.turnId);
    } catch (error) {
      this.#diagnose(provider, (error as Error).message);
      this.#persistSession(provider, false);
      const invalidated = error instanceof ProviderSessionInvalidatedError;
      if (invalidated) this.#sessions.delete(provider);
      this.#patchLane(provider, {
        status: "FAILED",
        error: sanitizeTerminalText((error as Error).message),
        errorKind: classifyProviderError((error as Error).message),
        ...(invalidated ? { sessionId: null, effectiveModel: null, turnId: null } : {}),
      });
      if (this.#snapshot.writer === provider) this.#completeRevocation(provider);
    }
  }

  async refreshGit(): Promise<void> {
    const git = await this.#git.refresh();
    this.#patch({ git, evidencePreview: this.#snapshot.evidencePreview && git.files.includes(this.#snapshot.evidencePreview.file) ? this.#snapshot.evidencePreview : null });
  }

  async selectEvidenceFile(path: string): Promise<void> {
    if (!this.#snapshot.git.files.includes(path)) return;
    const preview = await this.#git.preview(path);
    if (!this.#snapshot.git.files.includes(path)) return;
    this.#patch({ evidencePreview: preview });
  }

  /** Provider file-change events are the only automatic trigger, so an edit
   * made outside Splitlane stays invisible until the evidence is rechecked on
   * request. */
  async refreshEvidence(): Promise<void> {
    if (this.#snapshot.mode === "isolated") await this.refreshIsolated();
    else await this.refreshGit();
  }

  #refreshEvidence(): void {
    void this.refreshEvidence();
  }

  async close(): Promise<void> {
    if (this.#gitRefreshTimer) clearTimeout(this.#gitRefreshTimer);
    this.#gitRefreshTimer = null;
    this.#resolveApprovalsFor("claude", "cancel_turn");
    this.#resolveApprovalsFor("codex", "cancel_turn");
    this.#patch({ queue: [], queueOffer: null });
    for (const provider of ["claude", "codex"] as const) {
      const active = ["STARTING", "RUNNING", "BLOCKED", "CANCELLING"].includes(this.#snapshot.lanes[provider].status);
      this.#persistSession(provider, !active);
    }
    await Promise.allSettled([...this.#sessionWrites.values()]);
    await Promise.allSettled(Object.values(this.adapters).map((adapter) => adapter.close()));
    await this.#worktreeWrite;
    if (this.#snapshot.writer) this.#completeRevocation(this.#snapshot.writer);
    const isolated = this.#snapshot.isolated;
    if (this.#worktreeManager && isolated && isolated.lifecycle === "active") {
      try {
        const retained = await this.#worktreeManager.retain(isolated);
        this.#patch({ mode: "compare", isolated: retained });
      } catch (error) {
        this.#diagnose("claude", `Isolated shutdown retention failed: ${(error as Error).message}`);
      }
    }
    this.#leaveIsolatedSessions();
  }
}
