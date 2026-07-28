import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { IsolatedLaneWorkspace, IsolatedRunSnapshot, ProviderId } from "../domain.ts";
import { projectIdentity } from "../session/store.ts";
import { runCommand } from "../process/child.ts";
import { sanitizeTerminalText } from "../terminal/sanitize.ts";

async function git(root: string, args: readonly string[], maxOutput = 200_000) {
  return runCommand("git", ["-c", "core.pager=cat", "-c", "pager.diff=false", "-c", "core.quotePath=false", "--no-pager", ...args], {
    cwd: root,
    timeoutMs: 10_000,
    maxOutput,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

function lane(provider: ProviderId, path: string, branch: string, baseCommit: string): IsolatedLaneWorkspace {
  return { provider, path, branch, baseCommit, processState: "idle", dirty: false, head: baseCommit, present: false, error: null };
}

export class WorktreeManager {
  readonly root: string;
  readonly projectRoot: string;
  readonly #recoveryWarnings: string[] = [];

  constructor(readonly stateRoot: string, projectRoot: string) {
    this.projectRoot = realpathSync.native(projectRoot);
    this.root = join(stateRoot, "worktrees", projectIdentity(this.projectRoot));
  }

  get recoveryWarnings(): readonly string[] {
    return [...this.#recoveryWarnings];
  }

  #validate(run: IsolatedRunSnapshot): void {
    const runRoot = join(this.root, run.runId);
    if (
      run.schemaVersion !== "isolated-run/v1" ||
      !["preview", "creating", "active", "retained", "cleaned", "failed"].includes(run.lifecycle) ||
      !/^[0-9]{14}-[a-f0-9]{8}$/.test(run.runId) ||
      resolve(run.primaryRoot) !== resolve(this.projectRoot)
    ) throw new Error("Invalid isolated run identity.");
    if (resolve(run.manifestPath) !== resolve(join(runRoot, "manifest.json"))) throw new Error("Invalid isolated manifest path.");
    for (const provider of ["claude", "codex"] as const) {
      const workspace = run.lanes[provider];
      if (!workspace || workspace.provider !== provider || !["idle", "running"].includes(workspace.processState) || resolve(workspace.path) !== resolve(join(runRoot, provider))) throw new Error(`Invalid ${provider} worktree path.`);
      if (workspace.branch !== `splitlane/${run.runId}/${provider}` || workspace.baseCommit !== run.baseCommit) throw new Error(`Invalid ${provider} isolated branch metadata.`);
    }
  }

  async plan(): Promise<IsolatedRunSnapshot> {
    const [top, status, head] = await Promise.all([
      git(this.projectRoot, ["rev-parse", "--show-toplevel"]),
      git(this.projectRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
      git(this.projectRoot, ["rev-parse", "--verify", "HEAD"]),
    ]);
    if (top.exitCode !== 0 || resolve(top.stdout.trim()) !== resolve(this.projectRoot)) throw new Error("Isolated mode requires the selected Git repository root.");
    if (head.exitCode !== 0 || !head.stdout.trim()) throw new Error("Isolated mode refuses an unborn repository without a base commit.");
    if (status.exitCode !== 0) throw new Error(status.stderr || "Unable to inspect Git status for isolated mode.");
    if (status.stdout.trim()) throw new Error("Isolated mode requires a clean primary working tree; Splitlane will not stash or reset changes.");
    const baseCommit = head.stdout.trim();
    const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    const runRoot = join(this.root, runId);
    const branches = { claude: `splitlane/${runId}/claude`, codex: `splitlane/${runId}/codex` } as const;
    for (const branch of Object.values(branches)) {
      const collision = await git(this.projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      if (collision.exitCode === 0) throw new Error(`Isolated branch already exists: ${branch}`);
    }
    return {
      schemaVersion: "isolated-run/v1",
      runId,
      createdAt: new Date().toISOString(),
      primaryRoot: resolve(this.projectRoot),
      baseCommit,
      lifecycle: "preview",
      lanes: {
        claude: lane("claude", join(runRoot, "claude"), branches.claude, baseCommit),
        codex: lane("codex", join(runRoot, "codex"), branches.codex, baseCommit),
      },
      manifestPath: join(runRoot, "manifest.json"),
      error: null,
    };
  }

  async create(plan: IsolatedRunSnapshot): Promise<IsolatedRunSnapshot> {
    this.#validate(plan);
    if (plan.lifecycle !== "preview") throw new Error("Only a previewed isolated run can be created.");
    await mkdir(dirname(plan.manifestPath), { recursive: true, mode: 0o700 });
    let current: IsolatedRunSnapshot = { ...plan, lifecycle: "creating" };
    await this.writeManifest(current);
    try {
      for (const provider of ["claude", "codex"] as const) {
        const workspace = plan.lanes[provider];
        const result = await git(this.projectRoot, ["worktree", "add", "-b", workspace.branch, workspace.path, plan.baseCommit]);
        if (result.exitCode !== 0) throw new Error(`${provider} worktree creation failed: ${result.stderr || result.stdout}`);
      }
      current = { ...current, lifecycle: "active" };
      await this.writeManifest(current);
      return current;
    } catch (error) {
      current = { ...current, lifecycle: "failed", error: sanitizeTerminalText((error as Error).message) };
      await this.writeManifest(current);
      throw error;
    }
  }

  async inspect(run: IsolatedRunSnapshot): Promise<IsolatedRunSnapshot> {
    this.#validate(run);
    const entries = await Promise.all((["claude", "codex"] as const).map(async (provider) => {
      const workspace = run.lanes[provider];
      // A directory that is not there cannot be dirty or unreadable. Reporting
      // it as an inspection error is what used to make a failed run
      // permanently un-cleanable, and so permanently blocking.
      const present = await stat(workspace.path).then((entry) => entry.isDirectory(), () => false);
      if (!present) {
        return [provider, { ...workspace, dirty: false, present: false, error: null }] as const;
      }
      const [status, head] = await Promise.all([
        git(workspace.path, ["status", "--porcelain=v1", "--untracked-files=all"]),
        git(workspace.path, ["rev-parse", "--verify", "HEAD"]),
      ]);
      const next: IsolatedLaneWorkspace = {
        ...workspace,
        dirty: Boolean(status.stdout.trim()),
        head: head.exitCode === 0 ? head.stdout.trim() : workspace.head,
        present: true,
        error: status.exitCode === 0 && head.exitCode === 0 ? null : sanitizeTerminalText(status.stderr || head.stderr || "Worktree inspection failed"),
      };
      return [provider, next] as const;
    }));
    const next = { ...run, lanes: Object.fromEntries(entries) as Record<ProviderId, IsolatedLaneWorkspace> };
    await this.writeManifest(next);
    return next;
  }

  async cleanup(run: IsolatedRunSnapshot): Promise<IsolatedRunSnapshot> {
    this.#validate(run);
    const inspected = await this.inspect(run);
    const unsafe = (["claude", "codex"] as const).find((provider) => inspected.lanes[provider].dirty || inspected.lanes[provider].error);
    if (unsafe) throw new Error(`${unsafe} worktree is dirty or unreadable; retained for recovery. Splitlane never force-removes it.`);
    const active = (["claude", "codex"] as const).find((provider) => inspected.lanes[provider].processState !== "idle");
    if (active) throw new Error(`${active} isolated process was not recorded idle; retained because cleanup cannot prove the worktree is inactive.`);
    for (const provider of ["claude", "codex"] as const) {
      // Nothing to protect when the directory is already gone; the guard exists
      // to avoid removing a worktree that still holds unintegrated work.
      if (!inspected.lanes[provider].present) continue;
      const integrated = await git(this.projectRoot, ["merge-base", "--is-ancestor", inspected.lanes[provider].head, "HEAD"]);
      if (integrated.exitCode !== 0) {
        throw new Error(`${provider} worktree has commits not integrated into the primary branch; retained for recovery.`);
      }
    }
    let pruneNeeded = false;
    for (const provider of ["claude", "codex"] as const) {
      const workspace = inspected.lanes[provider];
      if (!workspace.present) {
        pruneNeeded = true;
        continue;
      }
      const result = await git(this.projectRoot, ["worktree", "remove", workspace.path]);
      if (result.exitCode !== 0) throw new Error(`${provider} clean worktree removal failed: ${result.stderr || result.stdout}`);
    }
    // Only touches Git's worktree bookkeeping for directories that no longer
    // exist. It never removes a branch or a commit.
    if (pruneNeeded) await git(this.projectRoot, ["worktree", "prune"]);
    const cleaned = { ...inspected, lifecycle: "cleaned" as const, lanes: Object.fromEntries((["claude", "codex"] as const)
      .map((provider) => [provider, { ...inspected.lanes[provider], present: false }])) as Record<ProviderId, IsolatedLaneWorkspace> };
    await this.writeManifest(cleaned);
    await this.#removeRunDirectory(cleaned);
    return cleaned;
  }

  /** Drops only Splitlane's tracking of a run. Worktree directories and branches
   * are left exactly as they are, so this is the escape hatch when cleanup
   * cannot prove a run is safe to remove and the run would otherwise block
   * isolated mode forever. */
  async discard(run: IsolatedRunSnapshot): Promise<{ remainingPaths: readonly string[]; remainingBranches: readonly string[] }> {
    this.#validate(run);
    const inspected = await this.inspect(run).catch(() => run);
    const remainingPaths = (["claude", "codex"] as const)
      .filter((provider) => inspected.lanes[provider].present)
      .map((provider) => inspected.lanes[provider].path);
    const remainingBranches: string[] = [];
    for (const provider of ["claude", "codex"] as const) {
      const branch = inspected.lanes[provider].branch;
      const exists = await git(this.projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      if (exists.exitCode === 0) remainingBranches.push(branch);
    }
    // The worktrees live *inside* the run directory, so only the manifest may be
    // removed while either of them is still on disk. Removing the directory
    // would destroy uncommitted work in the very case this exists to rescue.
    if (remainingPaths.length) await rm(run.manifestPath, { force: true });
    else await rm(dirname(run.manifestPath), { recursive: true, force: true });
    return { remainingPaths, remainingBranches };
  }

  /** The run directory only holds the manifest once both worktrees are gone.
   * Leaving it behind makes every later startup re-parse a dead run. */
  async #removeRunDirectory(run: IsolatedRunSnapshot): Promise<void> {
    for (const provider of ["claude", "codex"] as const) {
      const present = await stat(run.lanes[provider].path).then(() => true, () => false);
      if (present) return;
    }
    await rm(dirname(run.manifestPath), { recursive: true, force: true }).catch(() => undefined);
  }

  async retain(run: IsolatedRunSnapshot): Promise<IsolatedRunSnapshot> {
    this.#validate(run);
    const retained = { ...(await this.inspect(run)), lifecycle: "retained" as const };
    await this.writeManifest(retained);
    return retained;
  }

  integrationCommands(run: IsolatedRunSnapshot): Record<ProviderId, readonly string[]> {
    const commands = (provider: ProviderId): readonly string[] => [
      `git diff ${run.baseCommit}...${run.lanes[provider].branch}`,
      `git log --oneline ${run.baseCommit}..${run.lanes[provider].branch}`,
      `git merge --no-ff ${run.lanes[provider].branch}`,
      `git cherry-pick <commit-from-${provider}>`,
    ];
    return { claude: commands("claude"), codex: commands("codex") };
  }

  async recoverable(): Promise<readonly IsolatedRunSnapshot[]> {
    this.#recoveryWarnings.length = 0;
    let runIds: string[];
    try { runIds = await readdir(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const runs: IsolatedRunSnapshot[] = [];
    for (const runId of runIds) {
      try {
        const value = JSON.parse(await readFile(join(this.root, runId, "manifest.json"), "utf8")) as IsolatedRunSnapshot;
        this.#validate(value);
        if (value.lifecycle !== "cleaned") runs.push(value);
      } catch (error) {
        // A directory with no manifest is a discarded run whose worktrees the
        // user chose to keep. Splitlane no longer tracks it, so warning about it
        // on every startup would be noise the user cannot act on here.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        this.#recoveryWarnings.push(`${sanitizeTerminalText(runId)}: ${sanitizeTerminalText((error as Error).message) || "invalid isolated manifest"}`);
      }
    }
    return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async writeManifest(run: IsolatedRunSnapshot): Promise<void> {
    this.#validate(run);
    await mkdir(dirname(run.manifestPath), { recursive: true, mode: 0o700 });
    const temporary = `${run.manifestPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, run.manifestPath);
  }
}
