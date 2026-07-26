import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { sanitizeTerminalText } from "../terminal/sanitize.ts";

export interface CommandResult {
  available: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runCommand(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number; maxOutput?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxOutput = options.maxOutput ?? 128_000;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const retain = (current: string, chunk: Buffer): string =>
      (current + sanitizeTerminalText(chunk.toString("utf8"))).slice(-maxOutput);
    child.stdout.on("data", (chunk: Buffer) => (stdout = retain(stdout, chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr = retain(stderr, chunk)));
    const finish = (result: Pick<CommandResult, "available" | "exitCode">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, timedOut });
    };
    child.once("error", () => finish({ available: false, exitCode: null }));
    child.once("close", (code) => finish({ available: true, exitCode: code }));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
  });
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForGroup(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return true;
    await delay(20);
  }
  return !groupAlive(pid);
}

export async function terminateProcessGroup(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid || process.platform === "win32") {
    child.kill("SIGKILL");
    return;
  }
  if (!groupAlive(pid)) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {}
  if (await waitForGroup(pid, 2_000)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {}
  await waitForGroup(pid, 2_000);
}
