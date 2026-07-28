import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import type { AppSnapshot, LaneSnapshot, MetaSessionSnapshot, ProviderId, RoleId } from "../domain.ts";
import type { CompareOrchestrator } from "../core/orchestrator.ts";
import { providerErrorAction } from "../core/provider-error.ts";
import { fitsTerminal, LANE_CHROME_COMPACT, LANE_CHROME_FULL, laneOutputHeight, laneOutputRows, minimumRows, MIN_COLUMNS, panelHeights, panelWidths, selectLayout, type ViewMode } from "./layout.ts";
import { fitLines, lineCount, maxScrollOffset, scrollWindow, tailLines } from "./text.ts";
import {
  initialState,
  INSPECTOR_TABS,
  overlayAfterDispatch,
  reduce,
  ROLE_IDS,
  type ComposerMode,
  type InspectorTab,
  type Intent,
  type InteractionCommand,
  type InteractionContext,
  type Overlay,
} from "./interaction.ts";
import { isViewportIntent, resolveIntent, type ViewportIntent } from "./keymap.ts";

// Re-exported because the state machine, not the view, owns this rule.
export { overlayAfterDispatch };

const FINDINGS_WINDOW = 6;
const QUEUE_WINDOW = 8;
const NOTICE_TTL_MS = 12_000;

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
  // Interaction lives in the shared state machine; only viewport state, which
  // needs terminal geometry, stays here. See src/ui/interaction.ts.
  const [state, setState] = useState(() => initialState(snapshot));
  const [viewMode, setViewMode] = useState<ViewMode>("both");
  const [scrollOffsets, setScrollOffsets] = useState<Record<ProviderId, number>>({ claude: 0, codex: 0 });
  const previousLineCounts = useRef<Record<ProviderId, number>>({ claude: 0, codex: 0 });

  const inspectorShown = panelHeights(columns, rows, snapshot.inspectorVisible, Boolean(snapshot.notice), viewMode).showInspector;
  const context: InteractionContext = {
    inspectorShown,
    inspectorWouldFit: panelHeights(columns, rows, true, Boolean(snapshot.notice), viewMode).showInspector,
    columns,
  };

  // A transition reads the latest state and snapshot from refs rather than from
  // the render closure, so a command that reports its result immediately reduces
  // against what is on screen now instead of a stale copy.
  const stateRef = useRef(state);
  const snapshotRef = useRef(snapshot);
  const contextRef = useRef(context);
  stateRef.current = state;
  snapshotRef.current = snapshot;
  contextRef.current = context;

  const dispatchIntent = (intent: Intent): void => {
    const transition = reduce(stateRef.current, intent, snapshotRef.current, contextRef.current);
    stateRef.current = transition.state;
    setState(transition.state);
    for (const command of transition.commands) runCommand(command);
  };

  function runCommand(command: InteractionCommand): void {
    switch (command.kind) {
      case "quit":
        void Promise.allSettled([orchestrator.close(), onBeforeExit?.()]).finally(exit);
        return;
      case "notice":
        orchestrator.showNotice(command.message);
        return;
      case "focus":
        orchestrator.focus(command.provider);
        return;
      case "setTarget":
        orchestrator.setTarget(command.target);
        return;
      case "cycleTarget":
        orchestrator.cycleTarget();
        return;
      case "cancel":
        void orchestrator.cancel(command.provider);
        return;
      case "toggleInspector":
        orchestrator.toggleInspector();
        return;
      case "refreshEvidence":
        void orchestrator.refreshEvidence();
        return;
      case "selectEvidenceFile":
        void orchestrator.selectEvidenceFile(command.path);
        return;
      case "selectFinding":
        void orchestrator.selectFinding(command.id);
        return;
      case "toggleFinding":
        orchestrator.toggleFinding(command.id);
        return;
      case "setReviewMechanism":
        orchestrator.setReviewMechanism(command.mechanism);
        return;
      case "selectReviewLens":
        orchestrator.selectReviewLens(command.provider);
        return;
      case "setModel":
        orchestrator.setModel(command.provider, command.model);
        return;
      case "setRole":
        orchestrator.setRole(command.role, command.provider);
        return;
      case "resetRoleHandoffChain":
        orchestrator.resetRoleHandoffChain();
        return;
      case "resolveApproval":
        orchestrator.resolveApproval(command.id, command.decision);
        return;
      case "removeQueued":
        orchestrator.removeQueued(command.id);
        return;
      case "confirmQueued":
        orchestrator.confirmQueued(command.id);
        return;
      case "confirmQueueOffer":
        dispatchIntent({ type: "queue_offer_settled", accepted: orchestrator.confirmQueueOffer() });
        return;
      case "cancelQueueOffer":
        orchestrator.cancelQueueOffer();
        return;
      case "confirmRoleHandoff":
        dispatchIntent({ type: "handoff_prompt", prompt: orchestrator.confirmRoleHandoff() });
        return;
      case "cancelRoleHandoff":
        orchestrator.cancelRoleHandoff();
        return;
      case "prepareRoleHandoff":
        void orchestrator.prepareRoleHandoff(command.prompt)
          .then((ready) => dispatchIntent({ type: "handoff_prepared", ready }));
        return;
      case "cancelIsolatedPlan":
        orchestrator.cancelIsolatedPlan();
        return;
      case "revokeWriter":
        void orchestrator.revokeWriter();
        return;
      case "dispatch":
        void orchestrator.dispatch(command.prompt).then((sent) => dispatchIntent({ type: "dispatch_settled", sent }));
        return;
      case "startGuidedBuild":
        void orchestrator.startGuidedBuild(command.prompt, command.dirtyAcknowledged)
          .then((started) => dispatchIntent({ type: "guided_build_settled", started }));
        return;
      case "promoteWriter":
        void orchestrator.promoteWriter(command.provider, command.dirtyAcknowledged)
          .then((promoted) => dispatchIntent({ type: "writer_promoted", promoted }));
        return;
      case "prepareReview":
        void orchestrator.prepareReview().then((ready) => dispatchIntent({ type: "review_prepared", ready }));
        return;
      case "startReview":
        void orchestrator.startReview(command.criteria)
          .then((started) => dispatchIntent({ type: "review_started", started }));
        return;
      case "startTwoLensReview":
        void orchestrator.startTwoLensReview(command.criteria)
          .then((started) => dispatchIntent({ type: "review_started", started }));
        return;
      case "finishReview":
        dispatchIntent({ type: "review_finished", finished: orchestrator.finishReview(command.outcome) });
        return;
      case "returnSelectedFindings": {
        const writer = snapshotRef.current.review?.writer;
        const relay = orchestrator.returnSelectedFindings(command.staleAcknowledged);
        if (writer) dispatchIntent({ type: "findings_relayed", relay, writer });
        return;
      }
      case "prepareIsolated":
        void orchestrator.prepareIsolated().then((ready) => dispatchIntent({ type: "isolated_prepared", ready }));
        return;
      case "startIsolated":
        void orchestrator.startIsolated();
        return;
      case "refreshIsolated":
        void orchestrator.refreshIsolated();
        return;
      case "retainIsolated":
        void orchestrator.retainIsolated();
        return;
      case "cleanupIsolated":
        void orchestrator.cleanupIsolated().then(() => dispatchIntent({ type: "isolated_cleaned" }));
        return;
      case "discardIsolated":
        void orchestrator.discardIsolated()
          .then((discarded) => dispatchIntent({ type: "isolated_discarded", discarded }));
        return;
      case "startNewSessions":
        void orchestrator.startNewSessions().then(() => dispatchIntent({ type: "sessions_settled", done: true }));
        return;
      case "restoreSessions":
        void orchestrator.restoreSessions().then(() => dispatchIntent({ type: "sessions_settled", done: true }));
        return;
      case "resetSession":
        void orchestrator.resetSession(command.provider)
          .then((reset) => dispatchIntent({ type: "session_reset", reset }));
        return;
    }
  }

  function runViewportIntent(intent: ViewportIntent): void {
    if (intent.type === "toggle_view") {
      setViewMode((current) => current === "both" ? "focused" : "both");
      return;
    }
    const provider = snapshot.focusedProvider;
    const lane = snapshot.lanes[provider];
    const viewportHeight = laneOutputHeight(columns, rows, snapshot.inspectorVisible, Boolean(lane.error), Boolean(snapshot.notice), viewMode);
    const maximum = maxScrollOffset(lane.output, viewportHeight);
    const page = Math.max(1, viewportHeight - 1);
    setScrollOffsets((current) => ({
      ...current,
      [provider]: intent.direction === "bottom"
        ? 0
        : intent.direction === "top"
          ? maximum
          : intent.direction === "up"
            ? Math.min(maximum, current[provider] + page)
            : Math.max(0, current[provider] - page),
    }));
  }

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

  // Snapshot changes are intents too, so the machine decides what each one does
  // to the interface. `state.overlay` is a dependency of the approvals effect
  // because an inbox must never take input away from an overlay that owns it.
  useEffect(() => dispatchIntent({ type: "approvals_changed" }), [snapshot.approvals.length, state.overlay]);
  useEffect(() => dispatchIntent({ type: "queue_offer_changed" }), [snapshot.queueOffer]);
  useEffect(() => dispatchIntent({ type: "restorable_changed" }), [snapshot.restorableSessions.length]);
  useEffect(() => dispatchIntent({ type: "review_status_changed" }), [snapshot.review?.status]);
  useEffect(() => dispatchIntent({ type: "evidence_files_changed" }), [snapshot.git.files.join("\0")]);
  useEffect(() => dispatchIntent({ type: "queue_length_changed" }), [snapshot.queue.length]);
  useEffect(
    () => dispatchIntent({ type: "guided_build_status" }),
    [state.guidedBuildActive, snapshot.lanes.codex.status, snapshot.mode, snapshot.writer],
  );

  useEffect(() => {
    if (!snapshot.notice) return;
    const timer = setTimeout(() => orchestrator.clearNotice(), NOTICE_TTL_MS);
    return () => clearTimeout(timer);
  }, [snapshot.notice]);

  // A resize can take the inspector off screen while it still holds focus, which
  // would leave the keyboard looking dead with nothing on screen to explain why.
  useEffect(() => {
    if (state.inspectorFocused && !inspectorShown) dispatchIntent({ type: "blur_inspector" });
  }, [state.inspectorFocused, inspectorShown]);

  useInput((input, key) => {
    const intent = resolveIntent({ input, ...key }, { overlay: state.overlay, inspectorFocused: state.inspectorFocused });
    if (!intent) return;
    if (isViewportIntent(intent)) runViewportIntent(intent);
    else dispatchIntent(intent);
  });

  return <SplitlaneView
    snapshot={snapshot}
    prompt={state.prompt}
    columns={columns}
    rows={rows}
    viewMode={viewMode}
    composerMode={state.composerMode}
    overlay={state.overlay}
    modelProvider={state.modelProvider}
    modelDraft={state.modelDraft}
    roleIndex={state.roleIndex}
    writerProvider={state.writerProvider}
    writerConfirm={state.writerConfirm}
    approvalIndex={state.approvalIndex}
    approvalArmed={state.armedApproval !== null}
    reviewCriteria={state.reviewCriteria}
    findingIndex={state.findingIndex}
    staleAcknowledged={state.staleAcknowledged}
    scrollOffsets={scrollOffsets}
    activityIndex={state.activityIndex}
    activityExpanded={state.activityExpanded}
    queueIndex={state.queueIndex}
    restoreInspect={state.restoreInspect}
    destructiveConfirm={state.destructiveConfirm}
    isolatedDiscardConfirm={state.isolatedDiscardConfirm}
    inspectorTab={state.inspectorTab}
    inspectorFocused={state.inspectorFocused}
    evidenceIndex={state.evidenceIndex}
  />;
}
