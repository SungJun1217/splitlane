import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JsonlRpcProcess } from "../spike/lib/jsonl-rpc.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "fake-jsonl-server.mjs");

test("exchanges JSONL requests and captures malformed diagnostics", async () => {
  const rpc = new JsonlRpcProcess(process.execPath, [fixture]);
  await rpc.start();
  try {
    const result = await rpc.request("initialize", { clientInfo: { name: "test" } });
    assert.equal(result.userAgent, "fake-app-server/1.0");
    rpc.notify("emit/malformed");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(rpc.notifications[0].method, "diagnostic/malformed");
  } finally {
    const terminated = await rpc.close();
    assert.equal(terminated.terminated, true);
  }
});

test("request timeout does not terminate the process implicitly", async () => {
  const rpc = new JsonlRpcProcess(process.execPath, [fixture]);
  await rpc.start();
  try {
    await assert.rejects(rpc.request("never/responds", {}, 30), /Timed out/);
  } finally {
    await rpc.close();
  }
});

test("handles server requests and returns typed approval responses", async () => {
  const rpc = new JsonlRpcProcess(process.execPath, [fixture]);
  await rpc.start();
  try {
    rpc.notify("request/server");
    const request = await rpc.waitForMessage((message) => message.method === "item/fileChange/requestApproval");
    assert.equal(request.params.reason, "test");
    rpc.respond(request.id, { decision: "decline" });
    const observed = await rpc.waitForMessage((message) => message.method === "approval/observed");
    assert.equal(observed.params.decision, "decline");
  } finally {
    await rpc.close();
  }
});
