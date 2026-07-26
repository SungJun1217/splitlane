import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize" && Object.hasOwn(message, "id")) {
    process.stdout.write(`${JSON.stringify({
      id: message.id,
      result: {
        userAgent: "fake-app-server/1.0",
        platformFamily: "unix",
        platformOs: "test",
        codexHome: "/Users/example/.codex",
      },
    })}\n`);
    return;
  }
  if (message.method === "emit/malformed") {
    process.stdout.write("not-json\n");
  }
  if (message.method === "request/server") {
    process.stdout.write(`${JSON.stringify({ id: 91, method: "item/fileChange/requestApproval", params: { reason: "test" } })}\n`);
  }
  if (message.method === "exit/abrupt") {
    process.exit(17);
  }
  if (message.id === 91 && message.result?.decision === "decline") {
    process.stdout.write(`${JSON.stringify({ method: "approval/observed", params: { decision: "decline" } })}\n`);
  }
});

process.on("SIGTERM", () => process.exit(0));
