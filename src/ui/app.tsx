import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import type { AppSnapshot, LaneSnapshot, MetaSessionSnapshot, ProviderId, RoleId } from "../domain.ts";
import type { CompareOrchestrator } from "../core/orchestrator.ts";
import { providerErrorAction } from "../core/provider-error.ts";
import { fitsTerminal, LANE_CHROME_COMPACT, LANE_CHROME_FULL, laneOutputHeight, laneOutputRows, minimumRows, MIN_COLUMNS, panelHeights, panelWidths, selectLayout, type ViewMode } from "./layout.ts";
import { fitLines, lineCount, maxScrollOffset, removeLastGrapheme, scrollWindow, tailLines } from "./text.ts";

type Overlay = "flow_start" | "model" | "actions" | "roles" | "diagnostics" | "writer" | "approval" | "review" | "findings" | "activity" | "help" | "queue_offer" | "queue" | "configuration" | "restore" | "reset_session" | "handoff" | "isolated" | null;
type ComposerMode = "flow" | "direct";
type InspectorTab = "changes" | "diff" | "file" | "findings";
const INSPECTOR_TABS: readonly InspectorTab[] = ["changes", "diff", "file", "findings"];
const FINDINGS_WINDOW = 6;
const QUEUE_WINDOW = 8;
const NOTICE_TTL_MS = 12_000;

/** A dispatch can raise an approval before its own promise resolves. Closing
 * the overlay unconditionally would then dismiss the approval inbox that the
 * approvals effect just opened, leaving the lane BLOCKED with nothing on
 * screen, so only the overlay we opened may be closed. */
export function overlayAfterDispatch(current: Overlay, expected: Overlay): Overlay {
  return current === expected ? null : current;
}

const ROLE_IDS: readonly RoleId[] = [
  "scout",
  "architect",
  "builder",
  "debugger",
  "intent_reviewer",
  "correctness_reviewer",
];

function modelSourceLabel(source: LaneSnapshot["modelSource"]): string {
  return source === "provider_default" ? "CLI default" : `${source} setting`;
}

function statusColor(status: LaneSnapshot["status"]): string {
  if (status === "FAILED" || status === "UNAVAILABLE") return "red";
  if (status === "RUNNING" || status === "STARTING") return "cyan";
  if (status === "BLOCKED" || status === "CANCELLING") return "yellow";
  if (status === "COMPLETED") return "green";
  return "gray";
}

function Lane({ lane, meta, focused, height, innerWidth, scrollOffset, compact = false }: { lane: LaneSnapshot; meta: MetaSessionSnapshot; focused: boolean; height: number; innerWidth: number; scrollOffset: number; compact?: boolean }) {
  const latestActivity = lane.activities.at(-1);
  const outputHeight = laneOutputRows(height, compact ? LANE_CHROME_COMPACT : LANE_CHROME_FULL, Boolean(lane.error));
  const viewport = scrollWindow(lane.output || (lane.error ? "" : "No output yet."), outputHeight, scrollOffset);
  const providerColor = lane.provider === "claude" ? "blue" : "green";
  return (
    <Box borderStyle="round" borderColor={focused ? "cyan" : "gray"} flexDirection="column" paddingX={1} height={height} flexGrow={1} overflow="hidden">
      <Box justifyContent="space-between">
        <Text bold color={providerColor}>{focused ? "●" : "○"} {lane.provider === "claude" ? "CLAUDE" : "CODEX"}</Text>
        <Text color={statusColor(lane.status)}>[{lane.status}]</Text>
      </Box>
      <Text dimColor wrap="truncate-end">model: requested {lane.requestedModel} ({modelSourceLabel(lane.modelSource)}) · effective {lane.effectiveModel ?? "pending"} · session: {lane.sessionId ? lane.sessionId.slice(0, 10) : "new"}{compact && viewport.offset > 0 ? ` · SCROLLED +${viewport.offset}/${viewport.maxOffset}` : ""}</Text>
      {!compact ? <>
        <Text wrap="truncate-end" color={meta.pendingEntries[lane.provider] ? "yellow" : "gray"}>shared: {meta.pendingEntries[lane.provider] ? `${meta.pendingEntries[lane.provider]} pending` : "synced"} · last {meta.lastInjectedBytes[lane.provider]} B</Text>
        <Text wrap="truncate-end" color={latestActivity?.status === "failed" ? "red" : latestActivity?.status === "blocked" ? "yellow" : "gray"}>
          {latestActivity ? `${latestActivity.kind} · ${latestActivity.status} · ${latestActivity.title}` : "activity · none"}
          {viewport.offset > 0 ? ` · SCROLLED +${viewport.offset}/${viewport.maxOffset}` : " · FOLLOW TAIL"}
        </Text>
      </> : null}
      <Text dimColor={!lane.output}>{fitLines(viewport.content, innerWidth, outputHeight)}</Text>
      {lane.error ? <Text color="red">{fitLines(`[${lane.errorKind?.toUpperCase() ?? "UNKNOWN"}] ${tailLines(lane.error, 1)}\n${providerErrorAction(lane.errorKind ?? "unknown")}`, innerWidth, 2)}</Text> : null}
    </Box>
  );
}

function Inspector({ snapshot, height, width, tab, focused, evidenceIndex }: { snapshot: AppSnapshot; height: number; width: number | undefined; tab: InspectorTab; focused: boolean; evidenceIndex: number }) {
  const git = snapshot.git;
  const review = snapshot.review;
  const bodyWidth = Math.max(10, (width ?? 80) - 4);
  let title = "CHANGES";
  let body = "";
  if (tab === "findings") {
    const findingsBody = (review?.findings ?? []).map((finding) => {
      const location = finding.file ? `${finding.file}${finding.lineStart ? `:${finding.lineStart}` : ""}` : "general";
      return `${finding.id === review?.activeFindingId ? ">" : " "}${finding.selected ? "[x]" : "[ ]"} ${finding.severity.toUpperCase()} · ${location}\n${finding.title}`;
    }).join("\n\n");
    const preview = review?.preview
      ? review.preview.error
        ? `PREVIEW · ${review.preview.file}\n${review.preview.error}`
        : `PREVIEW · ${review.preview.file}\n${review.preview.content}`
      : "";
    title = "FINDINGS";
    body = review ? [findingsBody || review.parseError || "No structured findings.", preview].filter(Boolean).join("\n\n") : "No review findings yet.";
  } else if (tab === "diff") {
    title = "DIFF";
    body = git.error ? git.error : git.diff || "No tracked staged or working-tree diff. Untracked files remain listed under CHANGES.";
  } else if (tab === "file") {
    title = "FILE";
    const preview = snapshot.evidencePreview;
    body = preview ? preview.error ? `${preview.file}\n${preview.error}` : `${preview.file}\n\n${preview.content}` : "Select a changed file with ↑/↓ while the inspector is focused.";
  } else {
    const evidence = git.evidence.map(({ path, classification }, index) => `${index === evidenceIndex ? ">" : " "} [${classification}] ${path}`);
    body = git.error ? git.error : evidence.length ? [evidence.join("\n"), git.diffStat].filter(Boolean).join("\n\n") : "Working tree clean";
  }
  const isolated = snapshot.isolated;
  if (tab === "changes" && isolated && isolated.lifecycle !== "preview" && isolated.lifecycle !== "cleaned") {
    title = "ISOLATED";
    body = (["claude", "codex"] as const).map((provider) => {
      const lane = isolated.lanes[provider];
      return `${provider.toUpperCase()} · ${lane.processState.toUpperCase()} · ${lane.dirty ? "DIRTY" : "CLEAN"}${lane.error ? " · UNREADABLE" : ""}\n${lane.branch}\n${lane.path}\nhead ${lane.head.slice(0, 12)}${lane.error ? `\n${lane.error}` : ""}`;
    }).join("\n\n");
  }
  const tabs = INSPECTOR_TABS.map((candidate) => candidate === tab ? `[${candidate.toUpperCase()}]` : candidate.toUpperCase()).join(" · ");
  return (
    <Box borderStyle="round" borderColor={focused ? "cyan" : "blue"} flexDirection="column" paddingX={1} height={height} width={width} flexGrow={1}>
      <Box flexDirection="column" flexShrink={0}>
        <Text bold color={focused ? "cyan" : "blue"}>CODE · {title} <Text dimColor>READ ONLY</Text></Text>
        <Text dimColor>{tabs}</Text>
        <Text dimColor>{git.branch} · {git.dirty ? "DIRTY" : "CLEAN"} · baseline {git.baselineFingerprint?.slice(0, 8) ?? "none"}</Text>
      </Box>
      <Text>{fitLines(body, bodyWidth, Math.max(2, height - 5))}</Text>
    </Box>
  );
}

function OverlayPanel({ overlay, snapshot, taskPrompt, modelProvider, modelDraft, roleIndex, writerProvider, writerConfirm, approvalIndex, approvalArmed, reviewCriteria, findingIndex, staleAcknowledged, activityIndex, activityExpanded, queueIndex, restoreInspect, destructiveConfirm, isolatedDiscardConfirm }: {
  overlay: Exclude<Overlay, null>;
  snapshot: AppSnapshot;
  taskPrompt: string;
  modelProvider: ProviderId;
  modelDraft: string;
  roleIndex: number;
  writerProvider: ProviderId;
  writerConfirm: boolean;
  approvalIndex: number;
  approvalArmed: boolean;
  reviewCriteria: string;
  findingIndex: number;
  staleAcknowledged: boolean;
  activityIndex: number;
  activityExpanded: boolean;
  queueIndex: number;
  restoreInspect: boolean;
  destructiveConfirm: boolean;
  isolatedDiscardConfirm: boolean;
}) {
  if (overlay === "flow_start") {
    const visibleDirtyFiles = snapshot.git.files.slice(0, 5);
    const unavailable = (["codex", "claude"] as const).filter((provider) => snapshot.lanes[provider].status === "UNAVAILABLE");
    return (
      <Box borderStyle="double" borderColor={unavailable.includes("codex") ? "red" : "cyan"} flexDirection="column" paddingX={1}>
        <Text bold>TASK FLOW · CODEX BUILD → CLAUDE CHALLENGE · {writerConfirm ? "CONFIRM" : "REVIEW"}</Text>
        {/* The composer starts in TASK FLOW, so this opens on the first Enter —
            including for someone who only meant to say something. Say why it is
            here before describing what it will do. */}
        <Text wrap="truncate-end">why: the composer is in TASK FLOW, where Enter starts an implementation task instead of sending a message.</Text>
        <Text>task: {tailLines(taskPrompt, 3)}</Text>
        <Text wrap="truncate-end">workspace: {snapshot.git.root || "not a Git repository"}</Text>
        <Text wrap="truncate-end">current changes: {snapshot.git.dirty ? `${visibleDirtyFiles.join(", ")}${snapshot.git.files.length > 5 ? ` (+${snapshot.git.files.length - 5} more)` : ""}` : "clean"}</Text>
        <Text color="yellow">Codex is the only writer · network off · completion prepares a separate Claude challenge confirmation.</Text>
        {unavailable.length ? <Text color="red">unavailable: {unavailable.join(" + ")} · run splitlane doctor · Ctrl+D shows the adapter error</Text> : null}
        <Text dimColor wrap="truncate-end">{unavailable.includes("codex")
          ? "Codex cannot build while unavailable · Esc close · Option+D uses direct mode"
          : writerConfirm ? "G grant Codex the writer lease and start the turn · Esc cancel" : "Enter review the grant · Option+D send as a direct prompt instead · Esc cancel"}</Text>
      </Box>
    );
  }
  if (overlay === "model") {
    return (
      <Box borderStyle="double" borderColor="yellow" flexDirection="column" paddingX={1}>
        <Text bold>MODEL · {modelProvider.toUpperCase()} · source {modelSourceLabel(snapshot.lanes[modelProvider].modelSource)}</Text>
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
        <Text>active handoff phase: {snapshot.handoffPhase}</Text>
        <Text dimColor>↑/↓ role · Tab provider · Enter apply · X reset handoff chain · Esc close</Text>
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
        <Text>writer: <Text color="cyan">{writerProvider.toUpperCase()}</Text> · requested model: {lane.requestedModel} · effective: {lane.effectiveModel ?? "pending"}</Text>
        <Text>root: {snapshot.git.root || "not a Git repository"}</Text>
        <Text>dirty: {snapshot.git.dirty ? `${visibleDirtyFiles.join(", ")}${remainingDirtyFiles > 0 ? ` (+${remainingDirtyFiles} more)` : ""}` : "clean"}</Text>
        <Text color="yellow">effect: workspace-write inside root · network off · peer remains read-only</Text>
        <Text dimColor>{writerConfirm ? "G grant the writer lease · Esc cancel" : "Tab writer · Enter review confirmation · Esc cancel"}</Text>
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
            <Text>kind/request: {approval.kind} · {approval.providerRequestId}</Text>
            <Text>command: {approval.command ?? "n/a"}</Text>
            <Text>cwd: {approval.cwd ?? "unknown"}</Text>
            <Text>paths: {approval.paths.length ? approval.paths.join(", ") : approval.path ?? "unknown"}</Text>
            <Text>reason: {approval.reason ?? "not provided"}</Text>
            <Text color={approval.outsideWorkspace ? "red" : "gray"}>boundary: {approval.outsideWorkspace ? "OUTSIDE WORKSPACE" : "inside/unknown"} · network {approval.networkEffect}</Text>
            <Text color="yellow">effect: one temporary decision · no persistent rule · no permission bypass</Text>
            {approvalArmed
              ? <Text color="red">Press A again to allow this request once · D deny · X cancel turn · Esc close</Text>
              : <Text dimColor>↑/↓ request · A allow once (confirms) · D deny · X cancel turn · Esc close</Text>}
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
        <Text dimColor>Type criteria · Tab mechanism · Enter single lens · Option+T two lenses · Esc keep build</Text>
      </Box>
    );
  }
  if (overlay === "findings") {
    const review = snapshot.review;
    const findings = review?.findings ?? [];
    const index = Math.min(findingIndex, Math.max(0, findings.length - 1));
    const finding = findings[index];
    const selectedCount = findings.filter((item) => item.selected).length;
    const start = Math.max(0, Math.min(index - 2, Math.max(0, findings.length - FINDINGS_WINDOW)));
    return (
      <Box borderStyle="double" borderColor={review?.stale ? "red" : "magenta"} flexDirection="column" paddingX={1}>
        <Text bold>REVIEW FINDINGS · {review?.status.toUpperCase() ?? "NONE"} · {review?.stale ? "STALE" : "CURRENT"} · {findings.length ? `${index + 1}/${findings.length}` : "0"} · {selectedCount} selected</Text>
        {review?.twoLens ? <Text wrap="truncate-end">lens: {review.activeLens.toUpperCase()} · Claude {review.lenses.claude?.status} · Codex {review.lenses.codex?.status} · never merged/graded</Text> : null}
        {findings.length ? findings.slice(start, start + FINDINGS_WINDOW).map((item, offset) => {
          const position = start + offset;
          const location = item.file ? `${item.file}${item.lineStart ? `:${item.lineStart}` : ""}` : "general";
          return <Text key={item.id} wrap="truncate-end" color={position === index ? "cyan" : item.severity === "blocker" || item.severity === "high" ? "red" : "white"}>
            {position === index ? ">" : " "} {item.selected ? "[x]" : "[ ]"} {item.severity.toUpperCase()} · {item.title} · {location}
          </Text>;
        }) : <Text wrap="truncate-end">{review?.parseError ?? (review?.status === "running" ? "Review is running…" : "No structured findings.")}</Text>}
        {findings.length > FINDINGS_WINDOW ? <Text dimColor>showing {start + 1}–{Math.min(findings.length, start + FINDINGS_WINDOW)} of {findings.length}</Text> : null}
        {finding ? <Box borderStyle="single" borderColor="gray" flexDirection="column" paddingX={1}>
          <Text>{tailLines(finding.body, 3)}</Text>
          {finding.verification ? <Text dimColor wrap="truncate-end">verify: {finding.verification}</Text> : null}
        </Box> : null}
        <Text dimColor wrap="truncate-end">{review?.twoLens ? "Tab lens · " : ""}↑/↓ finding · Space select · A accept · E exit · S stale ack ({staleAcknowledged ? "yes" : "no"}) · R return selected</Text>
      </Box>
    );
  }
  if (overlay === "activity") {
    const lane = snapshot.lanes[snapshot.focusedProvider];
    const activity = lane.activities[activityIndex] ?? lane.activities.at(-1);
    const start = Math.max(0, Math.min(activityIndex - 3, Math.max(0, lane.activities.length - 7)));
    return (
      <Box borderStyle="double" borderColor="cyan" flexDirection="column" paddingX={1}>
        <Text bold>{lane.provider.toUpperCase()} ACTIVITY · SANITIZED + BOUNDED · {lane.activities.length}</Text>
        {lane.activities.length ? lane.activities.slice(start, start + 7).map((item, offset) => {
          const index = start + offset;
          return <Text key={item.id} color={index === activityIndex ? "cyan" : item.status === "failed" ? "red" : "white"}>
            {index === activityIndex ? ">" : " "} {item.kind} · {item.status} · {item.title}
          </Text>;
        }) : <Text>No tool, file, approval, warning, or failure activity yet.</Text>}
        {activity && activityExpanded ? (
          <Box borderStyle="single" borderColor="gray" flexDirection="column" paddingX={1}>
            <Text>{activity.detail ?? "No provider detail."}</Text>
            {activity.safetyEffect ? <Text color="yellow">safety: {activity.safetyEffect}</Text> : null}
            <Text dimColor>{activity.timestamp}{activity.durationMs !== null ? ` · ${activity.durationMs} ms` : " · running"}</Text>
          </Box>
        ) : null}
        <Text dimColor>↑/↓ select · Space expand/collapse · Ctrl+T/Esc close</Text>
      </Box>
    );
  }
  if (overlay === "help") {
    return (
      <Box borderStyle="double" borderColor="green" flexDirection="column" paddingX={1}>
        <Text bold>HELP · CURRENT ACTIONS ARE ALWAYS VISIBLE</Text>
        <Text>Composer: Enter task flow · Option+D flow/direct (direct sends a prompt without granting write access)</Text>
        <Text>Direct: Enter send · Ctrl+R route Codex/Claude/Broadcast</Text>
        <Text>View: Option+0 both/focused · Option+1/2 focus only (send route unchanged)</Text>
        <Text>Lane: PgUp/PgDn scroll · Home oldest · End follow tail · Ctrl+X cancel</Text>
        <Text>Evidence: Option+I inspector · Tab focus · [/] tabs · ↑/↓ file · Ctrl+E recheck tree · Ctrl+T activity</Text>
        <Text>Workflow: Ctrl+B build then G to grant · Ctrl+W revoke · Ctrl+V review (Option+T two lenses) · Ctrl+F findings · Option+H handoff · Ctrl+L isolated</Text>
        <Text>Controls: Ctrl+A approvals · Ctrl+K queue · Option+M models · Ctrl+O roles · Ctrl+P capabilities · Ctrl+U config</Text>
        <Text>Lifecycle: Ctrl+D diagnostics · Ctrl+N reset focused session · Ctrl+Q close and exit · Esc closes modal</Text>
        <Text>Meta session: provider-only turns sync lazily; parallel peer results arrive next ordinary turn</Text>
        <Text color="yellow">Unavailable actions do nothing and preserve the current safety mode.</Text>
        <Text dimColor>Ctrl+G/Esc close</Text>
      </Box>
    );
  }
  if (overlay === "queue_offer") {
    const offer = snapshot.queueOffer;
    return (
      <Box borderStyle="double" borderColor="yellow" flexDirection="column" paddingX={1}>
        <Text bold>REQUEST CANNOT START NOW · NOTHING SENT</Text>
        {offer ? <>
          <Text>target: {offer.target.toUpperCase()} · lanes: {offer.providers.join(" + ")}</Text>
          <Text>mode/writer: {offer.mode} · {offer.writer ?? "none"} · authority frozen</Text>
          <Text>models: Claude {offer.models.claude} · Codex {offer.models.codex}</Text>
          <Text>{tailLines(offer.envelope.prompt, 3)}</Text>
          <Text color="yellow">Q queue whole request · C/Esc cancel</Text>
        </> : <Text>The pending choice expired. Esc close.</Text>}
      </Box>
    );
  }
  if (overlay === "queue") {
    const index = Math.min(queueIndex, Math.max(0, snapshot.queue.length - 1));
    const item = snapshot.queue[index] ?? snapshot.queue[0];
    // Without a window the selection disappears past the eighth entry while
    // D and C keep acting on it.
    const start = Math.max(0, Math.min(index - 2, Math.max(0, snapshot.queue.length - QUEUE_WINDOW)));
    return (
      <Box borderStyle="double" borderColor="cyan" flexDirection="column" paddingX={1}>
        <Text bold>REQUEST QUEUE · {snapshot.queue.length} GROUP(S) · LIMIT {snapshot.queueLimit}/LANE</Text>
        {snapshot.queue.length ? snapshot.queue.slice(start, start + QUEUE_WINDOW).map((candidate, offset) => {
          const position = start + offset;
          return <Text key={candidate.id} wrap="truncate-end" color={position === index ? "cyan" : candidate.status === "needs_confirmation" ? "yellow" : "white"}>
            {position === index ? ">" : " "} {candidate.id.slice(0, 8)} · {candidate.target} · {candidate.status} · {candidate.envelope.prompt.slice(0, 48)}
          </Text>;
        }) : <Text>Queue is empty.</Text>}
        {snapshot.queue.length > QUEUE_WINDOW ? <Text dimColor>showing {start + 1}–{Math.min(snapshot.queue.length, start + QUEUE_WINDOW)} of {snapshot.queue.length}</Text> : null}
        {item ? <Text dimColor>frozen: {item.mode}/{item.writer ?? "none"} · C {item.models.claude} · X {item.models.codex}</Text> : null}
        <Text dimColor>↑/↓ select · D remove selected · C confirm changed authority · Ctrl+K/Esc close</Text>
      </Box>
    );
  }
  if (overlay === "configuration") {
    const config = snapshot.configuration;
    return (
      <Box borderStyle="double" borderColor="green" flexDirection="column" paddingX={1}>
        <Text bold>CONFIGURATION · STRICT JSON · PROJECT OVERRIDES USER</Text>
        <Text>{config.loadedProject ? "LOADED" : "missing"} project: {config.projectPath}</Text>
        <Text>{config.loadedUser ? "LOADED" : "missing"} user: {config.userPath}</Text>
        <Text>queue limit: {snapshot.queueLimit} · tools: {config.showTools} · restore: {config.restoreSessions} · updates: {config.updateMode}</Text>
        <Text>preview capabilities: {config.allowPreview ? "enabled" : "disabled"}</Text>
        <Text>Claude model: {snapshot.lanes.claude.requestedModel} ({modelSourceLabel(snapshot.lanes.claude.modelSource)})</Text>
        <Text>Codex model: {snapshot.lanes.codex.requestedModel} ({modelSourceLabel(snapshot.lanes.codex.modelSource)})</Text>
        <Text color="yellow">Config is read-only in the TUI; Option+M creates a per-request model override.</Text>
        <Text dimColor>Ctrl+U/Esc close</Text>
      </Box>
    );
  }
  if (overlay === "restore") {
    return (
      <Box borderStyle="double" borderColor="yellow" flexDirection="column" paddingX={1}>
        <Text bold>RESTORE PROVIDER SESSIONS · METADATA ONLY · NO AUTHORITY</Text>
        {snapshot.restorableSessions.map((record) => <Text key={record.provider} color={record.interrupted ? "yellow" : "white"}>
          {record.provider.toUpperCase()} · {record.requestedModel} · {record.interrupted ? "INTERRUPTED" : "CLEAN"}{restoreInspect ? ` · child ${record.sessionId.slice(0, 12)} · meta ${record.metaSessionId?.slice(0, 8) ?? "legacy"} · ${record.updatedAt}` : ""}
        </Text>)}
        <Text color="yellow">{destructiveConfirm ? "Press R again to restore independently. Writer, queue, approvals, and mode stay reset." : "R restore · N start new · I inspect metadata"}</Text>
        <Text dimColor>Restore uses provider IDs; prompts and transcripts are never replayed.</Text>
      </Box>
    );
  }
  if (overlay === "reset_session") {
    const lane = snapshot.lanes[snapshot.focusedProvider];
    return (
      <Box borderStyle="double" borderColor="red" flexDirection="column" paddingX={1}>
        <Text bold>RESET {lane.provider.toUpperCase()} SPLITLANE SESSION</Text>
        <Text>session: {lane.sessionId?.slice(0, 12) ?? "new"} · model {lane.requestedModel}</Text>
        <Text>The other lane and provider-owned history are unchanged.</Text>
        <Text color="yellow">{destructiveConfirm ? "Press R again to remove this lane's metadata." : "R review confirmation · Esc close"}</Text>
      </Box>
    );
  }
  if (overlay === "handoff") {
    const packet = snapshot.handoff;
    return (
      <Box borderStyle="double" borderColor="magenta" flexDirection="column" paddingX={1}>
        <Text bold>ROLE HANDOFF · EXPLICIT BOUNDED PACKET · NO AUTO-DISPATCH</Text>
        {packet ? <>
          <Text>{packet.from.toUpperCase()} → {packet.to.toUpperCase()} · recommended {packet.recommendedProvider.toUpperCase()} · target unchanged</Text>
          <Text>objective: {tailLines(packet.objective, 2)}</Text>
          <Text>constraints: {packet.constraints.join(" · ")}</Text>
          <Text>files: {packet.relevantFiles.slice(0, 8).join(", ") || "none"}</Text>
          <Text>questions: {packet.openQuestions.slice(0, 3).join(" · ")}</Text>
          <Text>criteria: {packet.acceptanceCriteria.join(" · ")}</Text>
          <Text>source: {packet.sourceProvider} · session {packet.sourceSessionId?.slice(0, 12) ?? "new"} · baseline {packet.baselineFingerprint?.slice(0, 12) ?? "none"}</Text>
          <Text dimColor>Enter prepare shared prompt · Esc discard · sending remains a separate user action</Text>
        </> : <Text>Handoff packet unavailable. Esc close.</Text>}
      </Box>
    );
  }
  if (overlay === "isolated") {
    const run = snapshot.isolated;
    return (
      <Box borderStyle="double" borderColor="magenta" flexDirection="column" paddingX={1}>
        <Text bold>ISOLATED WORKTREES · EXPLICIT LIFECYCLE</Text>
        {run ? <>
          <Text>run: {run.runId} · {run.lifecycle.toUpperCase()} · base {run.baseCommit.slice(0, 12)}</Text>
          <Text>primary: {run.primaryRoot} · observational only</Text>
          {(["claude", "codex"] as const).map((provider) => {
            const lane = run.lanes[provider];
            const state = run.lifecycle === "preview" ? "PLANNED" : lane.present ? lane.dirty ? "DIRTY" : "CLEAN" : "NO DIRECTORY";
            return <Text key={provider}>{provider.toUpperCase()}: {lane.processState.toUpperCase()} · {state} · {lane.branch}{"\n"}  {lane.path}{lane.error ? ` · ${lane.error}` : ""}</Text>;
          })}
          {run.lifecycle === "preview" ? <Text color="yellow">Enter create both branches/worktrees · X/Esc discard preview</Text> : null}
          {run.lifecycle !== "preview" && run.lifecycle !== "cleaned" ? <Text color="yellow">{destructiveConfirm ? "Press C again to remove only clean, idle, integrated worktree directories." : "R inspect · K retain · C review clean-only cleanup (branches remain)"}</Text> : null}
          {run.lifecycle !== "preview" && run.lifecycle !== "cleaned" ? <Text dimColor>{isolatedDiscardConfirm ? "Press D again to stop tracking this run · nothing on disk is deleted" : "D stop tracking this run when cleanup cannot succeed (deletes nothing)"}</Text> : null}
          {run.lifecycle === "cleaned" ? <Text color="green">Worktree directories removed cleanly; branches remain for manual integration.</Text> : null}
          <Text dimColor>Inspect: git diff {run.baseCommit.slice(0, 12)}...{run.lanes.claude.branch}</Text>
          <Text dimColor>Inspect: git diff {run.baseCommit.slice(0, 12)}...{run.lanes.codex.branch}</Text>
          <Text color="yellow">No setup scripts, force removal, automatic merge, cherry-pick, or branch deletion.</Text>
        </> : <Text>No isolated plan. Ctrl+L prepares a preview after verifying a clean Git root.</Text>}
      </Box>
    );
  }
  return (
    <Box borderStyle="double" borderColor="yellow" flexDirection="column" paddingX={1}>
      <Text bold>CAPABILITIES · RUNTIME STATUS</Text>
      {snapshot.capabilities.map((capability) => (
        <Text key={capability.id} color={capability.status === "available" ? "white" : capability.status === "blocked" ? "yellow" : "gray"}>
          {capability.provider.toUpperCase()} · {capability.label} · {capability.access} [{capability.stability}] · {capability.status.toUpperCase()}{capability.reason ? ` · ${capability.reason}` : ""}
        </Text>
      ))}
      <Text dimColor>Status reflects local probes and preview policy · Esc/Ctrl+P close</Text>
    </Box>
  );
}

export function SplitlaneView({ snapshot, prompt, columns, rows, viewMode = "both", composerMode = "flow", overlay = null, modelProvider = "claude", modelDraft = "", roleIndex = 0, writerProvider = "claude", writerConfirm = false, approvalIndex = 0, approvalArmed = false, reviewCriteria = "", findingIndex = 0, staleAcknowledged = false, scrollOffsets = { claude: 0, codex: 0 }, activityIndex = 0, activityExpanded = false, queueIndex = 0, restoreInspect = false, destructiveConfirm = false, isolatedDiscardConfirm = false, inspectorTab = "changes", inspectorFocused = false, evidenceIndex = 0 }: {
  snapshot: AppSnapshot;
  prompt: string;
  columns: number;
  rows: number;
  viewMode?: ViewMode;
  composerMode?: ComposerMode;
  overlay?: Overlay;
  modelProvider?: ProviderId;
  modelDraft?: string;
  roleIndex?: number;
  writerProvider?: ProviderId;
  writerConfirm?: boolean;
  approvalIndex?: number;
  approvalArmed?: boolean;
  reviewCriteria?: string;
  findingIndex?: number;
  staleAcknowledged?: boolean;
  scrollOffsets?: Record<ProviderId, number>;
  activityIndex?: number;
  activityExpanded?: boolean;
  queueIndex?: number;
  restoreInspect?: boolean;
  destructiveConfirm?: boolean;
  isolatedDiscardConfirm?: boolean;
  inspectorTab?: InspectorTab;
  inspectorFocused?: boolean;
  evidenceIndex?: number;
}) {
  const layout = selectLayout(columns, viewMode);
  const compact = columns < 100;
  const compactBoth = compact && viewMode === "both";
  const heights = panelHeights(columns, rows, snapshot.inspectorVisible, Boolean(snapshot.notice), viewMode);
  const widths = panelWidths(columns, heights.showInspector, viewMode);
  const lanes = layout === "focused" ? [snapshot.focusedProvider] : (["claude", "codex"] as const);
  const outerDirection = layout === "focused" ? "column" : "row";
  const layoutLabel = viewMode === "both"
    ? heights.showInspector ? "DUAL + EVIDENCE" : "DUAL"
    : heights.showInspector ? "FOCUS + EVIDENCE" : "FOCUS";
  const roleSummary = ["S", "A", "B", "D", "IR", "CR"].map((label, index) => `${label}:${snapshot.roles[ROLE_IDS[index] ?? "scout"] === "claude" ? "C" : "X"}`).join(" ");
  const focusedLabel = snapshot.focusedProvider === "claude" ? "C" : "X";
  const sendLabel = snapshot.target === "both" ? "BROADCAST" : snapshot.target.toUpperCase();
  const composerLabel = composerMode === "flow" ? "TASK FLOW" : sendLabel;
  const writerLabel = snapshot.mode === "isolated" ? "EACH LANE" : snapshot.writer?.toUpperCase() ?? "NONE";
  const pausedWriter = snapshot.mode === "review" && snapshot.review ? ` · paused ${snapshot.review.writer === "claude" ? "C" : "X"}` : "";
  const footer = composerMode === "flow"
    ? "Enter build task · ⌥D direct prompt · ⌥0 view · ⌥1/2 lane · ^G help · ^Q quit"
    : "Enter send · ^R route · ⌥D build task · ⌥0 view · ⌥1/2 lane · ^G help · ^Q quit";
  const laneInnerWidth = Math.max(10, (layout === "focused" ? columns : widths.lanes) - 4);
  const requiredRows = minimumRows(Math.max(columns, MIN_COLUMNS), viewMode, Boolean(snapshot.notice));
  if (!fitsTerminal(columns, rows, viewMode, Boolean(snapshot.notice))) {
    return (
      <Box flexDirection="column" height={rows} overflow="hidden">
        <Text bold color="cyan" wrap="truncate-end">◆ SPLITLANE · TERMINAL TOO SMALL</Text>
        <Text wrap="truncate-end"><Text color="green">{snapshot.mode.toUpperCase()}</Text> · writer <Text color={snapshot.writer ? "yellow" : "gray"}>{writerLabel}</Text> · C [{snapshot.lanes.claude.status}] · X [{snapshot.lanes.codex.status}]</Text>
        <Text color="yellow" wrap="truncate-end">{columns}×{rows} · needs at least {Math.max(columns, MIN_COLUMNS)}×{requiredRows}</Text>
        <Text dimColor wrap="truncate-end">Resize the terminal · ^Q quit</Text>
      </Box>
    );
  }
  // A modal owns input, but the lanes it hides may still be running. Keep one
  // truncated status row per lane when the tallest overlay still leaves room
  // for the notice and footer.
  const showLaneStrip = Boolean(overlay) && rows >= requiredRows + 6;
  return (
    <Box flexDirection="column" height={rows} overflow="hidden">
      {compact ? <>
        <Text bold color="cyan" wrap="truncate-end">◆ SPLITLANE <Text dimColor>· VIEW {viewMode.toUpperCase()} · FOCUS {focusedLabel}</Text> · C <Text color={statusColor(snapshot.lanes.claude.status)}>[{snapshot.lanes.claude.status}]</Text> · X <Text color={statusColor(snapshot.lanes.codex.status)}>[{snapshot.lanes.codex.status}]</Text></Text>
        <Text wrap="truncate-end"><Text color="green">{snapshot.mode.toUpperCase()}</Text> · writer <Text color={snapshot.writer || snapshot.mode === "isolated" ? "yellow" : "gray"}>{writerLabel}{snapshot.writerRevoking ? " REVOKING" : ""}</Text>{pausedWriter} · {composerMode === "flow" ? "task" : "send"} <Text bold color={snapshot.target === "both" ? "yellow" : "cyan"}>{composerLabel}</Text> · approvals {snapshot.approvals.length} · queue {snapshot.queue.length}</Text>
        <Text wrap="truncate-end" color={snapshot.metaSession.pendingEntries.claude || snapshot.metaSession.pendingEntries.codex ? "yellow" : "gray"}>meta <Text bold>{snapshot.metaSession.id.slice(0, 8)}</Text>/e{snapshot.metaSession.epoch}{snapshot.metaSession.restoredEpoch ? " RESTORED" : ""} · turns {snapshot.metaSession.turnCount} · pending C{snapshot.metaSession.pendingEntries.claude}/X{snapshot.metaSession.pendingEntries.codex} · memory {snapshot.metaSession.retainedBytes} B</Text>
        <Text dimColor wrap="truncate-end">{composerMode === "flow" ? "flow CODEX → CLAUDE · manual" : `direct ${sendLabel} · ^R route · ⌥D flow`} · roles {roleSummary}</Text>
      </> : <>
        <Box justifyContent="space-between" flexDirection="row">
          <Text bold color="cyan" wrap="truncate-end">◆ SPLITLANE <Text dimColor>· VIEW {viewMode.toUpperCase()} · {layoutLabel}</Text></Text>
          <Text wrap="truncate-end"><Text color="green">{snapshot.mode.toUpperCase()}</Text> · writer <Text color={snapshot.writer || snapshot.mode === "isolated" ? "yellow" : "gray"}>{writerLabel}{snapshot.writerRevoking ? " (REVOKING)" : ""}</Text>{snapshot.mode === "review" && snapshot.review ? <Text> · paused <Text color="yellow">{snapshot.review.writer.toUpperCase()}</Text></Text> : null} · {composerMode === "flow" ? "task" : "send"} <Text bold color={snapshot.target === "both" ? "yellow" : "cyan"}>{composerLabel}</Text> · approvals <Text color={snapshot.approvals.length ? "yellow" : "gray"}>{snapshot.approvals.length}</Text> · queue <Text color={snapshot.queue.length ? "yellow" : "gray"}>{snapshot.queue.length}</Text></Text>
        </Box>
        <Text wrap="truncate-end" color={snapshot.metaSession.pendingEntries.claude || snapshot.metaSession.pendingEntries.codex ? "yellow" : "gray"}>meta <Text bold>{snapshot.metaSession.id.slice(0, 8)}</Text>/e{snapshot.metaSession.epoch}{snapshot.metaSession.restoredEpoch ? " RESTORED" : ""} · turns {snapshot.metaSession.turnCount} · memory {snapshot.metaSession.retainedBytes} B · pending C{snapshot.metaSession.pendingEntries.claude}/X{snapshot.metaSession.pendingEntries.codex} · C <Text color={statusColor(snapshot.lanes.claude.status)}>[{snapshot.lanes.claude.status}]</Text> · X <Text color={statusColor(snapshot.lanes.codex.status)}>[{snapshot.lanes.codex.status}]</Text></Text>
        <Text dimColor wrap="truncate-end">{composerMode === "flow" ? "flow CODEX BUILD → CLAUDE CHALLENGE · manual gates" : `direct route ${sendLabel} · ^R change · ⌥D task flow`} · roles {roleSummary} · ^O edit</Text>
      </>}
      {showLaneStrip ? (["claude", "codex"] as const).map((provider) => {
        const lane = snapshot.lanes[provider];
        const activity = lane.activities.at(-1);
        const detail = activity ? `${activity.kind} · ${activity.status} · ${activity.title}` : tailLines(lane.output, 1) || "no output yet";
        return <Text key={provider} wrap="truncate-end" dimColor={lane.status === "READY"}>
          {provider === "claude" ? "C" : "X"} <Text color={statusColor(lane.status)}>[{lane.status}]</Text> {detail}
        </Text>;
      }) : null}
      {overlay ? <OverlayPanel overlay={overlay} snapshot={snapshot} taskPrompt={prompt} modelProvider={modelProvider} modelDraft={modelDraft} roleIndex={roleIndex} writerProvider={writerProvider} writerConfirm={writerConfirm} approvalIndex={approvalIndex} approvalArmed={approvalArmed} reviewCriteria={reviewCriteria} findingIndex={findingIndex} staleAcknowledged={staleAcknowledged} activityIndex={activityIndex} activityExpanded={activityExpanded} queueIndex={queueIndex} restoreInspect={restoreInspect} destructiveConfirm={destructiveConfirm} isolatedDiscardConfirm={isolatedDiscardConfirm} /> : (
        <Box flexDirection={outerDirection} gap={1} height={heights.content} overflow="hidden">
          <Box flexDirection="column" width={layout === "focused" ? undefined : widths.lanes} flexGrow={heights.showInspector ? 2 : 1} gap={1}>
            {lanes.map((provider) => <Lane key={provider} lane={snapshot.lanes[provider]} meta={snapshot.metaSession} focused={snapshot.focusedProvider === provider} height={heights.lane} innerWidth={laneInnerWidth} scrollOffset={scrollOffsets[provider]} compact={compactBoth} />)}
          </Box>
          {heights.showInspector ? <Inspector snapshot={snapshot} height={heights.inspector} width={layout === "focused" ? undefined : widths.inspector} tab={inspectorTab} focused={inspectorFocused} evidenceIndex={evidenceIndex} /> : null}
        </Box>
      )}
      {overlay ? <>
        {snapshot.notice ? <Text color="yellow" wrap="truncate-end">{snapshot.notice}</Text> : null}
        <Text dimColor wrap="truncate-end">Modal open · follow the actions above · Esc close · ^Q quit{overlay !== "approval" && snapshot.approvals.length ? ` · ${snapshot.approvals.length} approval(s) waiting on ^A` : ""}</Text>
      </> : <>
        <Box borderStyle="round" borderColor={composerMode === "flow" ? "cyan" : snapshot.target === "both" ? "yellow" : "blue"} paddingX={1}>
          <Text bold color={composerMode === "flow" ? "cyan" : snapshot.target === "both" ? "yellow" : "blue"}> {composerLabel} </Text><Text wrap="truncate-start" dimColor={!prompt}>{prompt || (composerMode === "flow" ? "Describe the implementation task…" : "Type a direct prompt…")}</Text>
        </Box>
        {snapshot.notice ? <Text color="yellow" wrap="truncate-end">{snapshot.notice}</Text> : null}
        <Text dimColor wrap="truncate-end">{footer}</Text>
      </>}
    </Box>
  );
}

export function App({ orchestrator, onBeforeExit }: { orchestrator: CompareOrchestrator; onBeforeExit?: () => Promise<void> }) {
  const snapshot = useSyncExternalStore(orchestrator.subscribe, orchestrator.getSnapshot, orchestrator.getSnapshot);
  const { columns, rows } = useWindowSize();
  const { exit } = useApp();
  const [prompt, setPrompt] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("both");
  // Read-only is the safe default everywhere else in the initial state (compare
  // mode, writer NONE), so the composer starts read-only too. See
  // docs/PRODUCT_PLAN.md.
  const [composerMode, setComposerMode] = useState<ComposerMode>("direct");
  const [guidedBuildActive, setGuidedBuildActive] = useState(false);
  const [overlay, setOverlay] = useState<Overlay>(() => snapshot.restorableSessions.length ? "restore" : null);
  const [modelProvider, setModelProvider] = useState<ProviderId>(snapshot.focusedProvider);
  const [modelDraft, setModelDraft] = useState("");
  const [roleIndex, setRoleIndex] = useState(0);
  const [roleProvider, setRoleProvider] = useState<ProviderId>("claude");
  const [writerProvider, setWriterProvider] = useState<ProviderId>(snapshot.focusedProvider);
  const [writerConfirm, setWriterConfirm] = useState(false);
  const [approvalIndex, setApprovalIndex] = useState(0);
  const [armedApproval, setArmedApproval] = useState<string | null>(null);
  const dismissedApprovalCount = useRef(0);
  const [reviewCriteria, setReviewCriteria] = useState("");
  const [findingIndex, setFindingIndex] = useState(0);
  const [staleAcknowledged, setStaleAcknowledged] = useState(false);
  const [scrollOffsets, setScrollOffsets] = useState<Record<ProviderId, number>>({ claude: 0, codex: 0 });
  const previousLineCounts = useRef<Record<ProviderId, number>>({ claude: 0, codex: 0 });
  const [activityIndex, setActivityIndex] = useState(0);
  const [activityExpanded, setActivityExpanded] = useState(snapshot.configuration.showTools === "expanded");
  const [queueIndex, setQueueIndex] = useState(0);
  const [restoreInspect, setRestoreInspect] = useState(false);
  const [destructiveConfirm, setDestructiveConfirm] = useState(false);
  const [isolatedDiscardConfirm, setIsolatedDiscardConfirm] = useState(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("changes");
  const [inspectorFocused, setInspectorFocused] = useState(false);
  const [evidenceIndex, setEvidenceIndex] = useState(0);

  useEffect(() => {
    const counts: Record<ProviderId, number> = {
      claude: lineCount(snapshot.lanes.claude.output),
      codex: lineCount(snapshot.lanes.codex.output),
    };
    setScrollOffsets((current) => ({
      claude: current.claude > 0
        ? counts.claude < previousLineCounts.current.claude
          ? 0
          : current.claude + counts.claude - previousLineCounts.current.claude
        : 0,
      codex: current.codex > 0
        ? counts.codex < previousLineCounts.current.codex
          ? 0
          : current.codex + counts.codex - previousLineCounts.current.codex
        : 0,
    }));
    previousLineCounts.current = counts;
  }, [snapshot.lanes.claude.output, snapshot.lanes.codex.output]);

  // An approval must never take input away from an overlay that already owns
  // it: the draft would be lost and the single-key decisions would land under
  // fingers that were typing something else. The inbox waits for input to be
  // free instead, which is why `overlay` is a dependency here.
  useEffect(() => {
    if (snapshot.approvals.length > 0) {
      setApprovalIndex((index) => Math.min(index, snapshot.approvals.length - 1));
      if (overlay === null && dismissedApprovalCount.current !== snapshot.approvals.length) setOverlay("approval");
    } else if (overlay === "approval") setOverlay(null);
  }, [snapshot.approvals.length, overlay]);

  useEffect(() => {
    if (snapshot.queueOffer) setOverlay("queue_offer");
    else if (overlay === "queue_offer") setOverlay(null);
  }, [snapshot.queueOffer]);

  useEffect(() => {
    if (snapshot.restorableSessions.length) setOverlay("restore");
  }, [snapshot.restorableSessions.length]);

  useEffect(() => {
    if (snapshot.mode === "review" && snapshot.review && snapshot.review.status !== "running") {
      setFindingIndex(0);
      setStaleAcknowledged(false);
      setOverlay("findings");
      const first = snapshot.review.findings[0];
      if (first) void orchestrator.selectFinding(first.id);
    }
  }, [snapshot.review?.status]);

  useEffect(() => {
    setEvidenceIndex((index) => Math.min(index, Math.max(0, snapshot.git.files.length - 1)));
  }, [snapshot.git.files.join("\0")]);

  useEffect(() => {
    setQueueIndex((index) => Math.min(index, Math.max(0, snapshot.queue.length - 1)));
  }, [snapshot.queue.length]);

  useEffect(() => {
    if (!snapshot.notice) return;
    const timer = setTimeout(() => orchestrator.clearNotice(), NOTICE_TTL_MS);
    return () => clearTimeout(timer);
  }, [snapshot.notice]);

  useEffect(() => {
    if (!guidedBuildActive) return;
    const status = snapshot.lanes.codex.status;
    if (status === "COMPLETED" && snapshot.mode === "build" && snapshot.writer === "codex") {
      setGuidedBuildActive(false);
      setReviewCriteria("");
      void orchestrator.prepareReview().then((ready) => {
        if (ready) setOverlay("review");
      });
    } else if (["FAILED", "CANCELLED", "UNAVAILABLE"].includes(status)) {
      setGuidedBuildActive(false);
      orchestrator.showNotice(`Task flow stopped after Codex ${status.toLowerCase()}; Claude challenge was not started.`);
    }
  }, [guidedBuildActive, snapshot.lanes.codex.status, snapshot.mode, snapshot.writer]);

  const closeOverlayIfStill = (expected: Overlay) => setOverlay((current) => overlayAfterDispatch(current, expected));
  const inspectorShown = panelHeights(columns, rows, snapshot.inspectorVisible, Boolean(snapshot.notice), viewMode).showInspector;

  // A resize can take the inspector off screen while it still holds focus,
  // which would leave the keyboard looking dead with nothing on screen to
  // explain why.
  useEffect(() => {
    if (inspectorFocused && !inspectorShown) setInspectorFocused(false);
  }, [inspectorFocused, inspectorShown]);

  useInput((input, key) => {
    if (key.ctrl && input === "q") {
      void Promise.allSettled([orchestrator.close(), onBeforeExit?.()]).finally(exit);
      return;
    }
    if (key.escape && !overlay && inspectorFocused) {
      setInspectorFocused(false);
      return;
    }
    if (key.escape) {
      if (overlay === "queue_offer") orchestrator.cancelQueueOffer();
      if (overlay === "handoff") orchestrator.cancelRoleHandoff();
      if (overlay === "isolated" && snapshot.isolated?.lifecycle === "preview") orchestrator.cancelIsolatedPlan();
      // Remember the dismissal so the inbox effect does not immediately
      // reopen the overlay the user just closed.
      if (overlay === "approval") dismissedApprovalCount.current = snapshot.approvals.length;
      setOverlay(null);
      setWriterConfirm(false);
      setDestructiveConfirm(false);
      setIsolatedDiscardConfirm(false);
      setArmedApproval(null);
      return;
    }
    if (overlay === "help") {
      if (key.ctrl && input === "g") setOverlay(null);
      return;
    }
    if (overlay === "flow_start") {
      if (key.meta && input.toLowerCase() === "d") {
        setComposerMode("direct");
        setOverlay(null);
        setWriterConfirm(false);
      } else if (key.return && !writerConfirm) setWriterConfirm(true);
      // The last step grants write authority and starts a paid turn, so it does
      // not share a key with the step before it. Three identical presses used to
      // take a typed line all the way from the composer to a granted lease.
      else if (input.toLowerCase() === "g" && writerConfirm) {
        void orchestrator.startGuidedBuild(prompt, snapshot.git.dirty).then((started) => {
          if (started) {
            setPrompt("");
            setGuidedBuildActive(true);
            closeOverlayIfStill("flow_start");
            setWriterConfirm(false);
          }
        });
      }
      return;
    }
    if (overlay === "activity") {
      const activities = snapshot.lanes[snapshot.focusedProvider].activities;
      if (key.upArrow) setActivityIndex((index) => Math.max(0, index - 1));
      else if (key.downArrow) setActivityIndex((index) => Math.min(Math.max(0, activities.length - 1), index + 1));
      else if (input === " ") setActivityExpanded((value) => !value);
      else if (key.ctrl && input === "t") setOverlay(null);
      return;
    }
    if (overlay === "queue_offer") {
      if (input.toLowerCase() === "q" && orchestrator.confirmQueueOffer()) {
        setPrompt("");
        setOverlay(null);
      } else if (input.toLowerCase() === "c") {
        orchestrator.cancelQueueOffer();
        setOverlay(null);
      }
      return;
    }
    if (overlay === "queue") {
      const count = Math.max(1, snapshot.queue.length);
      if (key.upArrow) setQueueIndex((index) => (Math.min(index, count - 1) - 1 + count) % count);
      else if (key.downArrow) setQueueIndex((index) => (Math.min(index, count - 1) + 1) % count);
      else {
        const item = snapshot.queue[Math.min(queueIndex, count - 1)] ?? snapshot.queue[0];
        if (item && input.toLowerCase() === "d") orchestrator.removeQueued(item.id);
        else if (item && input.toLowerCase() === "c") orchestrator.confirmQueued(item.id);
      }
      return;
    }
    if (overlay === "configuration") {
      if (key.ctrl && input === "u") setOverlay(null);
      return;
    }
    if (overlay === "restore") {
      if (input.toLowerCase() === "i") setRestoreInspect((value) => !value);
      else if (input.toLowerCase() === "n") void orchestrator.startNewSessions().then(() => setOverlay(null));
      else if (input.toLowerCase() === "r" && !destructiveConfirm) setDestructiveConfirm(true);
      else if (input.toLowerCase() === "r") void orchestrator.restoreSessions().then(() => { setOverlay(null); setDestructiveConfirm(false); });
      return;
    }
    if (overlay === "reset_session") {
      if (input.toLowerCase() === "r" && !destructiveConfirm) setDestructiveConfirm(true);
      else if (input.toLowerCase() === "r") void orchestrator.resetSession(snapshot.focusedProvider).then((reset) => { if (reset) setOverlay(null); setDestructiveConfirm(false); });
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
      else if (input.toLowerCase() === "x") orchestrator.resetRoleHandoffChain();
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
      // Granting write authority does not share a key with reaching the
      // confirmation, for the same reason as the task-flow gate.
      else if (input.toLowerCase() === "g" && writerConfirm) {
        void orchestrator.promoteWriter(writerProvider, snapshot.git.dirty).then((promoted) => {
          if (promoted) {
            closeOverlayIfStill("writer");
            setWriterConfirm(false);
          }
        });
      }
      return;
    }
    if (overlay === "approval") {
      const count = Math.max(1, snapshot.approvals.length);
      if (key.upArrow) {
        setApprovalIndex((index) => (index - 1 + count) % count);
        setArmedApproval(null);
      } else if (key.downArrow) {
        setApprovalIndex((index) => (index + 1) % count);
        setArmedApproval(null);
      } else {
        const approval = snapshot.approvals[approvalIndex] ?? snapshot.approvals[0];
        // Granting authority is the one decision here that is not fail-closed,
        // so it takes a second deliberate keystroke on the same request. Deny
        // and cancel stay single-key because they only ever withhold authority.
        if (approval && input.toLowerCase() === "a") {
          if (armedApproval === approval.id) {
            orchestrator.resolveApproval(approval.id, "allow_once");
            setArmedApproval(null);
          } else setArmedApproval(approval.id);
        } else if (approval && input.toLowerCase() === "d") {
          orchestrator.resolveApproval(approval.id, "deny");
          setArmedApproval(null);
        } else if (approval && input.toLowerCase() === "x") {
          orchestrator.resolveApproval(approval.id, "cancel_turn");
          setArmedApproval(null);
        }
      }
      return;
    }
    if (overlay === "review") {
      if (key.tab && snapshot.review) {
        const mechanisms = snapshot.review.availableMechanisms;
        const index = mechanisms.indexOf(snapshot.review.mechanism);
        const next = mechanisms[(index + 1) % mechanisms.length];
        if (next) orchestrator.setReviewMechanism(next);
      } else if (key.meta && input.toLowerCase() === "t") {
        void orchestrator.startTwoLensReview(reviewCriteria).then((started) => { if (started) closeOverlayIfStill("review"); });
      } else if (key.return) {
        void orchestrator.startReview(reviewCriteria).then((started) => { if (started) closeOverlayIfStill("review"); });
      } else if (key.backspace || key.delete) setReviewCriteria(removeLastGrapheme(reviewCriteria));
      else if (!key.ctrl && !key.meta) setReviewCriteria((current) => current + input);
      return;
    }
    if (overlay === "findings") {
      const count = Math.max(1, snapshot.review?.findings.length ?? 0);
      if (key.tab && snapshot.review?.twoLens) {
        const next = snapshot.review.activeLens === "claude" ? "codex" : "claude";
        orchestrator.selectReviewLens(next);
        setFindingIndex(0);
      } else if (key.upArrow) {
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
    if (overlay === "handoff") {
      if (key.return) {
        const handoffPrompt = orchestrator.confirmRoleHandoff();
        if (handoffPrompt) {
          setPrompt(handoffPrompt);
          setOverlay(null);
        }
      }
      return;
    }
    if (overlay === "isolated") {
      const lifecycle = snapshot.isolated?.lifecycle;
      if (key.return && lifecycle === "preview") {
        void orchestrator.startIsolated();
      } else if (input.toLowerCase() === "x" && lifecycle === "preview") {
        orchestrator.cancelIsolatedPlan();
        setOverlay(null);
      } else if (input.toLowerCase() === "r" && lifecycle && lifecycle !== "preview" && lifecycle !== "cleaned") {
        void orchestrator.refreshIsolated();
      } else if (input.toLowerCase() === "k" && lifecycle && lifecycle !== "preview" && lifecycle !== "cleaned") {
        void orchestrator.retainIsolated();
      } else if (input.toLowerCase() === "c" && lifecycle && lifecycle !== "preview" && lifecycle !== "cleaned") {
        setIsolatedDiscardConfirm(false);
        if (!destructiveConfirm) setDestructiveConfirm(true);
        else void orchestrator.cleanupIsolated().then(() => setDestructiveConfirm(false));
      } else if (input.toLowerCase() === "d" && lifecycle && lifecycle !== "preview" && lifecycle !== "cleaned") {
        setDestructiveConfirm(false);
        if (!isolatedDiscardConfirm) setIsolatedDiscardConfirm(true);
        else {
          void orchestrator.discardIsolated().then((discarded) => {
            setIsolatedDiscardConfirm(false);
            if (discarded) closeOverlayIfStill("isolated");
          });
        }
      }
      return;
    }
    // The inspector consumes only its own navigation keys. Anything else must
    // still reach the global handlers below; swallowing every key would disable
    // help, the approval inbox, and lane cancellation while a read-only panel
    // happens to hold focus.
    if (inspectorFocused) {
      if (key.tab) {
        setInspectorFocused(false);
        return;
      }
      if (input === "[" || input === "]") {
        setInspectorTab((current) => {
          const index = INSPECTOR_TABS.indexOf(current);
          const offset = input === "]" ? 1 : -1;
          return INSPECTOR_TABS[(index + offset + INSPECTOR_TABS.length) % INSPECTOR_TABS.length] ?? "changes";
        });
        return;
      }
      if (key.upArrow || key.downArrow) {
        const count = snapshot.git.files.length;
        if (count) {
          const next = Math.max(0, Math.min(count - 1, evidenceIndex + (key.downArrow ? 1 : -1)));
          setEvidenceIndex(next);
          setInspectorTab("file");
          void orchestrator.selectEvidenceFile(snapshot.git.files[next]!);
        } else orchestrator.showNotice("No changed files to preview. ^E rechecks the working tree.");
        return;
      }
    }
    if (key.tab) {
      if (inspectorShown) {
        setInspectorFocused(true);
        const path = snapshot.git.files[evidenceIndex];
        if (path) void orchestrator.selectEvidenceFile(path);
      } else {
        orchestrator.showNotice(snapshot.inspectorVisible
          ? `The evidence inspector needs 100+ columns before Tab can focus it; this terminal is ${columns}. Option+0 focuses one lane.`
          : "The evidence inspector is hidden. Option+I shows it, then Tab focuses it.");
      }
      return;
    }
    if (key.pageUp || key.pageDown || key.home || key.end) {
      const provider = snapshot.focusedProvider;
      const lane = snapshot.lanes[provider];
      const viewportHeight = laneOutputHeight(columns, rows, snapshot.inspectorVisible, Boolean(lane.error), Boolean(snapshot.notice), viewMode);
      const maximum = maxScrollOffset(lane.output, viewportHeight);
      const page = Math.max(1, viewportHeight - 1);
      setScrollOffsets((current) => ({
        ...current,
        [provider]: key.end
          ? 0
          : key.home
            ? maximum
            : key.pageUp
              ? Math.min(maximum, current[provider] + page)
              : Math.max(0, current[provider] - page),
      }));
    } else if (key.meta && input.toLowerCase() === "d") {
      const next = composerMode === "flow" ? "direct" : "flow";
      setComposerMode(next);
      if (next === "flow") {
        // Task flow always builds with Codex. Say that the route and focus moved
        // rather than changing them silently, since every other route change is
        // something the user asked for explicitly.
        const moved = snapshot.target !== "codex" || snapshot.focusedProvider !== "codex";
        orchestrator.focus("codex");
        orchestrator.setTarget("codex");
        if (moved) orchestrator.showNotice("Task flow builds with Codex, so the send route and lane focus moved to Codex.");
      }
    }
    else if (key.meta && input === "0") setViewMode((current) => current === "both" ? "focused" : "both");
    else if (key.meta && input === "1") {
      orchestrator.focus("claude");
    }
    else if (key.meta && input === "2") {
      orchestrator.focus("codex");
    }
    else if (key.ctrl && input === "r") {
      setComposerMode("direct");
      orchestrator.cycleTarget();
    }
    else if (key.ctrl && input === "x") void orchestrator.cancel(snapshot.focusedProvider);
    else if (key.meta && input.toLowerCase() === "i") {
      // The width warning belongs only to the turn-on direction; deliberately
      // hiding the inspector is never a failure to show it.
      const turningOn = !snapshot.inspectorVisible;
      if (!turningOn) setInspectorFocused(false);
      orchestrator.toggleInspector();
      if (!turningOn) return;
      if (panelHeights(columns, rows, true, Boolean(snapshot.notice), viewMode).showInspector) void orchestrator.refreshEvidence();
      else orchestrator.showNotice(`Evidence inspector needs 100+ columns; this terminal is ${columns}. Option+0 focuses one lane.`);
    }
    else if (key.ctrl && input === "e") void orchestrator.refreshEvidence();
    else if (key.ctrl && input === "v") {
      setReviewCriteria("");
      void orchestrator.prepareReview().then((ready) => { if (ready) setOverlay("review"); });
    } else if (key.ctrl && input === "f") {
      if (!snapshot.review) {
        orchestrator.showNotice("Review findings are available only after a review draft or completed review exists.");
        return;
      }
      setFindingIndex(0);
      setStaleAcknowledged(false);
      setOverlay("findings");
      const first = snapshot.review.findings[0];
      if (first) void orchestrator.selectFinding(first.id);
    } else if (key.ctrl && input === "b") {
      if (snapshot.mode !== "compare") {
        orchestrator.showNotice("Writer promotion is available only from compare mode.");
        return;
      }
      setWriterProvider(snapshot.focusedProvider);
      setWriterConfirm(false);
      setOverlay("writer");
    } else if (key.ctrl && input === "w") {
      if (snapshot.writer) void orchestrator.revokeWriter();
      else orchestrator.showNotice("There is no writer lease to revoke.");
    }
    else if (key.ctrl && input === "a") {
      setApprovalIndex(0);
      setArmedApproval(null);
      dismissedApprovalCount.current = 0;
      setOverlay("approval");
    }
    else if (key.meta && input.toLowerCase() === "m") {
      setModelProvider(snapshot.focusedProvider);
      setModelDraft(snapshot.lanes[snapshot.focusedProvider].requestedModel);
      setOverlay("model");
    } else if (key.ctrl && input === "p") setOverlay("actions");
    else if (key.ctrl && input === "g") setOverlay("help");
    else if (key.ctrl && input === "t") {
      const activities = snapshot.lanes[snapshot.focusedProvider].activities;
      setActivityIndex(Math.max(0, activities.length - 1));
      setActivityExpanded(snapshot.configuration.showTools === "expanded");
      setOverlay("activity");
    }
    else if (key.ctrl && input === "k") {
      setQueueIndex(0);
      setOverlay("queue");
    }
    else if (key.ctrl && input === "u") setOverlay("configuration");
    else if (key.ctrl && input === "n") {
      setDestructiveConfirm(false);
      setOverlay("reset_session");
    }
    else if (key.meta && input.toLowerCase() === "h") {
      void orchestrator.prepareRoleHandoff(prompt).then((ready) => { if (ready) setOverlay("handoff"); });
    }
    else if (key.ctrl && input === "l") {
      setDestructiveConfirm(false);
      setIsolatedDiscardConfirm(false);
      if (snapshot.isolated && snapshot.isolated.lifecycle !== "cleaned") setOverlay("isolated");
      else void orchestrator.prepareIsolated().then((ready) => { if (ready) setOverlay("isolated"); });
    }
    else if (key.ctrl && input === "d") setOverlay("diagnostics");
    else if (key.ctrl && input === "o") {
      setRoleProvider(snapshot.roles[ROLE_IDS[roleIndex] ?? "scout"]);
      setOverlay("roles");
    } else if (key.return) {
      if (composerMode === "flow") {
        if (!prompt.trim()) orchestrator.showNotice("Task is empty.");
        else if (snapshot.mode !== "compare") orchestrator.showNotice("Task Flow starts only from compare mode; finish or revoke the current workflow first.");
        else {
          setWriterConfirm(false);
          setOverlay("flow_start");
        }
      } else void orchestrator.dispatch(prompt).then((sent) => { if (sent) setPrompt(""); });
    } else if (key.backspace || key.delete) setPrompt(removeLastGrapheme(prompt));
    else if (!key.ctrl && !key.meta && input) setPrompt((current) => current + input);
  });

  return <SplitlaneView snapshot={snapshot} prompt={prompt} columns={columns} rows={rows} viewMode={viewMode} composerMode={composerMode} overlay={overlay} modelProvider={modelProvider} modelDraft={modelDraft} roleIndex={roleIndex} writerProvider={writerProvider} writerConfirm={writerConfirm} approvalIndex={approvalIndex} approvalArmed={armedApproval !== null} reviewCriteria={reviewCriteria} findingIndex={findingIndex} staleAcknowledged={staleAcknowledged} scrollOffsets={scrollOffsets} activityIndex={activityIndex} activityExpanded={activityExpanded} queueIndex={queueIndex} restoreInspect={restoreInspect} destructiveConfirm={destructiveConfirm} isolatedDiscardConfirm={isolatedDiscardConfirm} inspectorTab={inspectorTab} inspectorFocused={inspectorFocused} evidenceIndex={evidenceIndex} />;
}
