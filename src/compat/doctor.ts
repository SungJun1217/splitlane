import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type CommandResult } from "../process/child.ts";
import { CodexRpcClient } from "../providers/codex-rpc.ts";
import { supportsCodexNativeReviewSchema } from "../providers/codex.ts";
import { sanitizeTerminalText } from "../terminal/sanitize.ts";

export interface DoctorCommand {
  command: string;
  argsPrefix?: readonly string[];
}

export type DoctorStatus = "pass" | "warn" | "fail";
export type AuthStatus = "authenticated" | "unauthenticated" | "unknown";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  detail: string;
}

export interface ProviderDoctorReport {
  provider: "claude" | "codex";
  available: boolean;
  version: string | null;
  auth: AuthStatus;
  checks: readonly DoctorCheck[];
}

export interface DoctorReport {
  schemaVersion: "doctor/v1";
  projectRoot: string;
  startedAt: string;
  completedAt: string;
  status: DoctorStatus;
  safety: {
    modelTurnsStarted: 0;
    threadsStarted: 0;
    bypassFlagsUsed: false;
    providerConfigModified: false;
    credentialsPersisted: false;
  };
  workspace: {
    status: DoctorStatus;
    checks: readonly DoctorCheck[];
  };
  providers: Record<"claude" | "codex", ProviderDoctorReport>;
}

export interface DoctorOptions {
  projectRoot: string;
  claude?: DoctorCommand;
  codex?: DoctorCommand;
}

const defaultCommand = (command: string): DoctorCommand => ({ command, argsPrefix: [] });

function commandArgs(spec: DoctorCommand, args: readonly string[]): string[] {
  return [...(spec.argsPrefix ?? []), ...args];
}

function execute(spec: DoctorCommand, args: readonly string[], timeoutMs = 5_000): Promise<CommandResult> {
  return runCommand(spec.command, commandArgs(spec, args), { timeoutMs, maxOutput: 256_000 });
}

function clean(result: CommandResult): string {
  return sanitizeTerminalText(result.stdout || result.stderr).trim();
}

function version(result: CommandResult): string | null {
  if (!result.available || result.exitCode !== 0 || result.timedOut) return null;
  return clean(result).split(/\r?\n/, 1)[0]?.slice(0, 256) || null;
}

export function classifyAuth(provider: "claude" | "codex", result: CommandResult): AuthStatus {
  const text = clean(result);
  if (!result.available || result.timedOut) return "unknown";
  if (provider === "claude") {
    try {
      const parsed = JSON.parse(text) as { loggedIn?: unknown };
      if (parsed.loggedIn === true) return "authenticated";
      if (parsed.loggedIn === false) return "unauthenticated";
    } catch {}
  }
  if (/\bnot logged in\b|\bunauthenticated\b|\blogged out\b/i.test(text)) return "unauthenticated";
  if (/\blogged in\b|\bauthenticated\b/i.test(text)) return "authenticated";
  return result.exitCode === 0 ? "unknown" : "unauthenticated";
}

function check(id: string, status: DoctorStatus, detail: string): DoctorCheck {
  return { id, status, detail };
}

async function doctorClaude(spec: DoctorCommand): Promise<ProviderDoctorReport> {
  const [versionResult, help, auth] = await Promise.all([
    execute(spec, ["--version"]),
    execute(spec, ["--help"]),
    execute(spec, ["auth", "status"]),
  ]);
  const detectedVersion = version(versionResult);
  if (!detectedVersion) {
    return {
      provider: "claude",
      available: false,
      version: null,
      auth: "unknown",
      checks: [check("binary", "fail", versionResult.available ? "Claude Code version probe failed." : "Claude Code binary was not found on PATH.")],
    };
  }
  const helpText = clean(help);
  const authStatus = classifyAuth("claude", auth);
  const structured = help.exitCode === 0 && helpText.includes("stream-json") && helpText.includes("--print");
  const readOnly = help.exitCode === 0 && helpText.includes("--permission-mode") && helpText.includes("plan");
  return {
    provider: "claude",
    available: true,
    version: detectedVersion,
    auth: authStatus,
    checks: [
      check("binary", "pass", "Claude Code version command succeeded."),
      check("structured_stream", structured ? "pass" : "fail", structured ? "Structured print streaming is advertised." : "Required structured print streaming flags were not found in local help."),
      check("read_only", readOnly ? "pass" : "fail", readOnly ? "Plan/read-only permission mode is advertised." : "Plan/read-only permission mode was not found in local help."),
      check("sdk_transport", "pass", "Official Claude Agent SDK is bundled; no query or model turn was started."),
      check("authentication", authStatus === "authenticated" ? "pass" : "warn", authStatus === "authenticated" ? "Claude authentication is available." : "Claude authentication is unavailable or could not be classified."),
      check("write_sandbox", "warn", "Write sandbox enforcement is configured at turn start; doctor does not spend a model turn to live-test it."),
    ],
  };
}

async function initializeCodex(spec: DoctorCommand): Promise<{ ok: boolean; detail: string }> {
  const diagnostics: string[] = [];
  const rpc = new CodexRpcClient(
    (message) => { if (message.method === "diagnostic/malformed") diagnostics.push("malformed output"); },
    () => {},
    () => {},
    spec.command,
    commandArgs(spec, ["app-server", "--stdio"]),
  );
  try {
    await rpc.start();
    await rpc.request("initialize", {
      clientInfo: { name: "splitlane-doctor", title: "Splitlane Doctor", version: "doctor/v1" },
      capabilities: { experimentalApi: false },
    }, 5_000);
    rpc.notify("initialized");
    return diagnostics.length
      ? { ok: false, detail: "Codex app-server initialized but emitted malformed output." }
      : { ok: true, detail: "Codex app-server initialize completed without starting a thread or turn." };
  } catch (error) {
    return { ok: false, detail: `Codex app-server initialize failed: ${sanitizeTerminalText((error as Error).message).slice(0, 512)}` };
  } finally {
    await rpc.close().catch(() => {});
  }
}

async function doctorCodex(spec: DoctorCommand): Promise<ProviderDoctorReport> {
  const [versionResult, help, appServerHelp, auth] = await Promise.all([
    execute(spec, ["--version"]),
    execute(spec, ["--help"]),
    execute(spec, ["app-server", "--help"]),
    execute(spec, ["login", "status"]),
  ]);
  const detectedVersion = version(versionResult);
  if (!detectedVersion) {
    return {
      provider: "codex",
      available: false,
      version: null,
      auth: "unknown",
      checks: [check("binary", "fail", versionResult.available ? "Codex version probe failed." : "Codex binary was not found on PATH.")],
    };
  }

  const directory = await mkdtemp(join(tmpdir(), "splitlane-doctor-schema-"));
  let schemaText = "";
  let schemaDetail = "Codex app-server schema generation failed.";
  try {
    const generated = await execute(spec, ["app-server", "generate-json-schema", "--out", directory], 15_000);
    if (generated.exitCode === 0 && !generated.timedOut && !generated.truncated) {
      const files = await Promise.all(["ClientRequest.json", "ServerRequest.json"].map(async (name) => {
        try { return await readFile(join(directory, name), "utf8"); } catch { return ""; }
      }));
      schemaText = files.join("\n");
      schemaDetail = schemaText ? "Codex app-server schema generated locally." : "Schema command succeeded without readable request schemas.";
    }
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }

  const helpText = clean(help);
  const appHelpText = clean(appServerHelp);
  const appServerAdvertised = help.exitCode === 0 && helpText.includes("app-server") && appServerHelp.exitCode === 0 && appHelpText.includes("generate-json-schema");
  const schemaAvailable = Boolean(schemaText);
  const transport = appServerAdvertised && schemaAvailable
    ? await initializeCodex(spec)
    : { ok: false, detail: "Codex app-server initialize skipped because help/schema checks failed." };
  const authStatus = classifyAuth("codex", auth);
  const sandbox = /sandboxPolicy|readOnly|workspaceWrite|workspace-write|read-only/.test(`${helpText}\n${schemaText}`);
  const review = supportsCodexNativeReviewSchema(schemaText);
  return {
    provider: "codex",
    available: true,
    version: detectedVersion,
    auth: authStatus,
    checks: [
      check("binary", "pass", "Codex version command succeeded."),
      check("app_server_help", appServerAdvertised ? "pass" : "fail", appServerAdvertised ? "App-server and schema generation are advertised." : "Required app-server help was not found."),
      check("schema", schemaAvailable ? "pass" : "fail", schemaDetail),
      check("transport_initialize", transport.ok ? "pass" : "fail", transport.detail),
      check("sandbox", sandbox ? "pass" : "fail", sandbox ? "Read-only/workspace sandbox fields are advertised locally." : "Required sandbox fields were not found in help or schema."),
      check("native_review", review ? "pass" : "warn", review ? "Native review/start schema is available." : "Native review/start is unavailable; generic read-only review remains available."),
      check("authentication", authStatus === "authenticated" ? "pass" : "warn", authStatus === "authenticated" ? "Codex authentication is available." : "Codex authentication is unavailable or could not be classified."),
    ],
  };
}

function overall(providers: readonly ProviderDoctorReport[]): DoctorStatus {
  if (providers.some((provider) => provider.checks.some((item) => item.status === "fail"))) return "fail";
  if (providers.some((provider) => provider.checks.some((item) => item.status === "warn"))) return "warn";
  return "pass";
}

async function doctorWorkspace(projectRoot: string): Promise<DoctorReport["workspace"]> {
  const exists = await stat(projectRoot).then((entry) => entry.isDirectory(), () => null);
  if (exists !== true) {
    return {
      status: "fail",
      checks: [check("git_root", "fail", exists === null
        ? "Selected project path does not exist."
        : "Selected project path is not a directory.")],
    };
  }
  const top = await runCommand("git", ["rev-parse", "--show-toplevel"], {
    cwd: projectRoot,
    timeoutMs: 5_000,
    maxOutput: 8_192,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  const resolvedTop = top.exitCode === 0 ? sanitizeTerminalText(top.stdout).trim() : "";
  // `git rev-parse --show-toplevel` reports the physical path, so a repository
  // reached through a symlink (/tmp on macOS, a symlinked projects directory)
  // would never string-compare equal to the path the user actually passed.
  const physical = async (path: string) => realpath(path).catch(() => path);
  const rootMatches = resolvedTop !== "" && (
    resolvedTop === projectRoot ||
    await physical(resolvedTop) === await physical(projectRoot)
  );
  const checks = [
    check(
      "git_root",
      rootMatches ? "pass" : "fail",
      rootMatches
        ? "Selected project is the Git repository root."
        : top.available && top.exitCode === 0
          ? `Selected project is not the repository root; detected ${resolvedTop || "unknown"}.`
          : "Selected project is not a readable Git repository.",
    ),
  ];
  return { status: checks.some((item) => item.status === "fail") ? "fail" : "pass", checks };
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const startedAt = new Date().toISOString();
  const [workspace, claude, codex] = await Promise.all([
    doctorWorkspace(options.projectRoot),
    doctorClaude(options.claude ?? defaultCommand("claude")),
    doctorCodex(options.codex ?? defaultCommand("codex")),
  ]);
  return {
    schemaVersion: "doctor/v1",
    projectRoot: options.projectRoot,
    startedAt,
    completedAt: new Date().toISOString(),
    status: workspace.status === "fail" ? "fail" : overall([claude, codex]),
    safety: {
      modelTurnsStarted: 0,
      threadsStarted: 0,
      bypassFlagsUsed: false,
      providerConfigModified: false,
      credentialsPersisted: false,
    },
    workspace,
    providers: { claude, codex },
  };
}

export function formatDoctor(report: DoctorReport): string {
  const lines = [
    `Splitlane doctor · ${report.status.toUpperCase()} · no model turns or threads started`,
    `project: ${report.projectRoot}`,
  ];
  lines.push("", `WORKSPACE · ${report.workspace.status.toUpperCase()}`);
  for (const item of report.workspace.checks) lines.push(`  ${item.status === "pass" ? "✓" : item.status === "warn" ? "!" : "✗"} ${item.id}: ${item.detail}`);
  for (const provider of [report.providers.claude, report.providers.codex]) {
    lines.push("", `${provider.provider.toUpperCase()} · ${provider.version ?? "not found"} · auth ${provider.auth}`);
    for (const item of provider.checks) lines.push(`  ${item.status === "pass" ? "✓" : item.status === "warn" ? "!" : "✗"} ${item.id}: ${item.detail}`);
  }
  lines.push("", "Safety: 0 model turns · 0 threads · no bypass flags · no config or credential writes");
  return `${lines.join("\n")}\n`;
}
