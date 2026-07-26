function entry({ id, provider, label, stability = "stable", available, blocked = false, transport, requirements = [], inputSchema = {}, safetyEffect = "none", sessionEffect = "none", conflicts = [] }) {
  return {
    id,
    provider,
    label,
    stability,
    availability: available ? "available" : blocked ? "blocked" : "unavailable",
    transport,
    requirements,
    input_schema: inputSchema,
    safety_effect: safetyEffect,
    session_effect: sessionEffect,
    conflicts,
  };
}

const has = (text, fragment) => text.includes(fragment);

export function detectClaudeCapabilities(help, liveEvidence = {}) {
  const stream = has(help, "stream-json") && has(help, "--include-partial-messages");
  const resume = has(help, "--resume") && has(help, "--session-id");
  const plan = has(help, "--permission-mode") && has(help, "plan");
  const subagents = has(help, "--agents") && has(help, "--forward-subagent-text");
  return [
    entry({ id: "streaming", provider: "claude", label: "Structured streaming", available: stream, transport: "cli.stream-json", requirements: ["--print", "--output-format=stream-json"] }),
    entry({ id: "resume", provider: "claude", label: "Session resume", available: resume && liveEvidence.resume === true, blocked: resume, transport: "cli.stream-json", requirements: ["provider session ID", "version-matched live resume proof"] , sessionEffect: "resume provider session"}),
    entry({ id: "model_override", provider: "claude", label: "Model override", available: has(help, "--model"), transport: "cli", inputSchema: { type: "string" }, sessionEffect: "may require a new session" }),
    entry({ id: "effort_override", provider: "claude", label: "Effort override", available: has(help, "--effort"), transport: "cli", inputSchema: { enum: ["low", "medium", "high", "xhigh", "max"] } }),
    entry({ id: "read_only", provider: "claude", label: "Plan/read-only policy", available: plan, transport: "cli", requirements: ["--permission-mode=plan"], safetyEffect: "deny workspace mutation" }),
    entry({ id: "interactive_approval", provider: "claude", label: "Interactive approval callback", available: liveEvidence.interactiveApproval === true, blocked: stream, transport: liveEvidence.interactiveApproval ? "official-agent-sdk" : "unproved", requirements: ["official Agent SDK canUseTool callback", "version-matched live proof"], safetyEffect: "surfaces and resolves tool permission requests" }),
    entry({ id: "interrupt", provider: "claude", label: "Process-group interruption", available: true, transport: "process-group", requirements: ["spawned child process group"], sessionEffect: "resume safety must be revalidated after forced kill" }),
    entry({ id: "claude.plan_mode", provider: "claude", label: "Claude: Plan", available: plan, transport: "cli.stream-json", requirements: ["read-only permission mode"], safetyEffect: "deny workspace mutation" }),
    entry({ id: "claude.subagent", provider: "claude", label: "Claude: Explore subagent", stability: "preview", available: false, blocked: subagents, transport: "cli.stream-json", requirements: ["forwarded subagent text", "live lifecycle proof"], safetyEffect: "child process/session visibility required", sessionEffect: "may create child agent state" }),
  ];
}

export function detectCodexCapabilities({ help, execHelp, reviewHelp, appServerHelp, schemaText, liveEvidence = {} }) {
  const appServer = has(help, "app-server") && has(appServerHelp, "generate-json-schema");
  const method = (name) => schemaText.includes(`\"${name}\"`);
  return [
    entry({ id: "streaming", provider: "codex", label: "Structured streaming", stability: "preview", available: appServer && method("turn/start"), transport: "app-server" }),
    entry({ id: "resume", provider: "codex", label: "Thread resume", stability: "preview", available: appServer && method("thread/resume") && liveEvidence.resume === true, blocked: appServer && method("thread/resume"), transport: "app-server", requirements: ["provider thread ID", "version-matched live round-trip proof"], sessionEffect: "resume provider thread" }),
    entry({ id: "model_override", provider: "codex", label: "Model override", available: has(help, "--model"), transport: "cli/app-server", inputSchema: { type: "string" }, sessionEffect: "applies to requested turn or thread" }),
    entry({ id: "effort_override", provider: "codex", label: "Reasoning effort override", stability: "preview", available: schemaText.includes("effort"), transport: "app-server" }),
    entry({ id: "read_only", provider: "codex", label: "Read-only sandbox", available: has(help, "read-only"), transport: "cli/app-server", safetyEffect: "deny workspace mutation" }),
    entry({ id: "interactive_approval", provider: "codex", label: "Interactive approval callback", stability: "preview", available: appServer && schemaText.includes("requestApproval") && liveEvidence.interactiveApproval === true, blocked: appServer && schemaText.includes("requestApproval"), transport: "app-server", requirements: ["server request routing", "version-matched live proof"], safetyEffect: "surfaces requested privilege escalation" }),
    entry({ id: "interrupt", provider: "codex", label: "Turn interruption", stability: "preview", available: appServer && method("turn/interrupt"), transport: "app-server", sessionEffect: "interrupt current turn only" }),
    entry({ id: "codex.review", provider: "codex", label: "Codex: Review diff", available: has(reviewHelp, "--uncommitted") && has(reviewHelp, "--base"), transport: "cli.review", requirements: ["Git repository", "model turn"], safetyEffect: "must run read-only" }),
    entry({ id: "codex.output_schema", provider: "codex", label: "Codex: Structured findings", available: has(execHelp, "--output-schema"), transport: "cli.exec/app-server", requirements: ["validated findings schema", "model turn"] }),
  ];
}
