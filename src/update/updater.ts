import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sanitizeTerminalText } from "../terminal/sanitize.ts";
import type { UpdateMode } from "../domain.ts";

export type { UpdateMode } from "../domain.ts";
export type UpdateOutcome = "disabled" | "unsupported" | "up_to_date" | "available" | "updated" | "failed";

export interface UpdateResult {
  outcome: UpdateOutcome;
  currentVersion: string;
  latestVersion: string | null;
  checked: boolean;
  message: string;
}

interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
}

interface LatestRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: ReleaseAsset[];
}

interface UpdateState {
  schemaVersion: "update-state/v1";
  checkedAt: string;
  latestVersion: string;
}

export interface UpdaterOptions {
  currentVersion: string;
  executablePath: string;
  stateDirectory: string;
  mode: UpdateMode;
  platform?: NodeJS.Platform;
  arch?: string;
  repository?: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
  checkIntervalMs?: number;
}

const DEFAULT_REPOSITORY = "SungJun1217/splitlane";
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const MAX_RELEASE_BYTES = 256 * 1_024;
const MAX_CHECKSUM_BYTES = 64 * 1_024;
const MAX_BINARY_BYTES = 180 * 1_024 * 1_024;
const VERSION_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MANAGED_MARKER = ".splitlane-managed";

function cleanError(error: unknown): string {
  return sanitizeTerminalText(error instanceof Error ? error.message : String(error)).slice(0, 512);
}

function versionParts(value: string): [number, number, number] | null {
  const match = VERSION_PATTERN.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) throw new Error(`Invalid stable SemVer comparison: ${left} / ${right}`);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! < b[index]! ? -1 : 1;
  }
  return 0;
}

function platformAsset(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "darwin" && arch === "arm64") return "splitlane-darwin-arm64";
  if (platform === "linux" && (arch === "x64" || arch === "x86_64" || arch === "amd64")) return "splitlane-linux-x64";
  return null;
}

async function readTextBounded(response: Response, maximum: number, label: string): Promise<string> {
  if (!response.ok) throw new Error(`${label} download failed with HTTP ${response.status}.`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximum) throw new Error(`${label} exceeds the ${maximum}-byte limit.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximum) throw new Error(`${label} exceeds the ${maximum}-byte limit.`);
  return new TextDecoder().decode(bytes);
}

function parseLatestRelease(value: unknown): LatestRelease {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Latest release response is not an object.");
  const release = value as Record<string, unknown>;
  if (typeof release.tag_name !== "string" || !VERSION_PATTERN.test(release.tag_name)) throw new Error("Latest release tag is not stable SemVer.");
  if (release.draft !== false || release.prerelease !== false) throw new Error("Latest release is not a published stable release.");
  if (!Array.isArray(release.assets)) throw new Error("Latest release assets are missing.");
  const assets = release.assets.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Latest release contains a malformed asset.");
    const asset = entry as Record<string, unknown>;
    if (typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") throw new Error("Latest release contains a malformed asset.");
    if (asset.size !== undefined && (!Number.isInteger(asset.size) || Number(asset.size) < 0)) throw new Error("Latest release contains an invalid asset size.");
    return { name: asset.name, browser_download_url: asset.browser_download_url, ...(typeof asset.size === "number" ? { size: asset.size } : {}) };
  });
  return { tag_name: release.tag_name, draft: false, prerelease: false, assets };
}

function expectedAssetUrl(repository: string, tag: string, name: string): string {
  return `https://github.com/${repository}/releases/download/${tag}/${name}`;
}

async function validateDownloadedExecutable(path: string, expectedVersion: string): Promise<void> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(path, ["--version"], { timeout: 5_000, maxBuffer: 16_384 }, (error, stdout) => {
      if (error) reject(new Error(`Downloaded executable validation failed: ${error.message}`));
      else resolve(stdout);
    });
  });
  if (output.trim() !== expectedVersion) throw new Error(`Downloaded executable reported ${output.trim() || "no version"}, expected ${expectedVersion}.`);
}

export class StandaloneUpdater {
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #repository: string;
  readonly #intervalMs: number;
  #controller: AbortController | null = null;
  #running: Promise<UpdateResult> | null = null;

  constructor(readonly options: UpdaterOptions) {
    this.#fetch = options.fetchFn ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#repository = options.repository ?? DEFAULT_REPOSITORY;
    this.#intervalMs = options.checkIntervalMs ?? DEFAULT_INTERVAL_MS;
  }

  get statePath(): string {
    const executableKey = createHash("sha256").update(this.options.executablePath).digest("hex").slice(0, 16);
    return join(this.options.stateDirectory, `update-state-${executableKey}.json`);
  }

  start(force = false): Promise<UpdateResult> {
    if (this.#running) return this.#running;
    this.#controller = new AbortController();
    this.#running = this.#check(force, this.#controller.signal).finally(() => {
      this.#controller = null;
      this.#running = null;
    });
    return this.#running;
  }

  async close(): Promise<void> {
    this.#controller?.abort();
    await this.#running?.catch(() => undefined);
  }

  async #standaloneAsset(): Promise<string | null> {
    if (basename(this.options.executablePath) !== "splitlane") return null;
    const asset = platformAsset(this.options.platform ?? process.platform, this.options.arch ?? process.arch);
    if (!asset) return null;
    try {
      const stat = await lstat(this.options.executablePath);
      if (!stat.isFile() || stat.isSymbolicLink()) return null;
      const marker = await readFile(join(dirname(this.options.executablePath), MANAGED_MARKER), "utf8");
      return marker === `splitlane-managed/v1\n${this.#repository}\n` ? asset : null;
    } catch {
      return null;
    }
  }

  async #recentlyChecked(): Promise<boolean> {
    try {
      const value = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<UpdateState>;
      if (value.schemaVersion !== "update-state/v1" || typeof value.checkedAt !== "string") return false;
      const checkedAt = Date.parse(value.checkedAt);
      return Number.isFinite(checkedAt) && this.#now().getTime() - checkedAt >= 0 && this.#now().getTime() - checkedAt < this.#intervalMs;
    } catch {
      return false;
    }
  }

  async #writeState(latestVersion: string): Promise<void> {
    await mkdir(this.options.stateDirectory, { recursive: true, mode: 0o700 });
    const temporary = join(this.options.stateDirectory, `.update-state.${randomUUID()}.tmp`);
    const state: UpdateState = {
      schemaVersion: "update-state/v1",
      checkedAt: this.#now().toISOString(),
      latestVersion,
    };
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await rename(temporary, this.statePath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async #fetchRelease(signal: AbortSignal): Promise<LatestRelease> {
    const response = await this.#fetch(`https://api.github.com/repos/${this.#repository}/releases/latest`, {
      signal,
      headers: { Accept: "application/vnd.github+json", "User-Agent": `splitlane/${this.options.currentVersion}` },
    });
    const text = await readTextBounded(response, MAX_RELEASE_BYTES, "Release metadata");
    try {
      return parseLatestRelease(JSON.parse(text));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("Latest release response is invalid JSON.");
      throw error;
    }
  }

  async #downloadBinary(url: string, destination: string, signal: AbortSignal): Promise<string> {
    const response = await this.#fetch(url, { signal, headers: { "User-Agent": `splitlane/${this.options.currentVersion}` } });
    if (!response.ok || !response.body) throw new Error(`Release binary download failed with HTTP ${response.status}.`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BINARY_BYTES) throw new Error(`Release binary exceeds the ${MAX_BINARY_BYTES}-byte limit.`);
    const hash = createHash("sha256");
    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.byteLength;
        if (received > MAX_BINARY_BYTES) {
          callback(new Error(`Release binary exceeds the ${MAX_BINARY_BYTES}-byte limit.`));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
    return hash.digest("hex");
  }

  async #install(release: LatestRelease, assetName: string, signal: AbortSignal): Promise<void> {
    const tag = release.tag_name;
    const version = tag.slice(1);
    const asset = release.assets.find((entry) => entry.name === assetName);
    const sums = release.assets.find((entry) => entry.name === "SHA256SUMS");
    if (!asset || !sums) throw new Error(`Release ${tag} does not contain ${assetName} and SHA256SUMS.`);
    if (asset.size !== undefined && asset.size > MAX_BINARY_BYTES) throw new Error(`Release binary exceeds the ${MAX_BINARY_BYTES}-byte limit.`);
    const assetUrl = expectedAssetUrl(this.#repository, tag, assetName);
    const sumsUrl = expectedAssetUrl(this.#repository, tag, "SHA256SUMS");
    if (asset.browser_download_url !== assetUrl || sums.browser_download_url !== sumsUrl) throw new Error("Release asset URL does not match the trusted repository/tag path.");
    const sumsText = await readTextBounded(await this.#fetch(sumsUrl, { signal, headers: { "User-Agent": `splitlane/${this.options.currentVersion}` } }), MAX_CHECKSUM_BYTES, "SHA256SUMS");
    const checksumLine = sumsText.split(/\r?\n/).map((line) => line.trim()).find((line) => line.endsWith(` ${assetName}`) || line.endsWith(` *${assetName}`));
    const expectedChecksum = checksumLine?.split(/\s+/)[0]?.toLowerCase();
    if (!expectedChecksum || !/^[0-9a-f]{64}$/.test(expectedChecksum)) throw new Error(`SHA256SUMS does not contain a valid checksum for ${assetName}.`);
    const temporary = join(dirname(this.options.executablePath), `.splitlane-update-${randomUUID()}.tmp`);
    try {
      const actualChecksum = await this.#downloadBinary(assetUrl, temporary, signal);
      if (actualChecksum !== expectedChecksum) throw new Error("Downloaded release binary failed SHA-256 verification.");
      await chmod(temporary, 0o755);
      await validateDownloadedExecutable(temporary, version);
      if (signal.aborted) throw new Error("Update cancelled before installation.");
      await rename(temporary, this.options.executablePath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async #check(force: boolean, signal: AbortSignal): Promise<UpdateResult> {
    const currentVersion = this.options.currentVersion;
    if (!force && this.options.mode === "off") {
      return { outcome: "disabled", currentVersion, latestVersion: null, checked: false, message: "Automatic updates are disabled." };
    }
    const assetName = await this.#standaloneAsset();
    if (!assetName) {
      return { outcome: "unsupported", currentVersion, latestVersion: null, checked: false, message: "This is not a supported standalone Splitlane installation; use the original package or install.sh to update." };
    }
    if (!force && await this.#recentlyChecked()) {
      return { outcome: "up_to_date", currentVersion, latestVersion: null, checked: false, message: "Automatic update check is not due yet." };
    }
    try {
      const release = await this.#fetchRelease(signal);
      const latestVersion = release.tag_name.slice(1);
      await this.#writeState(latestVersion).catch(() => undefined);
      if (compareVersions(currentVersion, latestVersion) >= 0) {
        return { outcome: "up_to_date", currentVersion, latestVersion, checked: true, message: `Splitlane ${currentVersion} is current.` };
      }
      if (!force && this.options.mode === "notify") {
        return { outcome: "available", currentVersion, latestVersion, checked: true, message: `Splitlane ${latestVersion} is available; run splitlane update.` };
      }
      await this.#install(release, assetName, signal);
      return { outcome: "updated", currentVersion, latestVersion, checked: true, message: `Splitlane ${latestVersion} installed; restart Splitlane to use it.` };
    } catch (error) {
      return { outcome: "failed", currentVersion, latestVersion: null, checked: true, message: `Update failed; Splitlane ${currentVersion} was preserved: ${cleanError(error)}` };
    }
  }
}
