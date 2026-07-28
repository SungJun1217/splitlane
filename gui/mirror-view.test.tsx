import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "bun:test";
import { MirrorView } from "./mirror-view.tsx";
import type { MirrorState } from "./bridge.ts";
import type { AppSnapshot } from "../src/domain.ts";
import { CompareOrchestrator } from "../src/core/orchestrator.ts";
import type { ProviderAdapter, ProviderProbe, SessionHandle, ProviderTurn } from "../src/domain.ts";

/** The mirror only ever renders; it never starts a provider. A probe-only stub is
 * enough to obtain a real snapshot without touching a CLI. */
class InertAdapter implements ProviderAdapter {
  constructor(readonly provider: "claude" | "codex") {}
  async probe(): Promise<ProviderProbe> {
    return { provider: this.provider, available: true, version: `${this.provider}/test`, error: null };
  }
  async startSession(): Promise<SessionHandle> {
    throw new Error("the mirror must never start a session");
  }
  async resumeSession(): Promise<SessionHandle> {
    throw new Error("the mirror must never resume a session");
  }
  async startTurn(): Promise<ProviderTurn> {
    throw new Error("the mirror must never start a turn");
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {}
}

function snapshot(): AppSnapshot {
  const orchestrator = new CompareOrchestrator(process.cwd(), {
    claude: new InertAdapter("claude"),
    codex: new InertAdapter("codex"),
  });
  return orchestrator.getSnapshot();
}

function state(patch: Partial<MirrorState> = {}): MirrorState {
  return { status: "attached", projectRoot: "/repo", sessionVersion: "0.0.7", detail: null, snapshot: snapshot(), ...patch };
}

describe("read-only mirror view", () => {
  test("says it is read-only and names the command that starts a session", () => {
    const waiting = renderToStaticMarkup(<MirrorView state={{ ...state(), status: "waiting", snapshot: null }} />);
    expect(waiting).toContain("READ-ONLY MIRROR");
    expect(waiting).toContain("WAITING FOR A SESSION");
    expect(waiting).toContain("splitlane /repo --mirror");
    expect(waiting).toContain("cannot send prompts");
  });

  test("renders both lanes, the evidence panel, and the authority the session holds", () => {
    const markup = renderToStaticMarkup(<MirrorView state={state()} />);
    expect(markup).toContain("CLAUDE");
    expect(markup).toContain("CODEX");
    expect(markup).toContain("EVIDENCE");
    expect(markup).toContain("mode</b>COMPARE");
    expect(markup).toContain("writer</b>NONE");
    expect(markup).toContain("happens in the terminal");
    // Read-only means read-only: no control affordance may reach the markup.
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<form");
    expect(markup).not.toContain("<textarea");
  });

  test("a session that ended is labelled stale instead of presented as live", () => {
    const markup = renderToStaticMarkup(<MirrorView state={state({ status: "detached" })} />);
    expect(markup).toContain("SESSION ENDED");
    expect(markup).toContain("last published state");
  });

  test("an endpoint owned by another project refuses to render its snapshot", () => {
    const markup = renderToStaticMarkup(<MirrorView
      state={state({ status: "mismatch", snapshot: null, detail: "Endpoint belongs to splitlane-mirror/v1 at /other." })}
    />);
    expect(markup).toContain("ANOTHER PROJECT");
    expect(markup).toContain("/other");
  });
});
