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
};

async function git(root: string, args: readonly string[], maxOutput = 200_000) {
  return runCommand(
    "git",
    ["-c", "core.pager=cat", "-c", "pager.diff=false", "--no-pager", ...args],
    { cwd: root, timeoutMs: 5_000, maxOutput },
  );
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

  constructor(readonly projectRoot: string) {}

  get snapshot(): GitSnapshot {
    return this.#snapshot;
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
    this.#snapshot = {
      root,
      branch: parsed.branch,
      dirty: parsed.files.length > 0,
      files: parsed.files,
      diffStat: [stat.stdout.trim(), stagedStat.stdout.trim()].filter(Boolean).join("\n"),
      diff: [unstaged.stdout.trim(), staged.stdout.trim()].filter(Boolean).join("\n\n"),
      error: status.exitCode === 0 ? null : status.stderr || "Git status failed",
    };
    return this.#snapshot;
  }
}
