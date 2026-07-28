import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import { terminateProcessGroup } from "../process/child.ts";
import { sanitizeTerminalText } from "../terminal/sanitize.ts";

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class CodexRpcResponseError extends Error {}
export class CodexRpcAmbiguousError extends Error {}

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export class CodexRpcClient {
  readonly #events = new EventEmitter();
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #child: ChildProcessWithoutNullStreams | null = null;
  #lines: readline.Interface | null = null;
  #stderr = "";

  constructor(
    readonly onNotification: (message: RpcMessage) => void,
    readonly onServerRequest: (message: RpcMessage) => void,
    readonly onExit: (error: Error) => void = () => {},
    readonly command = "codex",
    readonly args: readonly string[] = ["app-server", "--stdio"],
  ) {}

  get stderr(): string {
    return this.#stderr;
  }

  async start(): Promise<void> {
    if (this.#child) return;
    const child = spawn(this.command, [...this.args], {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    // An app-server that dies with a write in flight raises EPIPE on stdin.
    // Without a listener that is an unhandled 'error' event, which would take
    // the whole TUI — and the other lane — down with it. The exit handler below
    // is what actually reports the failure.
    child.stdin.on("error", (error: Error) => {
      this.#stderr = (this.#stderr + sanitizeTerminalText(`\n[stdin] ${error.message}\n`)).slice(-64_000);
    });
    this.#lines = readline.createInterface({ input: child.stdout });
    this.#lines.on("line", (line) => this.#handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.#stderr = (this.#stderr + sanitizeTerminalText(chunk.toString("utf8"))).slice(-64_000);
    });
    child.once("exit", (code, signal) => {
      const error = new Error(`codex app-server exited (code=${code}, signal=${signal})`);
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new CodexRpcAmbiguousError(error.message));
      }
      this.#pending.clear();
      this.#events.emit("exit", error);
      this.onExit(error);
    });
  }

  #handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = JSON.parse(line) as RpcMessage;
    } catch {
      this.onNotification({ method: "diagnostic/malformed", params: { line: sanitizeTerminalText(line) } });
      return;
    }
    if (typeof message.id === "number" && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new CodexRpcResponseError(message.error.message ?? "Codex RPC error"));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) this.onServerRequest(message);
    else if (message.method) this.onNotification(message);
    this.#events.emit("message", message);
  }

  request<T>(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    const child = this.#child;
    if (!child) return Promise.reject(new Error("codex app-server is not started"));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CodexRpcAmbiguousError(`Timed out waiting for Codex ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(id);
        pending.reject(new CodexRpcAmbiguousError(`Unable to write Codex ${method}: ${error.message}`));
      });
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.#write(method, { method, params });
  }

  respond(id: number | string, result: Record<string, unknown>): void {
    this.#write("response", { id, result });
  }

  #write(label: string, message: Record<string, unknown>): void {
    this.#child?.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (!error) return;
      this.#stderr = (this.#stderr + sanitizeTerminalText(`\n[stdin] unable to write ${label}: ${error.message}\n`)).slice(-64_000);
    });
  }

  async close(): Promise<void> {
    this.#lines?.close();
    this.#lines = null;
    if (this.#child) await terminateProcessGroup(this.#child);
    this.#child = null;
  }
}
