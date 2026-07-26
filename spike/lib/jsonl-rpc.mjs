import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";
import { terminateProcessGroup } from "./process-group.mjs";
import { sanitizeTerminalText } from "./sanitize.mjs";

export class JsonlRpcProcess {
  constructor(command, args = [], options = {}) {
    this.command = command;
    this.args = args;
    this.options = options;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.serverRequests = [];
    this.stderr = "";
    this.events = new EventEmitter();
  }

  async start() {
    this.child = spawn(this.command, this.args, {
      cwd: this.options.cwd ?? process.cwd(),
      env: this.options.env ?? process.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    await new Promise((resolve, reject) => {
      const onSpawn = () => {
        cleanup();
        resolve();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        this.child.off("spawn", onSpawn);
        this.child.off("error", onError);
      };
      this.child.once("spawn", onSpawn);
      this.child.once("error", onError);
    });

    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.#onLine(line));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + sanitizeTerminalText(chunk.toString("utf8"))).slice(-64_000);
    });
    this.child.once("exit", (code, signal) => {
      const error = new Error(`JSONL process exited before response (code=${code}, signal=${signal})`);
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(error);
      }
      this.pending.clear();
    });
    return this;
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#retain(this.notifications, { method: "diagnostic/malformed", params: { line: sanitizeTerminalText(line) } });
      return;
    }

    if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (message.method && Object.hasOwn(message, "id")) {
      this.#retain(this.serverRequests, message);
    } else if (message.method) {
      this.#retain(this.notifications, message);
    }
    this.events.emit("message", message);
  }

  #retain(collection, message) {
    collection.push(message);
    if (collection.length > 10_000) collection.splice(0, collection.length - 10_000);
  }

  request(method, params = {}, timeoutMs = 5_000) {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  respond(id, result) {
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  waitForMessage(predicate, timeoutMs = 30_000, signal) {
    const existing = [...this.serverRequests, ...this.notifications].find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const onMessage = (message) => {
        if (!predicate(message)) return;
        cleanup();
        resolve(message);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for JSONL message"));
      }, timeoutMs);
      const onAbort = () => {
        cleanup();
        reject(new Error("JSONL message wait aborted"));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.events.off("message", onMessage);
        signal?.removeEventListener("abort", onAbort);
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.events.on("message", onMessage);
    });
  }

  async close() {
    this.lines?.close();
    if (!this.child) return { terminated: true, escalated: false, pid: null };
    if (process.platform === "win32") {
      this.child.kill("SIGTERM");
      return { terminated: true, escalated: false, pid: this.child.pid };
    }
    return terminateProcessGroup(this.child);
  }
}
