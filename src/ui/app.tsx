import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import type { AppSnapshot, LaneSnapshot, ProviderId, RoleId } from "../domain.ts";
import type { CompareOrchestrator } from "../core/orchestrator.ts";
import { contentHeight, selectLayout } from "./layout.ts";
import { removeLastGrapheme, tailLines } from "./text.ts";

type Overlay = "model" | "actions" | "roles" | "diagnostics" | "writer" | "approval" | "review" | "findings" | null;

const ROLE_IDS: readonly RoleId[] = [
  "scout",
  "architect",
  "builder",
  "debugger",
  "intent_reviewer",
  "correctness_reviewer",
];

const ACTIONS = [
  ["common.prompt", "stable", "Send to selected target"],
  ["common.cancel_lane", "stable", "Cancel focused lane only"],
  ["common.writer_lease", "stable", "Promote or revoke one visible writer"],
  ["common.approval_inbox", "stable", "Allow once, deny, or cancel turn"],
  ["common.review_handoff", "stable", "Pause writer and start one read-only review"],
  ["claude.plan_mode", "stable", "Read-only planning (active)"],
  ["claude.agent_sdk_write", "stable", "Sandboxed build with temporary approvals"],
  ["codex.app_server", "preview", "Streaming + lane approvals"],
  ["codex.native_review", "preview", "Capability-gated app-server review/start"],
  ["codex.workspace_write", "preview", "Workspace-write build with network off"],
] as const;

function statusColor(status: LaneSnapshot["status"]): string {
  if (status === "FAILED" || status === "UNAVAILABLE") return "red";
  if (status === "RUNNING" || status === "STARTING") return "cyan";
  if (status === "BLOCKED" || status === "CANCELLING") return "yellow";
  if (status === "COMPLETED") return "green";
  return "gray";
}

function Lane({ lane, focused, height }: { lane: LaneSnapshot; focused: boolean; height: number }) {
  const output = lane.output || (lane.error ? "" : "No output yet.");
  return (
    <Box borderStyle={focused ? "double" : "round"} borderColor={focused ? "cyan" : "gray"} flexDirection="column" paddingX={1} height={height} flexGrow={1}>
      <Box justifyContent="space-between">
        <Text bold>{lane.provider === "claude" ? "CLAUDE CODE" : "CODEX"}</Text>
        <Text color={statusColor(lane.status)}>{lane.status}</Text>
      </Box>
      <Text dimColor>model: {lane.effectiveModel}  session: {lane.sessionId ? lane.sessionId.slice(0, 10) : "new"}</Text>
      {lane.toolSummary ? <Text color="yellow">{lane.toolSummary}</Text> : null}
      <Text wrap="wrap">{tailLines(output, Math.max(2, height - 5))}</Text>
      {lane.error ? <Text color="red">{tailLines(lane.error, 2)}</Text> : null}
    </Box>
  );
}

function Inspector({ snapshot, height }: { snapshot: AppSnapshot; height: number }) {
  const git = snapshot.git;
  const review = snapshot.review;
  if (review && review.findings.length > 0) {
    const findingsBody = review.findings.map((finding) => {
      const location = finding.file ? `${finding.file}${finding.lineStart ? `:${finding.lineStart}` : ""}` : "general";
      return `${finding.id === review.activeFindingId ? ">" : " "}${finding.selected ? "[x]" : "[ ]"} ${finding.severity.toUpperCase()} · ${location}\n${finding.title}`;
    }).join("\n\n");
    const preview = review.preview
      ? review.preview.error
        ? `PREVIEW · ${review.preview.file}\n${review.preview.error}`
        : `PREVIEW · ${review.preview.file}\n${review.preview.content}`
      : "";
    const body = [findingsBody, preview].filter(Boolean).join("\n\n");
    return (
      <Box borderStyle="round" borderColor="magenta" flexDirection="column" paddingX={1} height={height} flexGrow={1}>
        <Text bold>FINDINGS · READ ONLY</Text>
        <Text dimColor>{review.reviewer} · {review.mechanism} [{review.envelope.mechanismStability}] · {review.envelope.diffHash.slice(0, 8)} · {review.stale ? "STALE" : "CURRENT"}</Text>
        <Text wrap="wrap">{tailLines(body, Math.max(2, height - 4))}</Text>
      </Box>
    );
  }
  const evidence = git.evidence.map(({ path, classification }) => `[${classification}] ${path}`);
  const body = git.error
    ? git.error
    : git.files.length === 0
      ? "Working tree clean"
      : [evidence.join("\n"), git.diffStat || tailLines(git.diff, Math.max(2, height - 7))]
          .filter(Boolean)
          .join("\n\n");
  return (
    <Box borderStyle="round" borderColor="magenta" flexDirection="column" paddingX={1} height={height} flexGrow={1}>
      <Text bold>EVIDENCE · READ ONLY</Text>
      <Text dimColor>{git.branch} · {git.dirty ? "DIRTY" : "CLEAN"} · baseline {git.baselineFingerprint?.slice(0, 8) ?? "none"}</Text>
      <Text wrap="wrap">{tailLines(body, Math.max(2, height - 4))}</Text>
    </Box>
  );
}

function OverlayPanel({ overlay, snapshot, modelProvider, modelDraft, roleIndex, writerProvider, writerConfirm, approvalIndex, reviewCriteria, findingIndex, staleAcknowledged }: {
  overlay: Exclude<Overlay, null>;
  snapshot: AppSnapshot;
  modelProvider: ProviderId;
  modelDraft: string;
  roleIndex: number;
  writerProvider: ProviderId;
  writerConfirm: boolean;
  approvalIndex: number;
  reviewCriteria: string;
  findingIndex: number;
  staleAcknowledged: boolean;
}) {
  if (overlay === "model") {
    return (
      <Box borderStyle="double" borderColor="yellow" flexDirection="column" paddingX={1}>
        <Text bold>MODEL · {modelProvider.toUpperCase()}</Text>
        <Text>Exact ID or default: <Text color="cyan">{modelDraft || " "}</Text></Text>
        <Text dimColor>Tab provider · Enter apply to next request · Esc close</Text>
      </Box>
    );
  }
  if (overlay === "roles") {
    return (
      <Box borderStyle="double" borderColor="yellow" flexDirection="column" paddingX={1}>
        <Text bold>ROLE PROFILE · recommendation only</Text>
        {ROLE_IDS.map((role, index) => (
          <Text key={role} color={index === roleIndex ? "cyan" : "white"}>
            {index === roleIndex ? ">" : " "} {role}: {snapshot.roles[role]}
          </Text>
        ))}
        <Text dimColor>↑/↓ role · Tab provider · Enter apply · Esc close</Text>
      </Box>
    );
  }
  if (overlay === "diagnostics") {
    return (
      <Box borderStyle="double" borderColor="red" flexDirection="column" paddingX={1}>
        <Text bold>RAW DIAGNOSTICS · SANITIZED + BOUNDED</Text>
        <Text>{snapshot.diagnostics.length ? tailLines(snapshot.diagnostics.join("\n"), 12) : "No adapter diagnostics."}</Text>
        <Text dimColor>Ctrl+D/Esc close</Text>
      </Box>
    );
  }
  if (overlay === "writer") {
    const lane = snapshot.lanes[writerProvider];
    const visibleDirtyFiles = snapshot.git.files.slice(0, 5);
    const remainingDirtyFiles = snapshot.git.files.length - visibleDirtyFiles.length;
    return (
      <Box borderStyle="double" borderColor="yellow" flexDirection="column" paddingX={1}>
        <Text bold>ENTER BUILD · SINGLE WRITER · {writerConfirm ? "CONFIRM" : "SELECT"}</Text>
        <Text>writer: <Text color="cyan">{writerProvider.toUpperCase()}</Text> · model: {lane.effectiveModel}</Text>
        <Text>root: {snapshot.git.root || "not a Git repository"}</Text>
        <Text>dirty: {snapshot.git.dirty ? `${visibleDirtyFiles.join(", ")}${remainingDirtyFiles > 0 ? ` (+${remainingDirtyFiles} more)` : ""}` : "clean"}</Text>
        <Text color="yellow">effect: workspace-write inside root · network off · peer remains read-only</Text>
        <Text dimColor>{writerConfirm ? "Enter grant lease · Esc close" : "Tab writer · Enter review confirmation · Esc close"}</Text>
      </Box>
    );
  }
  if (overlay === "approval") {
    const approval = snapshot.approvals[approvalIndex] ?? snapshot.approvals[0];
    return (
      <Box borderStyle="double" borderColor="yellow" flexDirection="column" paddingX={1}>
        <Text bold>APPROVAL INBOX · {snapshot.approvals.length} PENDING</Text>
        {approval ? (
          <>
            <Text>{approval.provider.toUpperCase()} · {approval.tool}</Text>
            <Text>command: {approval.command ?? "n/a"}</Text>
            <Text>cwd/path: {approval.paths.length ? approval.paths.join(", ") : approval.path ?? approval.cwd ?? "unknown"}</Text>
            <Text>reason: {approval.reason ?? "not provided"}</Text>
            <Text color={approval.outsideWorkspace ? "red" : "gray"}>boundary: {approval.outsideWorkspace ? "OUTSIDE WORKSPACE" : "inside/unknown"} · network {approval.networkEffect}</Text>
            <Text dimColor>↑/↓ request · A allow once · D deny · X cancel turn · Esc close</Text>
          </>
        ) : <Text>No pending approvals. Esc close.</Text>}
      </Box>
    );
  }
  if (overlay === "review") {
    const review = snapshot.review;
    if (!review) return <Text>Review draft unavailable. Esc close.</Text>;
    const files = review.envelope.files.slice(0, 5).map(({ path }) => path).join(", ");
    return (
      <Box borderStyle="double" borderColor="yellow" flexDirection="column" paddingX={1}>
        <Text bold>START REVIEW · REVOKE WRITER THEN READ ONLY</Text>
        <Text>{review.writer.toUpperCase()} → {review.reviewer.toUpperCase()} · {review.mechanism} [{review.envelope.mechanismStability}]</Text>
        <Text dimColor>available: {review.availableMechanisms.join(" · ")}</Text>
        <Text>base: {review.envelope.head.slice(0, 12)} · diff {review.envelope.diffBytes} bytes · {review.envelope.diffHash.slice(0, 12)}</Text>
        <Text>files: {files}{review.envelope.files.length > 5 ? ` (+${review.envelope.files.length - 5} more)` : ""}</Text>
        <Text>objective: {tailLines(review.envelope.objective, 2)}</Text>
        <Text>acceptance criteria: <Text color="cyan">{reviewCriteria || " "}</Text></Text>
        <Text color="yellow">Enter revokes the writer lease before dispatch. Network and writes stay off.</Text>
        <Text dimColor>Type criteria · Tab mechanism · Enter start · Esc keep build</Text>
      </Box>
    );
  }
  if (overlay === "findings") {
    const review = snapshot.review;
    const finding = review?.findings[findingIndex] ?? review?.findings[0];
    return (
      <Box borderStyle="double" borderColor={review?.stale ? "red" : "magenta"} flexDirection="column" paddingX={1}>
        <Text bold>REVIEW FINDINGS · {review?.status.toUpperCase() ?? "NONE"} · {review?.stale ? "STALE" : "CURRENT"}</Text>
        {finding ? <>
          <Text>{finding.selected ? "[x]" : "[ ]"} {finding.severity.toUpperCase()} · {finding.title}</Text>
          <Text>{finding.file ?? "general"}{finding.lineStart ? `:${finding.lineStart}` : ""}</Text>
          <Text>{tailLines(finding.body, 5)}</Text>
          {finding.verification ? <Text dimColor>verify: {finding.verification}</Text> : null}
        </> : <Text>{review?.parseError ?? (review?.status === "running" ? "Review is running…" : "No structured findings.")}</Text>}
        <Text dimColor>↑/↓ finding · Space select · A accept · E exit · S stale ack ({staleAcknowledged ? "yes" : "no"}) · R return selected</Text>
      </Box>
    );
  }
  return (
    <Box borderStyle="double" borderColor="yellow" flexDirection="column" paddingX={1}>
      <Text bold>ACTION PALETTE · capability aware</Text>
      {ACTIONS.map(([id, stability, description]) => (
        <Text key={id}>{id} <Text color={stability === "stable" ? "green" : "gray"}>[{stability}]</Text> · {description}</Text>
      ))}
      <Text dimColor>Esc/Ctrl+P close</Text>
    </Box>
  );
}

export function SplitlaneView({ snapshot, prompt, columns, rows, overlay = null, modelProvider = "claude", modelDraft = "", roleIndex = 0, writerProvider = "claude", writerConfirm = false, approvalIndex = 0, reviewCriteria = "", findingIndex = 0, staleAcknowledged = false }: {
  snapshot: AppSnapshot;
  prompt: string;
  columns: number;
  rows: number;
  overlay?: Overlay;
  modelProvider?: ProviderId;
  modelDraft?: string;
  roleIndex?: number;
  writerProvider?: ProviderId;
  writerConfirm?: boolean;
  approvalIndex?: number;
  reviewCriteria?: string;
  findingIndex?: number;
  staleAcknowledged?: boolean;
}) {
  const layout = selectLayout(columns);
  const height = contentHeight(rows);
  const lanes = layout === "focused" ? [snapshot.focusedProvider] : (["claude", "codex"] as const);
  const laneDirection = layout === "columns" ? "row" : "column";
  const outerDirection = layout === "focused" ? "column" : "row";
  const laneHeight = layout === "stacked" ? Math.max(5, Math.floor(height / 2)) : height;
  const focusedLaneHeight = snapshot.inspectorVisible ? Math.max(6, Math.floor(height * 0.65)) : height;
  const roleSummary = ROLE_IDS.map((role) => `${role.replace("_reviewer", "-rev")}:${snapshot.roles[role] === "claude" ? "C" : "X"}`).join(" · ");
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color="cyan">SPLITLANE</Text>
        <Text>mode <Text color="green">{snapshot.mode.toUpperCase()}</Text> · writer <Text color={snapshot.writer ? "yellow" : "gray"}>{snapshot.writer?.toUpperCase() ?? "NONE"}{snapshot.writerRevoking ? " (REVOKING)" : ""}</Text>{snapshot.mode === "review" && snapshot.review ? <Text> · paused <Text color="yellow">{snapshot.review.writer.toUpperCase()}</Text></Text> : null} · approvals <Text color={snapshot.approvals.length ? "yellow" : "gray"}>{snapshot.approvals.length}</Text> · target <Text color="yellow">{snapshot.target.toUpperCase()}</Text></Text>
      </Box>
      <Text dimColor>role preview (C=Claude X=Codex) · {roleSummary} · never auto-routes</Text>
      {overlay ? <OverlayPanel overlay={overlay} snapshot={snapshot} modelProvider={modelProvider} modelDraft={modelDraft} roleIndex={roleIndex} writerProvider={writerProvider} writerConfirm={writerConfirm} approvalIndex={approvalIndex} reviewCriteria={reviewCriteria} findingIndex={findingIndex} staleAcknowledged={staleAcknowledged} /> : (
        <Box flexDirection={outerDirection} gap={1}>
          <Box flexDirection={laneDirection} flexGrow={snapshot.inspectorVisible ? 2 : 1} gap={1}>
            {lanes.map((provider) => <Lane key={provider} lane={snapshot.lanes[provider]} focused={snapshot.focusedProvider === provider} height={layout === "focused" ? focusedLaneHeight : laneHeight} />)}
          </Box>
          {snapshot.inspectorVisible ? <Inspector snapshot={snapshot} height={layout === "focused" ? Math.max(5, height - focusedLaneHeight) : height} /> : null}
        </Box>
      )}
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="cyan">› </Text><Text>{prompt || "Type a prompt…"}</Text>
      </Box>
      {snapshot.notice ? <Text color="yellow">{snapshot.notice}</Text> : null}
      <Text dimColor>Enter send · ^R target · ^B build · ^V review · ^F findings · ^W revoke · ^A approvals · ⌥1/2 focus · ^X cancel · ^I inspector · ^M model · ^P actions · ^O roles · ^D diagnostics · ^Q quit</Text>
    </Box>
  );
}

export function App({ orchestrator }: { orchestrator: CompareOrchestrator }) {
  const snapshot = useSyncExternalStore(orchestrator.subscribe, orchestrator.getSnapshot, orchestrator.getSnapshot);
  const { columns, rows } = useWindowSize();
  const { exit } = useApp();
  const [prompt, setPrompt] = useState("");
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [modelProvider, setModelProvider] = useState<ProviderId>(snapshot.focusedProvider);
  const [modelDraft, setModelDraft] = useState("");
  const [roleIndex, setRoleIndex] = useState(0);
  const [roleProvider, setRoleProvider] = useState<ProviderId>("claude");
  const [writerProvider, setWriterProvider] = useState<ProviderId>(snapshot.focusedProvider);
  const [writerConfirm, setWriterConfirm] = useState(false);
  const [approvalIndex, setApprovalIndex] = useState(0);
  const [reviewCriteria, setReviewCriteria] = useState("");
  const [findingIndex, setFindingIndex] = useState(0);
  const [staleAcknowledged, setStaleAcknowledged] = useState(false);

  useEffect(() => {
    if (snapshot.approvals.length > 0) {
      setApprovalIndex((index) => Math.min(index, snapshot.approvals.length - 1));
      setOverlay("approval");
    } else if (overlay === "approval") setOverlay(null);
  }, [snapshot.approvals.length]);

  useEffect(() => {
    if (snapshot.mode === "review" && snapshot.review && snapshot.review.status !== "running") {
      setFindingIndex(0);
      setStaleAcknowledged(false);
      setOverlay("findings");
      const first = snapshot.review.findings[0];
      if (first) void orchestrator.selectFinding(first.id);
    }
  }, [snapshot.review?.status]);

  useInput((input, key) => {
    if (key.ctrl && input === "q") {
      void orchestrator.close().finally(exit);
      return;
    }
    if (key.escape) {
      setOverlay(null);
      setWriterConfirm(false);
      return;
    }
    if (overlay === "model") {
      if (key.tab) {
        const next = modelProvider === "claude" ? "codex" : "claude";
        setModelProvider(next);
        setModelDraft(snapshot.lanes[next].requestedModel);
      } else if (key.return) {
        orchestrator.setModel(modelProvider, modelDraft);
        setOverlay(null);
      } else if (key.backspace || key.delete) setModelDraft(removeLastGrapheme(modelDraft));
      else if (!key.ctrl && !key.meta) setModelDraft((current) => current + input);
      return;
    }
    if (overlay === "roles") {
      if (key.upArrow) setRoleIndex((index) => (index - 1 + ROLE_IDS.length) % ROLE_IDS.length);
      else if (key.downArrow) setRoleIndex((index) => (index + 1) % ROLE_IDS.length);
      else if (key.tab) setRoleProvider((provider) => provider === "claude" ? "codex" : "claude");
      else if (key.return) {
        orchestrator.setRole(ROLE_IDS[roleIndex] ?? "scout", roleProvider);
        setOverlay(null);
      }
      return;
    }
    if (overlay === "actions") {
      if (key.ctrl && input === "p") setOverlay(null);
      return;
    }
    if (overlay === "diagnostics") {
      if (key.ctrl && input === "d") setOverlay(null);
      return;
    }
    if (overlay === "writer") {
      if (key.tab && !writerConfirm) setWriterProvider((provider) => provider === "claude" ? "codex" : "claude");
      else if (key.return && !writerConfirm) setWriterConfirm(true);
      else if (key.return) {
        void orchestrator.promoteWriter(writerProvider, snapshot.git.dirty).then((promoted) => {
          if (promoted) {
            setOverlay(null);
            setWriterConfirm(false);
          }
        });
      }
      return;
    }
    if (overlay === "approval") {
      if (key.upArrow) setApprovalIndex((index) => (index - 1 + Math.max(1, snapshot.approvals.length)) % Math.max(1, snapshot.approvals.length));
      else if (key.downArrow) setApprovalIndex((index) => (index + 1) % Math.max(1, snapshot.approvals.length));
      else {
        const approval = snapshot.approvals[approvalIndex] ?? snapshot.approvals[0];
        if (approval && input.toLowerCase() === "a") orchestrator.resolveApproval(approval.id, "allow_once");
        else if (approval && input.toLowerCase() === "d") orchestrator.resolveApproval(approval.id, "deny");
        else if (approval && input.toLowerCase() === "x") orchestrator.resolveApproval(approval.id, "cancel_turn");
      }
      return;
    }
    if (overlay === "review") {
      if (key.tab && snapshot.review) {
        const mechanisms = snapshot.review.availableMechanisms;
        const index = mechanisms.indexOf(snapshot.review.mechanism);
        const next = mechanisms[(index + 1) % mechanisms.length];
        if (next) orchestrator.setReviewMechanism(next);
      } else if (key.return) {
        void orchestrator.startReview(reviewCriteria).then((started) => { if (started) setOverlay(null); });
      } else if (key.backspace || key.delete) setReviewCriteria(removeLastGrapheme(reviewCriteria));
      else if (!key.ctrl && !key.meta) setReviewCriteria((current) => current + input);
      return;
    }
    if (overlay === "findings") {
      const count = Math.max(1, snapshot.review?.findings.length ?? 0);
      if (key.upArrow) {
        const next = (findingIndex - 1 + count) % count;
        setFindingIndex(next);
        const finding = snapshot.review?.findings[next];
        if (finding) void orchestrator.selectFinding(finding.id);
      } else if (key.downArrow) {
        const next = (findingIndex + 1) % count;
        setFindingIndex(next);
        const finding = snapshot.review?.findings[next];
        if (finding) void orchestrator.selectFinding(finding.id);
      }
      else {
        const finding = snapshot.review?.findings[findingIndex] ?? snapshot.review?.findings[0];
        if (input === " " && finding) orchestrator.toggleFinding(finding.id);
        else if (input.toLowerCase() === "a" && orchestrator.finishReview("accept")) setOverlay(null);
        else if (input.toLowerCase() === "e" && orchestrator.finishReview("exit")) setOverlay(null);
        else if (input.toLowerCase() === "s" && snapshot.review?.stale) setStaleAcknowledged((value) => !value);
        else if (input.toLowerCase() === "r" && snapshot.review) {
          const relay = orchestrator.returnSelectedFindings(staleAcknowledged);
          if (relay) {
            setPrompt(relay);
            setWriterProvider(snapshot.review.writer);
            setWriterConfirm(false);
            setOverlay("writer");
          }
        }
      }
      return;
    }
    if (key.meta && input === "1") orchestrator.focus("claude");
    else if (key.meta && input === "2") orchestrator.focus("codex");
    else if (key.ctrl && input === "r") orchestrator.cycleTarget();
    else if (key.ctrl && input === "x") void orchestrator.cancel(snapshot.focusedProvider);
    else if (key.ctrl && input === "i") orchestrator.toggleInspector();
    else if (key.ctrl && input === "v") {
      if (snapshot.mode !== "build") return;
      setReviewCriteria("");
      void orchestrator.prepareReview().then((ready) => { if (ready) setOverlay("review"); });
    } else if (key.ctrl && input === "f") {
      if (!snapshot.review) return;
      setFindingIndex(0);
      setStaleAcknowledged(false);
      setOverlay("findings");
      const first = snapshot.review.findings[0];
      if (first) void orchestrator.selectFinding(first.id);
    } else if (key.ctrl && input === "b") {
      if (snapshot.mode !== "compare") return;
      setWriterProvider(snapshot.focusedProvider);
      setWriterConfirm(false);
      setOverlay("writer");
    } else if (key.ctrl && input === "w") void orchestrator.revokeWriter();
    else if (key.ctrl && input === "a") {
      setApprovalIndex(0);
      setOverlay("approval");
    }
    else if (key.ctrl && input === "m") {
      setModelProvider(snapshot.focusedProvider);
      setModelDraft(snapshot.lanes[snapshot.focusedProvider].requestedModel);
      setOverlay("model");
    } else if (key.ctrl && input === "p") setOverlay("actions");
    else if (key.ctrl && input === "d") setOverlay("diagnostics");
    else if (key.ctrl && input === "o") {
      setRoleProvider(snapshot.roles[ROLE_IDS[roleIndex] ?? "scout"]);
      setOverlay("roles");
    } else if (key.return) {
      void orchestrator.dispatch(prompt).then((sent) => { if (sent) setPrompt(""); });
    } else if (key.backspace || key.delete) setPrompt(removeLastGrapheme(prompt));
    else if (!key.ctrl && !key.meta) setPrompt((current) => current + input);
  });

  return <SplitlaneView snapshot={snapshot} prompt={prompt} columns={columns} rows={rows} overlay={overlay} modelProvider={modelProvider} modelDraft={modelDraft} roleIndex={roleIndex} writerProvider={writerProvider} writerConfirm={writerConfirm} approvalIndex={approvalIndex} reviewCriteria={reviewCriteria} findingIndex={findingIndex} staleAcknowledged={staleAcknowledged} />;
}
