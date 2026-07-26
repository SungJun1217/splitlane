import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isProcessGroupAlive, terminateProcessGroup } from "../spike/lib/process-group.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "fake-process-tree.mjs");

test("cancellation escalates and removes a process group that ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const child = spawn(process.execPath, [fixture], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const firstLine = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fake process tree did not start")), 1_000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      resolve(line);
    });
  });
  const { grandchildPid } = JSON.parse(firstLine);
  assert.equal(isProcessGroupAlive(child.pid), true);

  const result = await terminateProcessGroup(child, { graceMs: 50, killWaitMs: 1_500 });
  lines.close();
  assert.equal(result.escalated, true);
  assert.equal(result.terminated, true);
  assert.equal(isProcessGroupAlive(child.pid), false);
  assert.throws(() => process.kill(grandchildPid, 0), (error) => error.code === "ESRCH");
});
