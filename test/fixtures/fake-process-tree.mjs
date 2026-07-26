import { spawn } from "node:child_process";

process.on("SIGTERM", () => {});

const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {
  stdio: "ignore",
});

process.stdout.write(`${JSON.stringify({ grandchildPid: grandchild.pid })}\n`);
setInterval(() => {}, 1_000);
