import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { access, readFile } from "node:fs/promises";
import type { ModelSource, ProviderId, RoleId, RoleProfile, UpdateMode } from "../domain.ts";

export type RestoreSessions = "ask" | "always" | "never";
export type ShowTools = "collapsed" | "expanded";

export interface EffectiveConfig {
  version: 1;
  providers: Record<ProviderId, { model: string; source: ModelSource }>;
  ui: { inspector: boolean; showTools: ShowTools; restoreSessions: RestoreSessions };
  queue: { limit: number };
  roles: RoleProfile;
  capabilities: { allowPreview: boolean };
  updates: { mode: UpdateMode };
  paths: { user: string; project: string };
  loaded: { user: boolean; project: boolean };
  stateDirectory: string;
}

interface ConfigFile {
  version: 1;
  providers?: Partial<Record<ProviderId, { model: string }>>;
  ui?: { inspector?: boolean; show_tools?: ShowTools; restore_sessions?: RestoreSessions };
  queue?: { limit?: number };
  roles?: Partial<RoleProfile>;
  capabilities?: { allow_preview?: boolean };
  updates?: { mode?: UpdateMode };
}

const PROVIDERS = ["claude", "codex"] as const;
const ROLES: readonly RoleId[] = ["scout", "architect", "builder", "debugger", "intent_reviewer", "correctness_reviewer"];
const DEFAULT_ROLES: RoleProfile = {
  scout: "claude",
  architect: "claude",
  builder: "codex",
  debugger: "codex",
  intent_reviewer: "claude",
  correctness_reviewer: "claude",
};

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${path}.${unknown} is unknown.`);
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${path} must be true or false.`);
  return value;
}

export function parseConfig(value: unknown, path = "config"): ConfigFile {
  const root = record(value, path);
  rejectUnknown(root, ["version", "providers", "ui", "queue", "roles", "capabilities", "updates"], path);
  if (root.version !== 1) throw new Error(`${path}.version must be 1.`);
  const result: ConfigFile = { version: 1 };

  if (root.providers !== undefined) {
    const providers = record(root.providers, `${path}.providers`);
    rejectUnknown(providers, PROVIDERS, `${path}.providers`);
    result.providers = {};
    for (const provider of PROVIDERS) {
      if (providers[provider] === undefined) continue;
      const entry = record(providers[provider], `${path}.providers.${provider}`);
      rejectUnknown(entry, ["model"], `${path}.providers.${provider}`);
      if (typeof entry.model !== "string" || !entry.model.trim() || entry.model.length > 256) {
        throw new Error(`${path}.providers.${provider}.model must be a non-empty string up to 256 characters.`);
      }
      if (/[\r\n\0]/.test(entry.model)) throw new Error(`${path}.providers.${provider}.model contains an unsafe control character.`);
      result.providers[provider] = { model: entry.model.trim() };
    }
  }

  if (root.ui !== undefined) {
    const ui = record(root.ui, `${path}.ui`);
    rejectUnknown(ui, ["inspector", "show_tools", "restore_sessions"], `${path}.ui`);
    const inspector = optionalBoolean(ui.inspector, `${path}.ui.inspector`);
    if (ui.show_tools !== undefined && ui.show_tools !== "collapsed" && ui.show_tools !== "expanded") {
      throw new Error(`${path}.ui.show_tools must be collapsed or expanded.`);
    }
    if (ui.restore_sessions !== undefined && !["ask", "always", "never"].includes(String(ui.restore_sessions))) {
      throw new Error(`${path}.ui.restore_sessions must be ask, always, or never.`);
    }
    result.ui = {
      ...(inspector === undefined ? {} : { inspector }),
      ...(ui.show_tools === undefined ? {} : { show_tools: ui.show_tools as ShowTools }),
      ...(ui.restore_sessions === undefined ? {} : { restore_sessions: ui.restore_sessions as RestoreSessions }),
    };
  }

  if (root.queue !== undefined) {
    const queue = record(root.queue, `${path}.queue`);
    rejectUnknown(queue, ["limit"], `${path}.queue`);
    if (queue.limit !== undefined && (!Number.isInteger(queue.limit) || Number(queue.limit) < 1 || Number(queue.limit) > 10)) {
      throw new Error(`${path}.queue.limit must be an integer from 1 to 10.`);
    }
    result.queue = queue.limit === undefined ? {} : { limit: Number(queue.limit) };
  }

  if (root.roles !== undefined) {
    const roles = record(root.roles, `${path}.roles`);
    rejectUnknown(roles, ROLES, `${path}.roles`);
    result.roles = {};
    for (const role of ROLES) {
      if (roles[role] === undefined) continue;
      if (!PROVIDERS.includes(roles[role] as ProviderId)) throw new Error(`${path}.roles.${role} must be claude or codex.`);
      result.roles[role] = roles[role] as ProviderId;
    }
  }

  if (root.capabilities !== undefined) {
    const capabilities = record(root.capabilities, `${path}.capabilities`);
    rejectUnknown(capabilities, ["allow_preview"], `${path}.capabilities`);
    const allowPreview = optionalBoolean(capabilities.allow_preview, `${path}.capabilities.allow_preview`);
    result.capabilities = allowPreview === undefined ? {} : { allow_preview: allowPreview };
  }
  if (root.updates !== undefined) {
    const updates = record(root.updates, `${path}.updates`);
    rejectUnknown(updates, ["mode"], `${path}.updates`);
    if (updates.mode !== undefined && !["auto", "notify", "off"].includes(String(updates.mode))) {
      throw new Error(`${path}.updates.mode must be auto, notify, or off.`);
    }
    result.updates = updates.mode === undefined ? {} : { mode: updates.mode as UpdateMode };
  }
  return result;
}

async function readConfig(path: string): Promise<ConfigFile | null> {
  try {
    return parseConfig(JSON.parse(await readFile(path, "utf8")), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error(`${path} contains invalid JSON: ${error.message}`);
    throw error;
  }
}

export function configPaths(projectRoot: string, options: { platform?: NodeJS.Platform; home?: string; env?: NodeJS.ProcessEnv } = {}): { user: string; project: string } {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const user = platform === "darwin"
    ? join(home, "Library", "Application Support", "Splitlane", "config.json")
    : join(env.XDG_CONFIG_HOME || join(home, ".config"), "splitlane", "config.json");
  return { user, project: join(resolve(projectRoot), ".splitlane", "config.json") };
}

export function stateDirectory(options: { platform?: NodeJS.Platform; home?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  return platform === "darwin"
    ? join(home, "Library", "Application Support", "Splitlane", "state")
    : join(env.XDG_STATE_HOME || join(home, ".local", "state"), "splitlane");
}

export async function discoverProjectRoot(start: string): Promise<string> {
  let current = resolve(start);
  while (true) {
    try {
      await access(join(current, ".git"));
      return current;
    } catch {}
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

export async function loadConfig(projectRoot: string, options: { platform?: NodeJS.Platform; home?: string; env?: NodeJS.ProcessEnv } = {}): Promise<EffectiveConfig> {
  const paths = configPaths(projectRoot, options);
  const env = options.env ?? process.env;
  const [user, project] = await Promise.all([readConfig(paths.user), readConfig(paths.project)]);
  if (project?.updates !== undefined) throw new Error(`${paths.project}.updates is user-only and cannot be controlled by a project.`);
  const model = (provider: ProviderId): { model: string; source: ModelSource } => project?.providers?.[provider]
    ? { model: project.providers[provider]!.model, source: "project" }
    : user?.providers?.[provider]
      ? { model: user.providers[provider]!.model, source: "user" }
      : { model: "default", source: "provider_default" };
  return {
    version: 1,
    providers: { claude: model("claude"), codex: model("codex") },
    ui: {
      inspector: project?.ui?.inspector ?? user?.ui?.inspector ?? true,
      showTools: project?.ui?.show_tools ?? user?.ui?.show_tools ?? "collapsed",
      restoreSessions: project?.ui?.restore_sessions ?? user?.ui?.restore_sessions ?? "ask",
    },
    queue: { limit: project?.queue?.limit ?? user?.queue?.limit ?? 10 },
    roles: { ...DEFAULT_ROLES, ...user?.roles, ...project?.roles },
    capabilities: { allowPreview: project?.capabilities?.allow_preview ?? user?.capabilities?.allow_preview ?? true },
    updates: { mode: env.SPLITLANE_DISABLE_AUTOUPDATE === "1" ? "off" : user?.updates?.mode ?? "auto" },
    paths,
    loaded: { user: user !== null, project: project !== null },
    stateDirectory: stateDirectory(options),
  };
}
