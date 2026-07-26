import { randomUUID } from "node:crypto";
import type {
  AppSnapshot,
  LaneSnapshot,
  NormalizedEvent,
  PromptEnvelope,
  PromptTarget,
  ProviderAdapter,
  ProviderId,
  RoleId,
  RoleProfile,
  SessionHandle,
} from "../domain.ts";
import { GitObserver } from "../git/observer.ts";
import { appendBounded, sanitizeTerminalText } from "../terminal/sanitize.ts";

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
  readonly #git: GitObserver;
  #snapshot: AppSnapshot;

  constructor(
    readonly projectRoot: string,
    readonly adapters: Record<ProviderId, ProviderAdapter>,
  ) {
    this.#git = new GitObserver(projectRoot);
    this.#snapshot = {
      mode: "compare",
      writer: null,
      target: "both",
      focusedProvider: "claude",
      inspectorVisible: true,
      lanes: { claude: blankLane("claude"), codex: blankLane("codex") },
      git: this.#git.snapshot,
      roles: { ...M1_PREVIEW_ROLES },
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
      const turn = await adapter.startTurn(session, envelope.prompt, { requestedModel });
      this.#patchLane(provider, { turnId: turn.id });
      for await (const providerEvent of turn.events) this.#applyEvent(provider, providerEvent);
    } catch (error) {
      this.#diagnose(provider, (error as Error).message);
      this.#patchLane(provider, {
        status: "FAILED",
        error: sanitizeTerminalText((error as Error).message),
        turnId: null,
      });
    }
  }

  #applyEvent(provider: ProviderId, providerEvent: NormalizedEvent): void {
    if (providerEvent.provider !== provider) {
      this.#diagnose(provider, "Cross-provider event rejected.");
      this.#patchLane(provider, { status: "FAILED", error: "Cross-provider event rejected." });
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
      case "approval.requested":
        this.#patchLane(provider, { status: "BLOCKED", toolSummary: "permission blocked (read-only compare)" });
        break;
      case "approval.resolved":
        this.#patchLane(provider, { status: "RUNNING" });
        break;
      case "turn.completed":
        this.#patchLane(provider, { status: "COMPLETED", turnId: null });
        void this.refreshGit();
        break;
      case "turn.cancelled":
        this.#patchLane(provider, { status: "CANCELLED", turnId: null });
        void this.refreshGit();
        break;
      case "turn.failed":
        this.#diagnose(provider, providerEvent.payload.error ?? "Provider turn failed");
        this.#patchLane(provider, {
          status: "FAILED",
          turnId: null,
          error: sanitizeTerminalText(providerEvent.payload.error ?? "Provider turn failed"),
        });
        void this.refreshGit();
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
    this.#patchLane(provider, { status: "CANCELLING" });
    try {
      await this.adapters[provider].interrupt(lane.turnId);
    } catch (error) {
      this.#diagnose(provider, (error as Error).message);
      this.#patchLane(provider, { status: "FAILED", error: sanitizeTerminalText((error as Error).message) });
    }
  }

  async refreshGit(): Promise<void> {
    const git = await this.#git.refresh();
    this.#patch({ git });
  }

  async close(): Promise<void> {
    await Promise.allSettled(Object.values(this.adapters).map((adapter) => adapter.close()));
  }
}
