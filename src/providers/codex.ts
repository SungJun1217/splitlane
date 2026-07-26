import { AsyncQueue } from "../core/async-queue.ts";
import { event } from "../core/events.ts";
import type {
  ApprovalDecision,
  NormalizedEvent,
  ProviderApprovalRequest,
  ProviderAdapter,
  ProviderProbe,
  ProviderTurn,
  SessionHandle,
  SessionOptions,
  TurnOptions,
  WorkspaceAccess,
} from "../domain.ts";
import { runCommand } from "../process/child.ts";
import { sanitizeIdentifier, sanitizeTerminalText } from "../terminal/sanitize.ts";
import { isAuthenticWriterLease } from "../workspace/guard.ts";
import { CodexRpcClient, type RpcMessage } from "./codex-rpc.ts";

interface ThreadStartResponse {
  thread: { id: string };
  model: string;
  modelProvider: string;
}

interface TurnStartResponse {
  turn: { id: string };
}

interface ActiveTurn {
  threadId: string;
  turnId: string | null;
  queue: AsyncQueue<NormalizedEvent>;
  finished: boolean;
  workspaceAccess: WorkspaceAccess;
  requestApproval(request: ProviderApprovalRequest): Promise<ApprovalDecision>;
  filePathsByItem: Map<string, readonly string[]>;
}

function params(message: RpcMessage): Record<string, unknown> {
  return message.params ?? {};
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export interface ParsedCodexNotification {
  kind: NormalizedEvent["kind"];
  payload: Record<string, unknown>;
  terminal?: boolean;
}

export function parseCodexNotification(message: RpcMessage): ParsedCodexNotification[] {
  const value = params(message);
  const item = nestedRecord(value.item);
  switch (message.method) {
    case "turn/started":
      return [{ kind: "turn.started", payload: {} }];
    case "item/agentMessage/delta":
      return typeof value.delta === "string" ? [{ kind: "message.delta", payload: { text: value.delta } }] : [];
    case "item/started":
      if (item.type === "commandExecution" || item.type === "mcpToolCall") {
        return [{ kind: "tool.started", payload: { tool: sanitizeTerminalText(item.type) } }];
      }
      if (item.type === "fileChange") {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const fileEvents = changes.flatMap((value) => {
          const change = nestedRecord(value);
          return typeof change.path === "string"
            ? [{ kind: "file.changed" as const, payload: { path: sanitizeTerminalText(change.path) } }]
            : [];
        });
        return fileEvents.length ? fileEvents : [{ kind: "file.changed", payload: { hint: true } }];
      }
      return [];
    case "item/completed":
      if (item.type === "commandExecution" || item.type === "mcpToolCall") {
        return [{ kind: "tool.completed", payload: { tool: sanitizeTerminalText(item.type) } }];
      }
      return item.type === "agentMessage" ? [{ kind: "message.completed", payload: {} }] : [];
    case "thread/tokenUsage/updated":
      return [{ kind: "usage.updated", payload: { available: true } }];
    case "turn/completed": {
      const turn = nestedRecord(value.turn);
      const status = turn.status;
      const kind = status === "completed" ? "turn.completed" : status === "interrupted" ? "turn.cancelled" : "turn.failed";
      return [{ kind, payload: status === "failed" ? { error: "Codex turn failed" } : {}, terminal: true }];
    }
    case "error":
      return [{ kind: "provider.warning", payload: { message: sanitizeTerminalText(value.message) } }];
    case "diagnostic/malformed":
      return [{ kind: "provider.warning", payload: { message: "Malformed Codex app-server event" } }];
    default:
      return [];
  }
}

export function parseCodexApprovalRequest(message: RpcMessage): ProviderApprovalRequest | null {
  if (message.id === undefined) return null;
  const value = params(message);
  if (message.method === "item/commandExecution/requestApproval") {
    return {
      providerRequestId: String(message.id),
      kind: "command",
      tool: "Command execution",
      command: typeof value.command === "string" ? sanitizeTerminalText(value.command) : null,
      cwd: typeof value.cwd === "string" ? sanitizeTerminalText(value.cwd) : null,
      path: null,
      paths: [],
      reason: typeof value.reason === "string" ? sanitizeTerminalText(value.reason) : null,
      networkEffect: value.networkApprovalContext ? "requested" : "off",
    };
  }
  if (message.method === "item/fileChange/requestApproval") {
    return {
      providerRequestId: String(message.id),
      kind: "file_change",
      tool: "File change",
      command: null,
      cwd: null,
      path: typeof value.grantRoot === "string" ? sanitizeTerminalText(value.grantRoot) : null,
      paths: typeof value.grantRoot === "string" ? [sanitizeTerminalText(value.grantRoot)] : [],
      reason: typeof value.reason === "string" ? sanitizeTerminalText(value.reason) : null,
      networkEffect: "off",
    };
  }
  return null;
}

export function codexApprovalResponse(decision: ApprovalDecision): { decision: "accept" | "decline" | "cancel" } {
  return {
    decision: decision === "allow_once" ? "accept" : decision === "deny" ? "decline" : "cancel",
  };
}

export class CodexAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  readonly #activeByThread = new Map<string, ActiveTurn>();
  readonly #activeByTurn = new Map<string, ActiveTurn>();
  #rpc: CodexRpcClient | null = null;
  #version: string | null = null;
  #projectRoot = process.cwd();

  async probe(): Promise<ProviderProbe> {
    const result = await runCommand("codex", ["--version"]);
    this.#version = result.available && result.exitCode === 0 ? sanitizeTerminalText(result.stdout).trim() : null;
    return {
      provider: this.provider,
      available: this.#version !== null,
      version: this.#version,
      error: this.#version ? null : result.stderr || "Codex binary not found",
    };
  }

  async #ensureRpc(): Promise<CodexRpcClient> {
    if (this.#rpc) return this.#rpc;
    const rpc = new CodexRpcClient(
      (message) => this.#onNotification(message),
      (message) => { void this.#onServerRequest(message); },
      (error) => this.#onExit(error),
    );
    await rpc.start();
    await rpc.request("initialize", {
      clientInfo: {
        name: "splitlane",
        title: "Splitlane",
        version: "0.1.0-m2",
      },
      capabilities: { experimentalApi: false },
    });
    rpc.notify("initialized");
    this.#rpc = rpc;
    return rpc;
  }

  async startSession(options: SessionOptions): Promise<SessionHandle> {
    this.#projectRoot = options.projectRoot;
    const rpc = await this.#ensureRpc();
    const model = options.requestedModel === "default" ? {} : { model: options.requestedModel };
    const response = await rpc.request<ThreadStartResponse>("thread/start", {
      cwd: options.projectRoot,
      sandbox: "read-only",
      approvalPolicy: "untrusted",
      ephemeral: true,
      ...model,
    });
    return {
      provider: this.provider,
      id: response.thread.id,
      requestedModel: options.requestedModel,
      effectiveModel: sanitizeIdentifier(response.model) || options.requestedModel,
    };
  }

  async startTurn(session: SessionHandle, prompt: string, options: TurnOptions): Promise<ProviderTurn> {
    if (options.workspaceAccess === "workspace_write") {
      const lease = options.writerLease;
      if (!isAuthenticWriterLease(lease, this.provider, options.projectRoot) || options.projectRoot !== this.#projectRoot) {
        throw new Error("Codex workspace-write rejected: missing matching writer lease");
      }
    }
    const rpc = await this.#ensureRpc();
    const active: ActiveTurn = {
      threadId: session.id,
      turnId: null,
      queue: new AsyncQueue<NormalizedEvent>(),
      finished: false,
      workspaceAccess: options.workspaceAccess,
      requestApproval: options.requestApproval,
      filePathsByItem: new Map(),
    };
    this.#activeByThread.set(session.id, active);
    try {
      const model = options.requestedModel === "default" ? {} : { model: options.requestedModel };
      const writable = options.workspaceAccess === "workspace_write";
      const response = await rpc.request<TurnStartResponse>("turn/start", {
        threadId: session.id,
        input: [{ type: "text", text: prompt }],
        cwd: this.#projectRoot,
        sandboxPolicy: writable
          ? {
              type: "workspaceWrite",
              writableRoots: [this.#projectRoot],
              networkAccess: false,
              excludeTmpdirEnvVar: true,
              excludeSlashTmp: true,
            }
          : { type: "readOnly", networkAccess: false },
        approvalPolicy: "untrusted",
        ...model,
      });
      active.turnId = response.turn.id;
      if (!active.finished) this.#activeByTurn.set(response.turn.id, active);
      return { id: response.turn.id, events: active.queue };
    } catch (error) {
      this.#activeByThread.delete(session.id);
      active.queue.push(event(this.provider, "turn.failed", {
        sessionId: session.id,
        payload: { error: sanitizeTerminalText((error as Error).message) },
        rawVersion: this.#version,
      }));
      active.queue.close();
      throw error;
    }
  }

  #current(message: RpcMessage): ActiveTurn | null {
    const value = params(message);
    const turn = nestedRecord(value.turn);
    const item = nestedRecord(value.item);
    const turnId =
      (typeof value.turnId === "string" && value.turnId) ||
      (typeof turn.id === "string" && turn.id) ||
      (typeof item.turnId === "string" && item.turnId) ||
      null;
    const threadId = typeof value.threadId === "string" ? value.threadId : null;
    return (turnId && this.#activeByTurn.get(turnId)) ||
      (threadId && this.#activeByThread.get(threadId)) ||
      null;
  }

  #emit(active: ActiveTurn, kind: NormalizedEvent["kind"], payload: Record<string, unknown> = {}): void {
    active.queue.push(event(this.provider, kind, {
      sessionId: active.threadId,
      turnId: active.turnId,
      payload,
      rawVersion: this.#version,
    }));
  }

  #onNotification(message: RpcMessage): void {
    const active = this.#current(message);
    if (!active) return;
    const value = params(message);
    const item = nestedRecord(value.item);
    if (message.method === "item/started" && item.type === "fileChange" && typeof item.id === "string") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.flatMap((changeValue) => {
        const change = nestedRecord(changeValue);
        return typeof change.path === "string" ? [sanitizeTerminalText(change.path)] : [];
      });
      active.filePathsByItem.set(item.id, paths);
    }
    for (const parsed of parseCodexNotification(message)) {
      this.#emit(active, parsed.kind, parsed.payload);
      if (parsed.terminal) this.#finish(active);
    }
  }

  #onExit(error: Error): void {
    for (const active of [...this.#activeByThread.values()]) {
      this.#emit(active, "turn.failed", { error: sanitizeTerminalText(error.message) });
      this.#finish(active);
    }
    this.#rpc = null;
  }

  async #onServerRequest(message: RpcMessage): Promise<void> {
    if (message.id === undefined) return;
    const active = this.#current(message);
    if (!active) {
      this.#rpc?.respond(message.id, { decision: "cancel" });
      return;
    }
    let request = parseCodexApprovalRequest(message);
    if (!request) {
      this.#emit(active, "provider.warning", { message: `Unsupported Codex server request: ${sanitizeTerminalText(message.method)}` });
      this.#rpc?.respond(message.id, { decision: "cancel" });
      return;
    }
    if (request.kind === "file_change" && request.paths.length === 0) {
      const value = params(message);
      const itemId = typeof value.itemId === "string" ? value.itemId : null;
      const paths = itemId ? active.filePathsByItem.get(itemId) ?? [] : [];
      request = { ...request, path: paths[0] ?? null, paths };
    }
    this.#emit(active, "approval.requested", {
      request_method: sanitizeTerminalText(message.method),
      tool: request.tool,
      command: request.command,
      path: request.path,
    });
    try {
      const decision = await active.requestApproval(request);
      this.#rpc?.respond(message.id, codexApprovalResponse(decision));
      this.#emit(active, "approval.resolved", { decision });
    } catch (error) {
      this.#rpc?.respond(message.id, { decision: "cancel" });
      this.#emit(active, "provider.warning", { message: sanitizeTerminalText((error as Error).message) });
      this.#emit(active, "approval.resolved", { decision: "cancel_turn" });
    }
  }

  #finish(active: ActiveTurn): void {
    active.finished = true;
    this.#activeByThread.delete(active.threadId);
    if (active.turnId) this.#activeByTurn.delete(active.turnId);
    active.queue.close();
  }

  async interrupt(turnId: string): Promise<void> {
    const active = this.#activeByTurn.get(turnId);
    if (!active || !this.#rpc) return;
    await this.#rpc.request("turn/interrupt", { threadId: active.threadId, turnId });
  }

  async close(): Promise<void> {
    for (const active of this.#activeByThread.values()) active.queue.close();
    this.#activeByThread.clear();
    this.#activeByTurn.clear();
    await this.#rpc?.close();
    this.#rpc = null;
  }
}
