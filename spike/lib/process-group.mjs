import { setTimeout as delay } from "node:timers/promises";

export function isProcessGroupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pid)) return true;
    await delay(20);
  }
  return !isProcessGroupAlive(pid);
}

export async function terminateProcessGroup(child, options = {}) {
  const { graceMs = 300, killWaitMs = 1_500 } = options;
  const pid = child?.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return { terminated: true, escalated: false, pid: null };
  }

  if (!isProcessGroupAlive(pid)) {
    return { terminated: true, escalated: false, pid };
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }

  if (await waitForGroupExit(pid, graceMs)) {
    return { terminated: true, escalated: false, pid };
  }

  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }

  return {
    terminated: await waitForGroupExit(pid, killWaitMs),
    escalated: true,
    pid,
  };
}
