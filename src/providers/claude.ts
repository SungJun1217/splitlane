import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { AsyncQueue } from "../core/async-queue.ts";
import { event } from "../core/events.ts";
import type {
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

  async startTurn(session: SessionHandle, prompt: string, options: TurnOptions): Promise<ProviderTurn> {
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
      const sdkOptions: Options = {
        cwd: this.#projectRoot,
        abortController,
        includePartialMessages: true,
        permissionMode: "plan" as const,
        settingSources: ["user", "project", "local"],
        tools: ["Read", "Glob", "Grep", "Bash"],
        ...(options.requestedModel === "default" ? {} : { model: options.requestedModel }),
        ...(session.id ? { resume: session.id } : {}),
        canUseTool: async (toolName: string, input: UnknownRecord) => {
          queue.push(event(this.provider, "approval.requested", {
            sessionId: providerSessionId,
            turnId,
            payload: { tool: sanitizeTerminalText(toolName), input_keys: Object.keys(input) },
            rawVersion: this.#version,
          }));
          queue.push(event(this.provider, "approval.resolved", {
            sessionId: providerSessionId,
            turnId,
            payload: { decision: "deny", reason: "compare mode is read-only" },
            rawVersion: this.#version,
          }));
          return { behavior: "deny" as const, message: "Splitlane compare mode is read-only." };
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
