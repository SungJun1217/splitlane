import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { GitSnapshot } from "../domain.ts";
import { runCommand } from "../process/child.ts";

const EMPTY: GitSnapshot = {
  root: "",
  branch: "unknown",
  dirty: false,
  files: [],
  diffStat: "",
  diff: "",
  error: null,
  baselineFingerprint: null,
  evidence: [],
};

interface Baseline {
  fingerprint: string;
  head: string;
  preExisting: ReadonlySet<string>;
  hashes: ReadonlyMap<string, string>;
}

async function git(root: string, args: readonly string[], maxOutput = 200_000) {
  return runCommand(
    "git",
    ["-c", "core.pager=cat", "-c", "pager.diff=false", "-c", "core.quotePath=false", "--no-pager", ...args],
    {
      cwd: root,
      timeoutMs: 5_000,
      maxOutput,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    },
  );
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function contentHash(root: string, path: string): Promise<string | null> {
  const absolute = resolve(root, path);
  const fromRoot = relative(root, absolute);
  if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    return null;
  }
  try {
    const metadata = await lstat(absolute);
    const hash = createHash("sha256");
    if (metadata.isSymbolicLink()) {
      hash.update("symlink\0");
      hash.update(await readlink(absolute));
      return hash.digest("hex");
    }
    if (!metadata.isFile()) return null;
    for await (const chunk of createReadStream(absolute)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

export function parseStatus(output: string): { branch: string; files: string[] } {
  const fields = output.split("\n").filter(Boolean);
  let branch = "unknown";
  const files: string[] = [];
  for (const field of fields) {
    if (field.startsWith("## ")) {
      branch = field.slice(3).replace(/^No commits yet on /, "").split("...")[0] ?? "unknown";
      continue;
    }
    if (field.length >= 4) files.push(field.slice(3));
  }
  return { branch, files };
}

export class GitObserver {
  #snapshot: GitSnapshot = EMPTY;
  #baseline: Baseline | null = null;
  readonly #writerHints = new Set<string>();
  readonly #canonicalProjectRoot: string;

  constructor(readonly projectRoot: string) {
    try {
      this.#canonicalProjectRoot = realpathSync(projectRoot);
    } catch {
      this.#canonicalProjectRoot = resolve(projectRoot);
    }
  }

  get snapshot(): GitSnapshot {
    return this.#snapshot;
  }

  get baselineHead(): string | null {
    return this.#baseline?.head ?? null;
  }

  async captureBaseline(): Promise<string> {
    const snapshot = await this.refresh();
    if (snapshot.error) throw new Error(snapshot.error);
    const [head, index, fileList] = await Promise.all([
      git(snapshot.root, ["rev-parse", "--verify", "HEAD"]),
      git(snapshot.root, ["ls-files", "--stage"]),
      git(snapshot.root, ["ls-files", "--cached", "--others", "--exclude-standard"]),
    ]);
    const paths = [...new Set(fileList.stdout.split("\n").filter(Boolean))].sort();
    const hashes = new Map<string, string>();
    for (const path of paths) {
      const hash = await contentHash(snapshot.root, path);
      if (hash) hashes.set(path, hash);
    }
    const preExisting = new Set(snapshot.files);
    const value = {
      head: head.exitCode === 0 ? head.stdout.trim() : "unborn",
      index: index.stdout,
      status: [...preExisting].sort(),
      hashes: [...hashes.entries()],
    };
    this.#baseline = { fingerprint: fingerprint(value), head: value.head, preExisting, hashes };
    this.#writerHints.clear();
    await this.refresh();
    return this.#baseline.fingerprint;
  }

  noteWriterChange(path: string | null): void {
    if (!path) return;
    const root = this.#snapshot.root || this.projectRoot;
    const requestedRoot = resolve(this.projectRoot);
    const requestedPath = resolve(path);
    const fromRequestedRoot = relative(requestedRoot, requestedPath);
    const withinRequestedRoot = !isAbsolute(fromRequestedRoot) &&
      fromRequestedRoot !== ".." &&
      !fromRequestedRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
    const absolute = isAbsolute(path)
      ? withinRequestedRoot ? resolve(this.#canonicalProjectRoot, fromRequestedRoot) : requestedPath
      : resolve(this.#canonicalProjectRoot, path);
    const fromRoot = relative(root, absolute);
    if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) return;
    this.#writerHints.add(fromRoot);
  }

  clearBaseline(): void {
    this.#baseline = null;
    this.#writerHints.clear();
    this.#snapshot = { ...this.#snapshot, baselineFingerprint: null, evidence: [] };
  }

  async refresh(): Promise<GitSnapshot> {
    const rootResult = await git(this.projectRoot, ["rev-parse", "--show-toplevel"]);
    if (rootResult.exitCode !== 0) {
      this.#snapshot = { ...EMPTY, root: this.projectRoot, error: "Not a Git repository" };
      return this.#snapshot;
    }
    const root = rootResult.stdout.trim();
    const [status, unstaged, staged, stat, stagedStat] = await Promise.all([
      git(root, ["status", "--porcelain=v1", "--branch", "--untracked-files=all"]),
      git(root, ["diff", "--no-ext-diff", "--no-textconv", "--", "."]),
      git(root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--", "."]),
      git(root, ["diff", "--no-ext-diff", "--no-textconv", "--stat", "--", "."]),
      git(root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--stat", "--", "."]),
    ]);
    const parsed = parseStatus(status.stdout);
    const evidence = await Promise.all(parsed.files.map(async (path) => {
      if (!this.#baseline) return { path, classification: "unknown/external" as const };
      if (this.#writerHints.has(path)) return { path, classification: "writer-hinted" as const };
      if (this.#baseline.preExisting.has(path)) {
        const current = await contentHash(root, path);
        if (current === this.#baseline.hashes.get(path)) return { path, classification: "pre-existing" as const };
      }
      return { path, classification: "unknown/external" as const };
    }));
    this.#snapshot = {
      root,
      branch: parsed.branch,
      dirty: parsed.files.length > 0,
      files: parsed.files,
      diffStat: [stat.stdout.trim(), stagedStat.stdout.trim()].filter(Boolean).join("\n"),
      diff: [unstaged.stdout.trim(), staged.stdout.trim()].filter(Boolean).join("\n\n"),
      error: status.exitCode === 0 ? null : status.stderr || "Git status failed",
      baselineFingerprint: this.#baseline?.fingerprint ?? null,
      evidence,
    };
    return this.#snapshot;
  }
}
