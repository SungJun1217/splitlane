import { createHash, randomUUID } from "node:crypto";
import { lstat, readlink } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { CapabilityStability, GitFileEvidence, ProviderId, ReviewEnvelope, ReviewMechanism } from "../domain.ts";
import { runCommand } from "../process/child.ts";
import { sanitizeTerminalText } from "../terminal/sanitize.ts";

export const REVIEW_PATCH_LIMIT = 200 * 1024;

export function reviewMechanismStability(mechanism: ReviewMechanism): CapabilityStability {
  return mechanism === "codex_native" ? "preview" : "stable";
}

export interface ReviewPatch {
  branch: string;
  head: string;
  files: readonly GitFileEvidence[];
  diff: string;
  diffBytes: number;
  diffHash: string;
}

function git(root: string, args: readonly string[], maxOutput = REVIEW_PATCH_LIMIT + 1) {
  return runCommand("git", ["-c", "core.pager=cat", "-c", "pager.diff=false", "-c", "core.quotePath=false", "--no-pager", ...args], {
    cwd: root,
    timeoutMs: 10_000,
    maxOutput,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

function appendExact(parts: string[], value: string, limit: number): void {
  const next = [...parts, value].filter(Boolean).join("\n");
  if (Buffer.byteLength(next, "utf8") > limit) {
    throw new Error(`Review patch exceeds the ${limit}-byte limit.`);
  }
  if (value) parts.push(value);
}

function safeRelative(root: string, path: string): string | null {
  const candidate = resolve(root, path);
  const fromRoot = relative(root, candidate);
  if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) return null;
  return fromRoot;
}

export async function captureReviewPatch(
  root: string,
  files: readonly GitFileEvidence[],
  options: { limit?: number; baseRevision?: string } = {},
): Promise<ReviewPatch> {
  const limit = options.limit ?? REVIEW_PATCH_LIMIT;
  const [branchResult, headResult, untrackedResult] = await Promise.all([
    git(root, ["branch", "--show-current"]),
    git(root, ["rev-parse", "--verify", "HEAD"]),
    git(root, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  if (branchResult.exitCode !== 0 || untrackedResult.exitCode !== 0) throw new Error("Unable to capture Git review metadata.");
  const currentHead = headResult.exitCode === 0 ? headResult.stdout.trim() : "unborn";
  const head = options.baseRevision ?? currentHead;
  if (untrackedResult.timedOut || untrackedResult.truncated) throw new Error(`Review patch exceeds the ${limit}-byte limit.`);
  const tracked = head === "unborn"
    ? await Promise.all([
        git(root, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "--", "."], limit + 1),
        git(root, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--", "."], limit + 1),
      ])
    : [await git(root, ["diff", head, "--binary", "--no-ext-diff", "--no-textconv", "--", "."], limit + 1)];
  if (tracked.some((result) => result.timedOut || result.truncated || result.exitCode !== 0)) {
    throw new Error(`Review patch exceeds the ${limit}-byte limit or Git diff failed.`);
  }
  const parts: string[] = [];
  for (const result of tracked) appendExact(parts, result.stdout.trim(), limit);

  const untracked = untrackedResult.stdout.split("\n").filter(Boolean).sort();
  for (const path of untracked) {
    const safe = safeRelative(root, path);
    if (!safe) throw new Error("Untracked review path escapes the project root.");
    const metadata = await lstat(resolve(root, safe));
    if (metadata.isSymbolicLink()) {
      const target = await readlink(resolve(root, safe));
      appendExact(parts, [
        `diff --git a/${safe} b/${safe}`,
        "new file mode 120000",
        "--- /dev/null",
        `+++ b/${safe}`,
        "@@ -0,0 +1 @@",
        `+<symlink:${JSON.stringify(sanitizeTerminalText(target))}>`,
      ].join("\n"), limit);
      continue;
    }
    if (!metadata.isFile()) continue;
    const patch = await git(root, ["diff", "--no-index", "--binary", "--no-ext-diff", "--no-textconv", "--", "/dev/null", safe], limit + 1);
    if (patch.timedOut || patch.truncated || ![0, 1].includes(patch.exitCode ?? -1)) {
      throw new Error(`Unable to capture untracked review file: ${safe}`);
    }
    appendExact(parts, patch.stdout.trim(), limit);
  }
  const diff = parts.join("\n");
  if (!diff.trim()) throw new Error("Review requires a non-empty diff from the writer baseline.");
  const diffBytes = Buffer.byteLength(diff, "utf8");
  const namesResult = head === "unborn"
    ? await git(root, ["ls-files", "--cached", "--others", "--exclude-standard"])
    : await git(root, ["diff", "--name-only", head, "--", "."]);
  if (namesResult.exitCode !== 0 || namesResult.timedOut || namesResult.truncated) throw new Error("Unable to capture review file names.");
  const evidence = new Map(files.map((item) => [item.path, item.classification]));
  const changedPaths = [...new Set([...namesResult.stdout.split("\n"), ...untracked].filter(Boolean))].sort();
  return {
    branch: branchResult.stdout.trim() || "detached",
    head,
    files: changedPaths.map((path) => ({ path, classification: evidence.get(path) ?? "unknown/external" })),
    diff,
    diffBytes,
    diffHash: createHash("sha256").update(diff).digest("hex"),
  };
}

export function createReviewEnvelope(input: {
  writer: ProviderId;
  reviewer: ProviderId;
  mechanism: ReviewMechanism;
  objective: string;
  acceptanceCriteria: string;
  projectRoot: string;
  baselineFingerprint: string;
  patch: ReviewPatch;
}): ReviewEnvelope {
  return Object.freeze({
    schemaVersion: "review-envelope/v1",
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    writer: input.writer,
    reviewer: input.reviewer,
    mechanism: input.mechanism,
    mechanismStability: reviewMechanismStability(input.mechanism),
    objective: sanitizeTerminalText(input.objective).trim(),
    acceptanceCriteria: sanitizeTerminalText(input.acceptanceCriteria).trim(),
    projectRoot: input.projectRoot,
    branch: input.patch.branch,
    head: input.patch.head,
    baselineFingerprint: input.baselineFingerprint,
    files: input.patch.files,
    diff: input.patch.diff,
    diffBytes: input.patch.diffBytes,
    diffHash: input.patch.diffHash,
    truncated: false,
  });
}
