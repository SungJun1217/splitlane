import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { AsyncQueue } from "../core/async-queue.ts";
import { event } from "../core/events.ts";
import type {
  ApprovalDecision,
  NormalizedEvent,
  ProviderAdapter,
  ProviderProbe,
  ProviderTurn,
  SessionHandle,
  SessionOptions,
  TurnOptions,
} from "../domain.ts";
import { runCommand } from "../process/child.ts";
import { sanitizeIdentifier, sanitizeTerminalText } from "../terminal/sanitize.ts";
import { isAuthenticWriterLease } from "../workspace/guard.ts";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}

function textDelta(message: UnknownRecord): string | null {
  if (message.type !== "stream_event") return null;
  const sdkEvent = record(message.event);
  if (sdkEvent.type !== "content_block_delta") return null;
  const delta = record(sdkEvent.delta);
  return delta.type === "text_delta" && typeof delta.text === "string" ? delta.text : null;
}

export interface ParsedClaudeMessage {
  sessionId?: string;
  effectiveModel?: string;
  sawTextDelta: boolean;
  events: Array<{ kind: NormalizedEvent["kind"]; payload: Record<string, unknown> }>;
}

export function claudePermissionResult(decision: ApprovalDecision, toolUseID: string) {
  if (decision === "allow_once") {
    return {
      behavior: "allow" as const,
      toolUseID,
      decisionClassification: "user_temporary" as const,
    };
  }
  return {
    behavior: "deny" as const,
    message: decision === "cancel_turn" ? "User cancelled the Splitlane turn." : "User denied this operation.",
    interrupt: decision === "cancel_turn",
    toolUseID,
    decisionClassification: "user_reject" as const,
  };
}

export function parseClaudeMessage(rawMessage: unknown, sawTextDelta: boolean): ParsedClaudeMessage {
  const message = record(rawMessage);
  if (typeof message.type !== "string") {
    return {
      sawTextDelta,
      events: [{ kind: "provider.warning", payload: { message: "Malformed Claude SDK event" } }],
    };
  }
  if (message.type === "system" && message.subtype === "init") {
    return {
      ...(typeof message.session_id === "string" ? { sessionId: message.session_id } : {}),
      ...(sanitizeIdentifier(message.model) ? { effectiveModel: sanitizeIdentifier(message.model) } : {}),
      sawTextDelta,
      events: [],
    };
  }
  const delta = textDelta(message);
  if (delta !== null) {
    return { sawTextDelta: true, events: [{ kind: "message.delta", payload: { text: delta } }] };
  }
  if (message.type === "assistant") {
    const sdkMessage = record(message.message);
    const content = Array.isArray(sdkMessage.content) ? sdkMessage.content : [];
    const events: ParsedClaudeMessage["events"] = [];
    for (const blockValue of content) {
      const block = record(blockValue);
      if (!sawTextDelta && block.type === "text" && typeof block.text === "string") {
        events.push({ kind: "message.delta", payload: { text: block.text } });
      }
      if (block.type === "tool_use") {
        events.push({ kind: "tool.started", payload: { tool: sanitizeTerminalText(block.name) } });
      }
    }
    return { sawTextDelta, events };
  }
  if (message.type === "result") {
    const success = message.subtype === "success" && message.is_error !== true;
    return {
      sawTextDelta,
      events: [{
        kind: success ? "turn.completed" : "turn.failed",
        payload: success ? {} : { error: sanitizeTerminalText(message.result ?? "Claude turn failed") },
      }],
    };
  }
  return { sawTextDelta, events: [] };
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = "claude" as const;
  readonly #controllers = new Map<string, AbortController>();
  readonly #queries = new Map<string, ReturnType<typeof query>>();
  #version: string | null = null;
  #projectRoot = process.cwd();

  constructor(readonly queryFn: typeof query = query) {}

  async probe(): Promise<ProviderProbe> {
    const result = await runCommand("claude", ["--version"]);
    this.#version = result.available && result.exitCode === 0 ? sanitizeTerminalText(result.stdout).trim() : null;
    return {
      provider: this.provider,
      available: this.#version !== null,
      version: this.#version,
      error: this.#version ? null : result.stderr || "Claude Code binary not found",
    };
  }

  async startSession(options: SessionOptions): Promise<SessionHandle> {
    this.#projectRoot = options.projectRoot;
    return {
      provider: this.provider,
      id: "",
      requestedModel: options.requestedModel,
      effectiveModel: options.requestedModel,
    };
  }

  async resumeSession(sessionId: string, options: SessionOptions): Promise<SessionHandle> {
    this.#projectRoot = options.projectRoot;
    if (!sessionId.trim()) throw new Error("Claude resume requires a provider session ID.");
    return { provider: this.provider, id: sessionId, requestedModel: options.requestedModel, effectiveModel: options.requestedModel };
  }

  async startTurn(session: SessionHandle, prompt: string, options: TurnOptions): Promise<ProviderTurn> {
    if (options.workspaceAccess === "workspace_write") {
      const lease = options.writerLease;
      if (!isAuthenticWriterLease(lease, this.provider, options.projectRoot) || options.projectRoot !== this.#projectRoot) {
        throw new Error("Claude workspace-write rejected: missing matching writer lease");
      }
    }
    const turnId = randomUUID();
    const queue = new AsyncQueue<NormalizedEvent>();
    const abortController = new AbortController();
    this.#controllers.set(turnId, abortController);
    void this.#consume(session, turnId, prompt, options, queue, abortController);
    return { id: turnId, events: queue };
  }

  async #consume(
    session: SessionHandle,
    turnId: string,
    prompt: string,
    options: TurnOptions,
    queue: AsyncQueue<NormalizedEvent>,
    abortController: AbortController,
  ): Promise<void> {
    let providerSessionId = session.id;
    let sawTextDelta = false;
    let terminalEventSeen = false;
    const resumed = Boolean(session.id);
    let queryStream: ReturnType<typeof query> | null = null;
    try {
      const writable = options.workspaceAccess === "workspace_write";
      const sdkOptions: Options = {
        cwd: this.#projectRoot,
        abortController,
        includePartialMessages: true,
        permissionMode: writable ? "default" as const : "plan" as const,
        settingSources: ["user", "project", "local"],
        tools: writable
          ? ["Read", "Glob", "Grep", "Bash", "Write", "Edit", "NotebookEdit"]
          : ["Read", "Glob", "Grep", "Bash"],
        ...(writable
          ? {
              sandbox: {
                enabled: true,
                failIfUnavailable: true,
                autoAllowBashIfSandboxed: false,
                allowUnsandboxedCommands: false,
                network: { allowedDomains: [], deniedDomains: ["*"], strictAllowlist: true },
                filesystem: { allowWrite: [this.#projectRoot] },
              },
              settings: {
                permissions: {
                  deny: ["WebFetch", "WebSearch"],
                  ask: ["Bash(*)", "Write(*)", "Edit(*)", "NotebookEdit(*)"],
                  defaultMode: "default" as const,
                  disableBypassPermissionsMode: "disable" as const,
                },
              },
            }
          : {}),
        ...(options.requestedModel === "default" ? {} : { model: options.requestedModel }),
        ...(session.id ? { resume: session.id } : {}),
        canUseTool: async (toolName: string, input: UnknownRecord, permission) => {
          const path = typeof permission.blockedPath === "string"
            ? permission.blockedPath
            : typeof input.file_path === "string"
              ? input.file_path
              : typeof input.path === "string"
                ? input.path
                : null;
          const command = typeof input.command === "string" ? input.command : null;
          queue.push(event(this.provider, "approval.requested", {
            sessionId: providerSessionId,
            turnId,
            payload: {
              request_id: sanitizeIdentifier(permission.requestId),
              tool: sanitizeTerminalText(toolName),
              command: command ? sanitizeTerminalText(command) : null,
              path: path ? sanitizeTerminalText(path) : null,
            },
            rawVersion: this.#version,
          }));
          const permissionReason = sanitizeTerminalText(
            permission.title ?? permission.decisionReason ?? permission.description,
          );
          const networkRequested = /\bnetwork\b|\binternet\b|\bweb\b/i.test(permissionReason) ||
            toolName === "WebFetch" || toolName === "WebSearch";
          const approvalKind = toolName === "Bash"
            ? "command"
            : ["Write", "Edit", "NotebookEdit"].includes(toolName)
              ? "file_change"
              : "tool";
          const decision = await options.requestApproval({
            providerRequestId: sanitizeIdentifier(permission.requestId) || randomUUID(),
            kind: approvalKind,
            tool: sanitizeTerminalText(permission.displayName ?? toolName),
            command: command ? sanitizeTerminalText(command) : null,
            cwd: this.#projectRoot,
            path: path ? sanitizeTerminalText(path) : null,
            paths: path ? [sanitizeTerminalText(path)] : [],
            reason: permissionReason || null,
            networkEffect: networkRequested ? "requested" : "off",
          });
          queue.push(event(this.provider, "approval.resolved", {
            sessionId: providerSessionId,
            turnId,
            payload: { decision },
            rawVersion: this.#version,
          }));
          if (decision === "allow_once" && approvalKind === "file_change" && path) {
            queue.push(event(this.provider, "file.changed", {
              sessionId: providerSessionId,
              turnId,
              payload: { path: sanitizeTerminalText(path), hint: true },
              rawVersion: this.#version,
            }));
          }
          return claudePermissionResult(decision, permission.toolUseID);
        },
      };

      queryStream = this.queryFn({ prompt, options: sdkOptions });
      this.#queries.set(turnId, queryStream);
      for await (const rawMessage of queryStream) {
        const parsed = parseClaudeMessage(rawMessage, sawTextDelta);
        sawTextDelta = parsed.sawTextDelta;
        if (parsed.sessionId) {
          providerSessionId = parsed.sessionId;
          session.id = providerSessionId;
          if (parsed.effectiveModel) session.effectiveModel = parsed.effectiveModel;
          queue.push(event(this.provider, resumed ? "session.resumed" : "session.started", {
            sessionId: providerSessionId,
            turnId,
            payload: { effective_model: session.effectiveModel },
            rawVersion: this.#version,
          }));
          queue.push(event(this.provider, "turn.started", {
            sessionId: providerSessionId,
            turnId,
            rawVersion: this.#version,
          }));
          continue;
        }
        for (const parsedEvent of parsed.events) {
          if (["turn.completed", "turn.failed", "turn.cancelled"].includes(parsedEvent.kind)) terminalEventSeen = true;
          queue.push(event(this.provider, parsedEvent.kind, {
            sessionId: providerSessionId,
            turnId,
            payload: parsedEvent.payload,
            rawVersion: this.#version,
          }));
        }
      }
      if (!terminalEventSeen) {
        queue.push(event(this.provider, "turn.failed", {
          sessionId: providerSessionId,
          turnId,
          payload: { error: "Claude stream ended without a result event" },
          rawVersion: this.#version,
        }));
      }
    } catch (error) {
      const cancelled = abortController.signal.aborted;
      queue.push(event(this.provider, cancelled ? "turn.cancelled" : "turn.failed", {
        sessionId: providerSessionId,
        turnId,
        payload: cancelled ? {} : { error: sanitizeTerminalText((error as Error).message) },
        rawVersion: this.#version,
      }));
    } finally {
      queryStream?.close?.();
      this.#queries.delete(turnId);
      this.#controllers.delete(turnId);
      queue.close();
    }
  }

  async interrupt(turnId: string): Promise<void> {
    this.#queries.get(turnId)?.close();
    this.#controllers.get(turnId)?.abort();
  }

  async close(): Promise<void> {
    for (const queryStream of this.#queries.values()) queryStream.close();
    for (const controller of this.#controllers.values()) controller.abort();
    this.#queries.clear();
    this.#controllers.clear();
  }
}
