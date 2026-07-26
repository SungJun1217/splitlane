export type ProviderId = "claude" | "codex";
export type PromptTarget = "both" | ProviderId;
export type WorkflowMode = "compare" | "build" | "review";
export type CapabilityStability = "stable" | "preview" | "experimental";
export type WorkspaceAccess = "read_only" | "workspace_write";
export type ApprovalDecision = "allow_once" | "deny" | "cancel_turn";

export type EventKind =
  | "session.started"
  | "session.resumed"
  | "turn.started"
  | "message.delta"
  | "message.completed"
  | "tool.started"
  | "tool.progress"
  | "tool.completed"
  | "file.changed"
  | "approval.requested"
  | "approval.resolved"
  | "usage.updated"
  | "turn.completed"
  | "turn.failed"
  | "turn.cancelled"
  | "provider.warning";

export interface NormalizedEvent {
  event_id: string;
  provider: ProviderId;
  session_id: string | null;
  turn_id: string | null;
  timestamp: string;
  kind: EventKind;
  payload: Record<string, unknown>;
  raw_version: string | null;
  capability_id?: string;
  capability_stability?: CapabilityStability;
  native_event_kind?: string;
  safety_effect?: string;
}

export interface ProviderProbe {
  provider: ProviderId;
  available: boolean;
  version: string | null;
  error: string | null;
}

export interface SessionHandle {
  provider: ProviderId;
  id: string;
  requestedModel: string;
  effectiveModel: string;
}

export interface SessionOptions {
  projectRoot: string;
  requestedModel: string;
}

export interface WriterLease {
  id: string;
  provider: ProviderId;
  projectRoot: string;
  grantedAt: string;
  baselineFingerprint: string;
}

export interface ProviderApprovalRequest {
  providerRequestId: string;
  kind: "command" | "file_change" | "tool" | "permissions";
  tool: string;
  command: string | null;
  cwd: string | null;
  path: string | null;
  paths: readonly string[];
  reason: string | null;
  networkEffect: "off" | "requested" | "unknown";
}

export interface PendingApproval extends ProviderApprovalRequest {
  id: string;
  provider: ProviderId;
  turnId: string;
  requestedAt: string;
  outsideWorkspace: boolean;
}

export interface TurnOptions {
  requestedModel: string;
  projectRoot: string;
  workspaceAccess: WorkspaceAccess;
  writerLease: WriterLease | null;
  requestApproval(request: ProviderApprovalRequest): Promise<ApprovalDecision>;
}

export interface ProviderTurn {
  id: string;
  events: AsyncIterable<NormalizedEvent>;
}

export interface ProviderAdapter {
  readonly provider: ProviderId;
  readonly reviewMechanisms?: readonly ReviewMechanism[];
  probe(): Promise<ProviderProbe>;
  startSession(options: SessionOptions): Promise<SessionHandle>;
  startTurn(session: SessionHandle, prompt: string, options: TurnOptions): Promise<ProviderTurn>;
  startReview?(session: SessionHandle, prompt: string, options: TurnOptions): Promise<ProviderTurn>;
  interrupt(turnId: string): Promise<void>;
  close(): Promise<void>;
}

export type LaneStatus =
  | "UNAVAILABLE"
  | "READY"
  | "STARTING"
  | "RUNNING"
  | "BLOCKED"
  | "CANCELLING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface LaneSnapshot {
  provider: ProviderId;
  status: LaneStatus;
  requestedModel: string;
  effectiveModel: string;
  sessionId: string | null;
  turnId: string | null;
  output: string;
  toolSummary: string | null;
  error: string | null;
}

export interface PromptEnvelope {
  envelopeId: string;
  createdAt: string;
  prompt: string;
}

export interface GitSnapshot {
  root: string;
  branch: string;
  dirty: boolean;
  files: readonly string[];
  diffStat: string;
  diff: string;
  error: string | null;
  baselineFingerprint: string | null;
  evidence: readonly GitFileEvidence[];
}

export type GitChangeClassification = "pre-existing" | "writer-hinted" | "unknown/external";

export interface GitFileEvidence {
  path: string;
  classification: GitChangeClassification;
}

export type ReviewMechanism = "claude_generic" | "codex_generic" | "codex_native";
export type ReviewSeverity = "blocker" | "high" | "medium" | "low" | "info";
export type ReviewStatus = "draft" | "running" | "completed" | "failed" | "cancelled" | "accepted" | "exited" | "returned";

export interface ReviewEnvelope {
  schemaVersion: "review-envelope/v1";
  id: string;
  createdAt: string;
  writer: ProviderId;
  reviewer: ProviderId;
  mechanism: ReviewMechanism;
  mechanismStability: CapabilityStability;
  objective: string;
  acceptanceCriteria: string;
  projectRoot: string;
  branch: string;
  head: string;
  baselineFingerprint: string;
  files: readonly GitFileEvidence[];
  diff: string;
  diffBytes: number;
  diffHash: string;
  truncated: false;
}

export interface ReviewFinding {
  id: string;
  provider: ProviderId;
  mechanism: ReviewMechanism;
  severity: ReviewSeverity;
  title: string;
  body: string;
  file: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  verification: string | null;
  selected: boolean;
}

export interface ReviewFilePreview {
  file: string;
  lineStart: number | null;
  lineEnd: number | null;
  content: string;
  error: string | null;
}

export interface ReviewSnapshot {
  status: ReviewStatus;
  writer: ProviderId;
  reviewer: ProviderId;
  mechanism: ReviewMechanism;
  availableMechanisms: readonly ReviewMechanism[];
  envelope: ReviewEnvelope;
  findings: readonly ReviewFinding[];
  activeFindingId: string | null;
  preview: ReviewFilePreview | null;
  stale: boolean;
  parseError: string | null;
}

export type RoleId =
  | "scout"
  | "architect"
  | "builder"
  | "debugger"
  | "intent_reviewer"
  | "correctness_reviewer";

export type RoleProfile = Record<RoleId, ProviderId>;

export interface AppSnapshot {
  mode: WorkflowMode;
  writer: ProviderId | null;
  writerLease: WriterLease | null;
  writerRevoking: boolean;
  target: PromptTarget;
  focusedProvider: ProviderId;
  inspectorVisible: boolean;
  lanes: Record<ProviderId, LaneSnapshot>;
  git: GitSnapshot;
  roles: RoleProfile;
  approvals: readonly PendingApproval[];
  review: ReviewSnapshot | null;
  diagnostics: readonly string[];
  notice: string | null;
}
