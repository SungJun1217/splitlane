import { app, BrowserWindow } from "electron";
import { connect, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { discoverProjectRoot, loadConfig } from "../src/config/config.ts";
import { decodeFrames, MIRROR_PROTOCOL, mirrorEndpoint } from "../src/mirror/protocol.ts";
import { MIRROR_CHANNEL, type MirrorState } from "./bridge.ts";

const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 5_000;

/** Holds the connection to one session's mirror. A class rather than a closure
 * chain so a long-lived attachment keeps only the fields it needs. */
class MirrorAttachment {
  #socket: Socket | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #retryMs = RETRY_MIN_MS;
  #buffered = "";
  #closed = false;
  #state: MirrorState;

  constructor(
    readonly endpoint: string,
    projectRoot: string,
    private readonly onState: (state: MirrorState) => void,
  ) {
    this.#state = { status: "waiting", projectRoot, sessionVersion: null, detail: null, snapshot: null };
  }

  get state(): MirrorState {
    return this.#state;
  }

  start(): void {
    this.#connect();
  }

  #publish(patch: Partial<MirrorState>): void {
    this.#state = { ...this.#state, ...patch };
    this.onState(this.#state);
  }

  #connect(): void {
    if (this.#closed) return;
    this.#buffered = "";
    const socket = connect(this.endpoint);
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      this.#retryMs = RETRY_MIN_MS;
    });
    socket.on("data", (chunk: string) => this.#ingest(chunk));
    // A missing endpoint is the normal case before `splitlane --mirror` runs, so
    // it is a waiting state rather than an error, and it keeps retrying.
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (this.#closed) return;
      this.#publish(this.#state.status === "attached"
        ? { status: "detached", detail: "The terminal session ended. This view is a snapshot of its last state." }
        : { status: "waiting", detail: null });
      this.#scheduleRetry();
    });
  }

  #ingest(chunk: string): void {
    const decoded = decodeFrames(this.#buffered + chunk);
    this.#buffered = decoded.rest;
    for (const frame of decoded.frames) {
      if (frame.type === "hello") {
        // Endpoint names are truncated hashes, so a hello for another project is
        // possible in principle. Detach rather than render another repository's
        // changed files as if they were this one's.
        if (frame.protocol !== MIRROR_PROTOCOL || resolve(frame.projectRoot) !== resolve(this.#state.projectRoot)) {
          this.#publish({
            status: "mismatch",
            detail: `Endpoint belongs to ${frame.protocol} at ${frame.projectRoot}.`,
            snapshot: null,
          });
          this.#socket?.destroy();
          return;
        }
        this.#publish({ status: "attached", sessionVersion: frame.version, detail: null });
      } else this.#publish({ status: "attached", detail: null, snapshot: frame.snapshot });
    }
  }

  #scheduleRetry(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#connect(), this.#retryMs);
    this.#retryMs = Math.min(RETRY_MAX_MS, this.#retryMs * 2);
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#socket?.destroy();
    this.#socket = null;
  }
}

function projectArgument(argv: readonly string[]): string {
  const index = argv.indexOf("--project");
  const value = index === -1 ? undefined : argv[index + 1];
  return resolve(value ?? process.cwd());
}

async function main(): Promise<void> {
  const requested = projectArgument(process.argv.slice(1));
  await app.whenReady();
  // Resolved at runtime: this entry is bundled to CommonJS (a sandboxed preload
  // cannot be an ES module) and the bundler inlines both `__dirname` and
  // `import.meta.url` as the pre-bundle source path.
  const bundleDir = app.getAppPath();
  const window = new BrowserWindow({
    width: 1_280,
    height: 860,
    title: "Splitlane · read-only mirror",
    backgroundColor: "#11131a",
    webPreferences: {
      preload: join(bundleDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // A read-only view has nothing to navigate to. Anything trying is refused
  // rather than handed to the OS browser.
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  let attachment: MirrorAttachment | null = null;
  const send = (state: MirrorState) => {
    if (!window.isDestroyed()) window.webContents.send(MIRROR_CHANNEL, state);
  };

  await window.loadFile(join(bundleDir, "index.html"));

  try {
    const projectRoot = await discoverProjectRoot(requested);
    const config = await loadConfig(projectRoot);
    attachment = new MirrorAttachment(mirrorEndpoint(config.stateDirectory, projectRoot), projectRoot, send);
    send(attachment.state);
    attachment.start();
  } catch (error) {
    send({
      status: "error",
      projectRoot: requested,
      sessionVersion: null,
      detail: (error as Error).message,
      snapshot: null,
    });
  }

  // The window is the only view, so closing it ends the process and releases the
  // socket instead of leaving a detached reader behind.
  window.on("closed", () => {
    attachment?.close();
    app.quit();
  });
}

void main();
