import { spawn } from "node:child_process";

function appendBounded(current, chunk, maxOutput) {
  const next = current + chunk;
  return next.length > maxOutput ? next.slice(next.length - maxOutput) : next;
}

export function runCommand(command, args = [], options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = 5_000,
    maxOutput = 512_000,
  } = options;

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ command, args, stdout, stderr, timedOut, ...result });
    };

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk.toString("utf8"), maxOutput);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk.toString("utf8"), maxOutput);
    });
    child.on("error", (error) => finish({ available: false, exitCode: null, error: error.message }));
    child.on("close", (exitCode, signal) =>
      finish({ available: true, exitCode, signal, error: null }),
    );

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
  });
}
