import React, { useEffect, useState } from "react";
import type { AppSnapshot, LaneSnapshot, ProviderId } from "../src/domain.ts";
import type { MirrorState, MirrorStatus } from "./bridge.ts";

declare global {
  interface Window {
    splitlaneMirror: { subscribe(listener: (state: MirrorState) => void): () => void };
  }
}

const STATUS_TEXT: Record<MirrorStatus, string> = {
  waiting: "WAITING FOR A SESSION",
  attached: "ATTACHED",
  detached: "SESSION ENDED · SNAPSHOT IS STALE",
  mismatch: "ENDPOINT BELONGS TO ANOTHER PROJECT",
  error: "CANNOT READ THIS PROJECT",
};

const LANE_TITLE: Record<ProviderId, string> = { claude: "CLAUDE", codex: "CODEX" };

export const STYLE = `
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --panel: #ffffff; --line: #d8dbe2; --text: #14161c; --muted: #5c6270;
    --accent: #2d6cdf; --warn: #a4590a; --danger: #b3261e; --ok: #17683a;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #11131a; --panel: #191c25; --line: #2b3040; --text: #e7e9ef; --muted: #9aa1b1;
      --accent: #6fa0ff; --warn: #e0a33c; --danger: #ff8a80; --ok: #6fd39a;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Noto Sans KR", sans-serif; }
  .app { display: flex; flex-direction: column; height: 100vh; }
  .banner { display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
    padding: 8px 14px; background: var(--panel); border-bottom: 1px solid var(--line); }
  .banner strong { letter-spacing: .06em; font-size: 11px; }
  .pill { padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line);
    font-size: 11px; letter-spacing: .04em; }
  .pill[data-tone="ok"] { color: var(--ok); border-color: currentColor; }
  .pill[data-tone="warn"] { color: var(--warn); border-color: currentColor; }
  .pill[data-tone="danger"] { color: var(--danger); border-color: currentColor; }
  .path { font-family: var(--mono); font-size: 11px; color: var(--muted);
    margin-left: auto; overflow-wrap: anywhere; }
  .header { display: flex; gap: 18px; flex-wrap: wrap; padding: 10px 14px;
    border-bottom: 1px solid var(--line); font-size: 12px; }
  .header span b { color: var(--muted); font-weight: 500; margin-right: 5px; }
  .body { display: grid; grid-template-columns: 2fr 1fr; gap: 12px; padding: 12px;
    flex: 1; min-height: 0; }
  @media (max-width: 900px) { .body { grid-template-columns: 1fr; } }
  .lanes { display: grid; grid-template-rows: 1fr 1fr; gap: 12px; min-height: 0; }
  .card { display: flex; flex-direction: column; min-height: 0; background: var(--panel);
    border: 1px solid var(--line); border-radius: 8px; }
  .card > h2 { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap;
    margin: 0; padding: 9px 12px; border-bottom: 1px solid var(--line); font-size: 12px;
    letter-spacing: .06em; }
  .card > h2 small { font-weight: 400; letter-spacing: 0; color: var(--muted); }
  .scroll { overflow: auto; padding: 10px 12px; }
  pre { margin: 0; font-family: var(--mono); font-size: 12px; white-space: pre-wrap;
    overflow-wrap: anywhere; }
  .empty { color: var(--muted); font-style: italic; }
  .tabs { display: flex; flex-direction: column; gap: 14px; }
  .tabs h3 { margin: 0 0 4px; font-size: 11px; letter-spacing: .06em; color: var(--muted); }
  ul { margin: 0; padding-left: 16px; }
  li { overflow-wrap: anywhere; }
  .files li[data-kind="writer-hinted"] { color: var(--accent); }
  .files li[data-kind="pre-existing"] { color: var(--muted); }
  .notice { padding: 8px 14px; border-top: 1px solid var(--line); background: var(--panel);
    color: var(--warn); font-size: 12px; }
  .footer { padding: 7px 14px; border-top: 1px solid var(--line); color: var(--muted);
    font-size: 11px; }
`;

function statusTone(status: MirrorStatus): string {
  if (status === "attached") return "ok";
  if (status === "waiting") return "warn";
  return "danger";
}

function Lane({ provider, lane, isWriter }: { provider: ProviderId; lane: LaneSnapshot; isWriter: boolean }) {
  return (
    <section className="card">
      <h2>
        {LANE_TITLE[provider]}
        <span className="pill" data-tone={lane.status === "FAILED" || lane.status === "BLOCKED" ? "danger" : lane.status === "RUNNING" ? "warn" : "ok"}>
          {lane.status}
        </span>
        {isWriter ? <span className="pill" data-tone="warn">WRITER</span> : null}
        <small>
          model {lane.requestedModel}
          {lane.effectiveModel ? ` → ${lane.effectiveModel}` : " → pending"}
          {" · session "}{lane.sessionId ? lane.sessionId.slice(0, 12) : "new"}
        </small>
      </h2>
      <div className="scroll">
        {lane.error ? <pre style={{ color: "var(--danger)" }}>{lane.error}</pre> : null}
        {lane.output ? <pre>{lane.output}</pre> : <p className="empty">No output yet.</p>}
      </div>
    </section>
  );
}

function Evidence({ snapshot }: { snapshot: AppSnapshot }) {
  const { git, review, approvals, queue } = snapshot;
  return (
    <section className="card">
      <h2>
        EVIDENCE <small>read only</small>
      </h2>
      <div className="scroll tabs">
        <div>
          <h3>WORKSPACE</h3>
          <p>
            {git.branch ?? "unknown"} · {git.dirty ? "DIRTY" : "CLEAN"} · baseline{" "}
            {git.baselineFingerprint ? git.baselineFingerprint.slice(0, 12) : "none"}
          </p>
          {git.error ? <pre style={{ color: "var(--danger)" }}>{git.error}</pre> : null}
        </div>
        <div>
          <h3>CHANGED FILES</h3>
          {git.evidence.length
            ? (
              <ul className="files">
                {git.evidence.map((entry) => (
                  <li key={entry.path} data-kind={entry.classification}>
                    {entry.path} <small>{entry.classification}</small>
                  </li>
                ))}
              </ul>
            )
            : <p className="empty">Working tree clean.</p>}
        </div>
        <div>
          <h3>DIFF</h3>
          {git.diff ? <pre>{git.diff}</pre> : <p className="empty">No diff.</p>}
        </div>
        <div>
          <h3>FINDINGS</h3>
          {review?.findings.length
            ? (
              <ul>
                {review.findings.map((finding) => (
                  <li key={finding.id}>
                    <b>{finding.severity.toUpperCase()}</b> {finding.title}
                    {finding.file ? <small> · {finding.file}</small> : null}
                  </li>
                ))}
              </ul>
            )
            : <p className="empty">No review findings.</p>}
        </div>
        <div>
          <h3>APPROVALS · {approvals.length}</h3>
          {approvals.length
            ? (
              <ul>
                {approvals.map((approval) => (
                  <li key={approval.id}>
                    {approval.provider} · {approval.kind} · {approval.tool}
                    <small> — answer this in the terminal</small>
                  </li>
                ))}
              </ul>
            )
            : <p className="empty">Inbox empty.</p>}
        </div>
        <div>
          <h3>QUEUE · {queue.length}</h3>
          {queue.length
            ? <ul>{queue.map((item) => <li key={item.id}>{item.target} · {item.status} · {item.envelope.prompt.slice(0, 80)}</li>)}</ul>
            : <p className="empty">Nothing queued.</p>}
        </div>
      </div>
    </section>
  );
}

function Guidance({ state }: { state: MirrorState }) {
  const command = `splitlane ${state.projectRoot} --mirror`;
  return (
    <section className="card">
      <h2>NO SESSION ATTACHED</h2>
      <div className="scroll tabs">
        <p>
          This window only ever shows a session that is already running in a terminal. Start one with
          the mirror published:
        </p>
        <pre>{command}</pre>
        {state.detail ? <pre style={{ color: "var(--danger)" }}>{state.detail}</pre> : null}
        <p className="empty">
          The mirror cannot send prompts, grant a writer lease, or answer an approval. Those stay in
          the terminal.
        </p>
      </div>
    </section>
  );
}

/** Subscribes and renders. Split from `MirrorView` so the markup can be asserted
 * without a DOM or an Electron bridge. */
export function Mirror() {
  const [state, setState] = useState<MirrorState | null>(null);
  useEffect(() => window.splitlaneMirror.subscribe(setState), []);
  return <MirrorView state={state} />;
}

export function MirrorView({ state }: { state: MirrorState | null }) {
  const snapshot = state?.snapshot ?? null;
  return (
    <div className="app">
      <div className="banner">
        <strong>SPLITLANE · READ-ONLY MIRROR</strong>
        <span className="pill" data-tone={statusTone(state?.status ?? "waiting")}>
          {STATUS_TEXT[state?.status ?? "waiting"]}
        </span>
        {state?.sessionVersion ? <span className="pill">session {state.sessionVersion}</span> : null}
        <span className="path">{state?.projectRoot ?? ""}</span>
      </div>
      {snapshot
        ? (
          <>
            <div className="header">
              <span><b>mode</b>{snapshot.mode.toUpperCase()}</span>
              <span><b>writer</b>{snapshot.writer ? snapshot.writer.toUpperCase() : "NONE"}</span>
              <span><b>send</b>{snapshot.target.toUpperCase()}</span>
              <span><b>focus</b>{snapshot.focusedProvider.toUpperCase()}</span>
              <span><b>turns</b>{snapshot.metaSession.turnCount}</span>
              {snapshot.isolated ? <span><b>isolated</b>{snapshot.isolated.lifecycle.toUpperCase()}</span> : null}
            </div>
            <div className="body">
              <div className="lanes">
                <Lane provider="claude" lane={snapshot.lanes.claude} isWriter={snapshot.writer === "claude"} />
                <Lane provider="codex" lane={snapshot.lanes.codex} isWriter={snapshot.writer === "codex"} />
              </div>
              <Evidence snapshot={snapshot} />
            </div>
          </>
        )
        : (
          <div className="body">
            <Guidance state={state ?? { status: "waiting", projectRoot: "", sessionVersion: null, detail: null, snapshot: null }} />
          </div>
        )}
      {snapshot?.notice ? <div className="notice">{snapshot.notice}</div> : null}
      <div className="footer">
        {state?.status === "detached"
          ? "The terminal session ended; this is its last published state."
          : "Every action — routing, writer promotion, approvals, review — happens in the terminal."}
      </div>
    </div>
  );
}
