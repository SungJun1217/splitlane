import { chmod, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import type { AppSnapshot } from "../domain.ts";
import { encodeFrame, MIRROR_PROTOCOL, mirrorEndpoint, type MirrorFrame } from "./protocol.ts";

/** Everything the publisher needs from the orchestrator. Keeping it this narrow
 * is what lets the mirror stay a view: there is no method here that changes
 * state. */
export interface MirrorSource {
  getSnapshot(): AppSnapshot;
  subscribe(listener: () => void): () => void;
}

export interface MirrorPublisherOptions {
  source: MirrorSource;
  projectRoot: string;
  stateDirectory: string;
  version: string;
  /** Reported instead of thrown: a mirror that cannot listen must never take the
   * session down with it. */
  onError?: (message: string) => void;
}

/** Publishes snapshots of a live session to local readers over a Unix socket
 * (named pipe on Windows). One direction only — see `docs/GUI_TRANSITION_DECISIONS.md`. */
export class MirrorPublisher {
  readonly endpoint: string;
  readonly #options: MirrorPublisherOptions;
  #server: Server | null = null;
  #unsubscribe: (() => void) | null = null;
  readonly #readers = new Set<Socket>();
  /** Only the newest snapshot matters, so a reader that cannot keep up drops the
   * frames in between instead of growing an unbounded backlog. */
  readonly #pending = new Map<Socket, AppSnapshot>();
  readonly #draining = new Set<Socket>();

  private constructor(options: MirrorPublisherOptions, endpoint: string) {
    this.#options = options;
    this.endpoint = endpoint;
  }

  /** How many readers are attached right now. The session surfaces this so a user
   * can tell whether anything is watching the snapshot it publishes. */
  get readerCount(): number {
    return this.#readers.size;
  }

  static async start(options: MirrorPublisherOptions): Promise<MirrorPublisher> {
    const endpoint = mirrorEndpoint(options.stateDirectory, options.projectRoot);
    const publisher = new MirrorPublisher(options, endpoint);
    await publisher.#listen();
    return publisher;
  }

  async #listen(): Promise<void> {
    if (process.platform !== "win32") {
      await mkdir(dirname(this.endpoint), { recursive: true, mode: 0o700 });
      // A socket left behind by a killed session would refuse the bind. Removing
      // it is safe: an owner still listening keeps its accepted connections, and
      // the next reader connects to whoever is listening now.
      await unlink(this.endpoint).catch(() => undefined);
    }
    const server = createServer((socket) => this.#accept(socket));
    server.on("error", (error) => this.#options.onError?.(`Mirror publisher failed: ${error.message}`));
    await new Promise<void>((resolve) => server.listen(this.endpoint, () => resolve()));
    if (process.platform !== "win32") await chmod(this.endpoint, 0o600).catch(() => undefined);
    this.#server = server;
    this.#unsubscribe = this.#options.source.subscribe(() => this.#broadcast(this.#options.source.getSnapshot()));
  }

  #accept(socket: Socket): void {
    socket.setNoDelay(true);
    this.#readers.add(socket);
    const drop = () => {
      this.#readers.delete(socket);
      this.#pending.delete(socket);
      this.#draining.delete(socket);
    };
    socket.on("close", drop);
    socket.on("error", drop);
    // The protocol has no reader-to-publisher frame. Anything arriving here is
    // either a confused client or an attempt to drive the session through a
    // channel that must not carry authority, so the connection ends.
    socket.on("data", () => {
      socket.destroy();
      drop();
    });
    const hello: MirrorFrame = {
      type: "hello",
      protocol: MIRROR_PROTOCOL,
      version: this.#options.version,
      projectRoot: this.#options.projectRoot,
      readOnly: true,
    };
    socket.write(encodeFrame(hello));
    this.#send(socket, this.#options.source.getSnapshot());
  }

  #broadcast(snapshot: AppSnapshot): void {
    for (const socket of this.#readers) this.#send(socket, snapshot);
  }

  #send(socket: Socket, snapshot: AppSnapshot): void {
    if (this.#draining.has(socket)) {
      this.#pending.set(socket, snapshot);
      return;
    }
    const flushed = socket.write(encodeFrame({ type: "snapshot", snapshot }));
    if (flushed) return;
    this.#draining.add(socket);
    socket.once("drain", () => {
      this.#draining.delete(socket);
      const queued = this.#pending.get(socket);
      this.#pending.delete(socket);
      if (queued && !socket.destroyed) this.#send(socket, queued);
    });
  }

  async close(): Promise<void> {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const socket of this.#readers) socket.destroy();
    this.#readers.clear();
    this.#pending.clear();
    this.#draining.clear();
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    // Leaving the endpoint behind makes the next reader hang on a dead socket
    // instead of reporting that no session is running.
    if (process.platform !== "win32") await unlink(this.endpoint).catch(() => undefined);
  }
}
