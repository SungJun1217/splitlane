import type { ApprovalDecision, AppSnapshot, ProviderId, ReviewMechanism, RoleId } from "../domain.ts";
import { removeLastGrapheme } from "./text.ts";

/** The interaction state machine. It owns every overlay, draft, and confirmation
 * step — including the gates that hand out authority — so a second renderer draws
 * from the same machine instead of re-implementing the gates. It never touches an
 * orchestrator: transitions return commands for the host to run, which is what
 * keeps it testable without a terminal or a window.
 *
 * Terminal-specific state stays out: scroll offsets and the both/focused view
 * need viewport geometry, so the Ink layer keeps those. */

export type Overlay =
  | "flow_start"
  | "model"
  | "actions"
  | "roles"
  | "diagnostics"
  | "writer"
  | "approval"
  | "review"
  | "findings"
  | "activity"
  | "help"
  | "queue_offer"
  | "queue"
  | "configuration"
  | "restore"
  | "reset_session"
  | "handoff"
  | "isolated"
  | null;

export type ComposerMode = "flow" | "direct";
export type InspectorTab = "changes" | "diff" | "file" | "findings";

export const INSPECTOR_TABS: readonly InspectorTab[] = ["changes", "diff", "file", "findings"];

export const ROLE_IDS: readonly RoleId[] = [
  "scout",
  "architect",
  "builder",
  "debugger",
  "intent_reviewer",
  "correctness_reviewer",
];

/** A dispatch can raise an approval before its own promise resolves. Closing the
 * overlay unconditionally would then dismiss the approval inbox that the
 * approvals effect just opened, leaving the lane BLOCKED with nothing on screen,
 * so only the overlay we opened may be closed. */
export function overlayAfterDispatch(current: Overlay, expected: Overlay): Overlay {
  return current === expected ? null : current;
}

export interface InteractionState {
  prompt: string;
  composerMode: ComposerMode;
  guidedBuildActive: boolean;
  overlay: Overlay;
  modelProvider: ProviderId;
  modelDraft: string;
  roleIndex: number;
  roleProvider: ProviderId;
  writerProvider: ProviderId;
  /** The second step of the writer gate. Reaching it and granting from it never
   * share a key, because Ink reports Ctrl+<letter> as the bare letter. */
  writerConfirm: boolean;
  approvalIndex: number;
  armedApproval: string | null;
  reviewCriteria: string;
  findingIndex: number;
  staleAcknowledged: boolean;
  activityIndex: number;
  activityExpanded: boolean;
  queueIndex: number;
  restoreInspect: boolean;
  destructiveConfirm: boolean;
  isolatedDiscardConfirm: boolean;
  inspectorTab: InspectorTab;
  inspectorFocused: boolean;
  evidenceIndex: number;
  /** Remembers a dismissed inbox so the approvals effect does not immediately
   * reopen the overlay the user just closed. */
  dismissedApprovalCount: number;
}

export function initialState(snapshot: AppSnapshot): InteractionState {
  return {
    prompt: "",
    // Read-only is the safe default everywhere else in the initial state (compare
    // mode, writer NONE), so the composer starts read-only too.
    composerMode: "direct",
    guidedBuildActive: false,
    overlay: snapshot.restorableSessions.length ? "restore" : null,
    modelProvider: snapshot.focusedProvider,
    modelDraft: "",
    roleIndex: 0,
    roleProvider: "claude",
    writerProvider: snapshot.focusedProvider,
    writerConfirm: false,
    approvalIndex: 0,
    armedApproval: null,
    reviewCriteria: "",
    findingIndex: 0,
    staleAcknowledged: false,
    activityIndex: 0,
    activityExpanded: snapshot.configuration.showTools === "expanded",
    queueIndex: 0,
    restoreInspect: false,
    destructiveConfirm: false,
    isolatedDiscardConfirm: false,
    inspectorTab: "changes",
    inspectorFocused: false,
    evidenceIndex: 0,
    dismissedApprovalCount: 0,
  };
}

/** What the host must do on the orchestrator. Everything asynchronous reports
 * back as an intent, so the state machine — not the host — decides what a result
 * means. */
export type InteractionCommand =
  | { kind: "quit" }
  | { kind: "notice"; message: string }
  | { kind: "focus"; provider: ProviderId }
  | { kind: "setTarget"; target: "claude" | "codex" | "both" }
  | { kind: "cycleTarget" }
  | { kind: "cancel"; provider: ProviderId }
  | { kind: "toggleInspector" }
  | { kind: "refreshEvidence" }
  | { kind: "selectEvidenceFile"; path: string }
  | { kind: "selectFinding"; id: string }
  | { kind: "toggleFinding"; id: string }
  | { kind: "setReviewMechanism"; mechanism: ReviewMechanism }
  | { kind: "selectReviewLens"; provider: ProviderId }
  | { kind: "setModel"; provider: ProviderId; model: string }
  | { kind: "setRole"; role: RoleId; provider: ProviderId }
  | { kind: "resetRoleHandoffChain" }
  | { kind: "resolveApproval"; id: string; decision: ApprovalDecision }
  | { kind: "removeQueued"; id: string }
  | { kind: "confirmQueued"; id: string }
  | { kind: "confirmQueueOffer" }
  | { kind: "cancelQueueOffer" }
  | { kind: "confirmRoleHandoff" }
  | { kind: "cancelRoleHandoff" }
  | { kind: "prepareRoleHandoff"; prompt: string }
  | { kind: "cancelIsolatedPlan" }
  | { kind: "revokeWriter" }
  | { kind: "dispatch"; prompt: string }
  | { kind: "startGuidedBuild"; prompt: string; dirtyAcknowledged: boolean }
  | { kind: "promoteWriter"; provider: ProviderId; dirtyAcknowledged: boolean }
  | { kind: "prepareReview" }
  | { kind: "startReview"; criteria: string }
  | { kind: "startTwoLensReview"; criteria: string }
  | { kind: "finishReview"; outcome: "accept" | "exit" }
  | { kind: "returnSelectedFindings"; staleAcknowledged: boolean }
  | { kind: "prepareIsolated" }
  | { kind: "startIsolated" }
  | { kind: "refreshIsolated" }
  | { kind: "retainIsolated" }
  | { kind: "cleanupIsolated" }
  | { kind: "discardIsolated" }
  | { kind: "startNewSessions" }
  | { kind: "restoreSessions" }
  | { kind: "resetSession"; provider: ProviderId };

export type Intent =
  // Global
  | { type: "quit" }
  | { type: "escape" }
  | { type: "focus_inspector" }
  | { type: "blur_inspector" }
  | { type: "inspector_cycle_tab"; offset: 1 | -1 }
  | { type: "inspector_move"; offset: 1 | -1 }
  | { type: "toggle_composer_mode" }
  | { type: "focus_lane"; provider: ProviderId }
  | { type: "cycle_target" }
  | { type: "cancel_focused" }
  | { type: "toggle_inspector" }
  | { type: "refresh_evidence" }
  | { type: "open_review" }
  | { type: "open_findings" }
  | { type: "open_writer" }
  | { type: "revoke_writer" }
  | { type: "open_approvals" }
  | { type: "open_model" }
  | { type: "open_actions" }
  | { type: "open_help" }
  | { type: "open_activity" }
  | { type: "open_queue" }
  | { type: "open_configuration" }
  | { type: "open_reset_session" }
  | { type: "open_handoff" }
  | { type: "open_isolated" }
  | { type: "open_diagnostics" }
  | { type: "open_roles" }
  | { type: "submit" }
  | { type: "erase" }
  | { type: "type"; text: string }
  // Overlay-scoped
  | { type: "close_overlay" }
  | { type: "flow_to_direct" }
  | { type: "flow_enter" }
  | { type: "flow_grant" }
  | { type: "activity_move"; offset: 1 | -1 }
  | { type: "activity_toggle_expand" }
  | { type: "queue_offer_confirm" }
  | { type: "queue_offer_cancel" }
  | { type: "queue_move"; offset: 1 | -1 }
  | { type: "queue_remove" }
  | { type: "queue_confirm" }
  | { type: "restore_toggle_inspect" }
  | { type: "restore_new" }
  | { type: "restore_confirm" }
  | { type: "reset_confirm" }
  | { type: "model_swap_provider" }
  | { type: "model_submit" }
  | { type: "model_erase" }
  | { type: "model_type"; text: string }
  | { type: "role_move"; offset: 1 | -1 }
  | { type: "role_swap_provider" }
  | { type: "role_reset_chain" }
  | { type: "role_submit" }
  | { type: "writer_swap_provider" }
  | { type: "writer_enter" }
  | { type: "writer_grant" }
  | { type: "approval_move"; offset: 1 | -1 }
  | { type: "approval_allow" }
  | { type: "approval_deny" }
  | { type: "approval_cancel_turn" }
  | { type: "review_cycle_mechanism" }
  | { type: "review_two_lens" }
  | { type: "review_submit" }
  | { type: "review_erase" }
  | { type: "review_type"; text: string }
  | { type: "findings_swap_lens" }
  | { type: "findings_move"; offset: 1 | -1 }
  | { type: "findings_toggle" }
  | { type: "findings_accept" }
  | { type: "findings_exit" }
  | { type: "findings_toggle_stale" }
  | { type: "findings_return" }
  | { type: "handoff_confirm" }
  | { type: "isolated_start" }
  | { type: "isolated_cancel_plan" }
  | { type: "isolated_refresh" }
  | { type: "isolated_retain" }
  | { type: "isolated_cleanup" }
  | { type: "isolated_discard" }
  // Results reported by the host
  | { type: "dispatch_settled"; sent: boolean }
  | { type: "guided_build_settled"; started: boolean }
  | { type: "writer_promoted"; promoted: boolean }
  | { type: "review_prepared"; ready: boolean }
  | { type: "review_started"; started: boolean }
  | { type: "review_finished"; finished: boolean }
  | { type: "findings_relayed"; relay: string | null; writer: ProviderId }
  | { type: "handoff_prepared"; ready: boolean }
  | { type: "handoff_prompt"; prompt: string | null }
  | { type: "queue_offer_settled"; accepted: boolean }
  | { type: "isolated_prepared"; ready: boolean }
  | { type: "isolated_discarded"; discarded: boolean }
  | { type: "isolated_cleaned" }
  | { type: "sessions_settled"; done: boolean }
  | { type: "session_reset"; reset: boolean }
  // Snapshot-driven
  | { type: "approvals_changed" }
  | { type: "queue_offer_changed" }
  | { type: "restorable_changed" }
  | { type: "review_status_changed" }
  | { type: "guided_build_status" }
  | { type: "evidence_files_changed" }
  | { type: "queue_length_changed" };

/** Facts the state machine needs that live in the renderer, not the snapshot. */
export interface InteractionContext {
  /** Whether the evidence inspector is actually on screen at this size. */
  inspectorShown: boolean;
  /** Whether it would be on screen if it were turned on now. */
  inspectorWouldFit: boolean;
  columns: number;
}

export interface Transition {
  state: InteractionState;
  commands: readonly InteractionCommand[];
}

const keep = (state: InteractionState, ...commands: InteractionCommand[]): Transition => ({ state, commands });

const move = (state: InteractionState, patch: Partial<InteractionState>, ...commands: InteractionCommand[]): Transition => ({
  state: { ...state, ...patch },
  commands,
});

function selectFindingAt(snapshot: AppSnapshot, index: number): InteractionCommand[] {
  const finding = snapshot.review?.findings[index];
  return finding ? [{ kind: "selectFinding", id: finding.id }] : [];
}

function currentApproval(snapshot: AppSnapshot, index: number) {
  return snapshot.approvals[index] ?? snapshot.approvals[0];
}

function closedOverlay(state: InteractionState, expected: Overlay): Partial<InteractionState> {
  return { overlay: overlayAfterDispatch(state.overlay, expected) };
}

export function reduce(state: InteractionState, intent: Intent, snapshot: AppSnapshot, context: InteractionContext): Transition {
  switch (intent.type) {
    case "quit":
      return keep(state, { kind: "quit" });

    case "escape": {
      const commands: InteractionCommand[] = [];
      if (state.overlay === "queue_offer") commands.push({ kind: "cancelQueueOffer" });
      if (state.overlay === "handoff") commands.push({ kind: "cancelRoleHandoff" });
      if (state.overlay === "isolated" && snapshot.isolated?.lifecycle === "preview") commands.push({ kind: "cancelIsolatedPlan" });
      return move(state, {
        overlay: null,
        writerConfirm: false,
        destructiveConfirm: false,
        isolatedDiscardConfirm: false,
        armedApproval: null,
        // Remember the dismissal so the approvals effect does not immediately
        // reopen the overlay the user just closed.
        dismissedApprovalCount: state.overlay === "approval" ? snapshot.approvals.length : state.dismissedApprovalCount,
      }, ...commands);
    }

    case "close_overlay":
      return move(state, { overlay: null });

    // ── Task-flow gate ────────────────────────────────────────────────────────
    case "flow_to_direct":
      return move(state, { composerMode: "direct", overlay: null, writerConfirm: false });

    case "flow_enter":
      return state.writerConfirm ? keep(state) : move(state, { writerConfirm: true });

    case "flow_grant":
      // The last step grants write authority and starts a paid turn, so it is
      // reachable only from the confirmation step and never by the key that
      // reached it.
      return state.writerConfirm
        ? keep(state, { kind: "startGuidedBuild", prompt: state.prompt, dirtyAcknowledged: snapshot.git.dirty })
        : keep(state);

    case "guided_build_settled":
      return intent.started
        ? move(state, {
          prompt: "",
          guidedBuildActive: true,
          writerConfirm: false,
          ...closedOverlay(state, "flow_start"),
        })
        : keep(state);

    // ── Writer gate ───────────────────────────────────────────────────────────
    case "writer_swap_provider":
      return state.writerConfirm
        ? keep(state)
        : move(state, { writerProvider: state.writerProvider === "claude" ? "codex" : "claude" });

    case "writer_enter":
      return state.writerConfirm ? keep(state) : move(state, { writerConfirm: true });

    case "writer_grant":
      return state.writerConfirm
        ? keep(state, { kind: "promoteWriter", provider: state.writerProvider, dirtyAcknowledged: snapshot.git.dirty })
        : keep(state);

    case "writer_promoted":
      return intent.promoted
        ? move(state, { writerConfirm: false, ...closedOverlay(state, "writer") })
        : keep(state);

    // ── Approval inbox ────────────────────────────────────────────────────────
    case "approval_move": {
      const count = Math.max(1, snapshot.approvals.length);
      return move(state, {
        approvalIndex: (state.approvalIndex + intent.offset + count) % count,
        armedApproval: null,
      });
    }

    case "approval_allow": {
      const approval = currentApproval(snapshot, state.approvalIndex);
      if (!approval) return keep(state);
      // Granting authority is the one decision here that is not fail-closed, so
      // it takes a second deliberate keystroke on the same request. Deny and
      // cancel stay single-key because they only ever withhold authority.
      return state.armedApproval === approval.id
        ? move(state, { armedApproval: null }, { kind: "resolveApproval", id: approval.id, decision: "allow_once" })
        : move(state, { armedApproval: approval.id });
    }

    case "approval_deny":
    case "approval_cancel_turn": {
      const approval = currentApproval(snapshot, state.approvalIndex);
      if (!approval) return keep(state);
      return move(state, { armedApproval: null }, {
        kind: "resolveApproval",
        id: approval.id,
        decision: intent.type === "approval_deny" ? "deny" : "cancel_turn",
      });
    }

    // ── Activity, queue, restore, reset ───────────────────────────────────────
    case "activity_move": {
      const activities = snapshot.lanes[snapshot.focusedProvider].activities;
      return move(state, {
        activityIndex: intent.offset === -1
          ? Math.max(0, state.activityIndex - 1)
          : Math.min(Math.max(0, activities.length - 1), state.activityIndex + 1),
      });
    }

    case "activity_toggle_expand":
      return move(state, { activityExpanded: !state.activityExpanded });

    case "queue_offer_confirm":
      return keep(state, { kind: "confirmQueueOffer" });

    case "queue_offer_settled":
      return intent.accepted ? move(state, { prompt: "", overlay: null }) : keep(state);

    case "queue_offer_cancel":
      return move(state, { overlay: null }, { kind: "cancelQueueOffer" });

    case "queue_move": {
      const count = Math.max(1, snapshot.queue.length);
      return move(state, {
        queueIndex: (Math.min(state.queueIndex, count - 1) + intent.offset + count) % count,
      });
    }

    case "queue_remove":
    case "queue_confirm": {
      const count = Math.max(1, snapshot.queue.length);
      const item = snapshot.queue[Math.min(state.queueIndex, count - 1)] ?? snapshot.queue[0];
      if (!item) return keep(state);
      return keep(state, intent.type === "queue_remove"
        ? { kind: "removeQueued", id: item.id }
        : { kind: "confirmQueued", id: item.id });
    }

    case "restore_toggle_inspect":
      return move(state, { restoreInspect: !state.restoreInspect });

    case "restore_new":
      return keep(state, { kind: "startNewSessions" });

    case "restore_confirm":
      return state.destructiveConfirm
        ? keep(state, { kind: "restoreSessions" })
        : move(state, { destructiveConfirm: true });

    case "sessions_settled":
      return move(state, { overlay: null, destructiveConfirm: false });

    case "reset_confirm":
      return state.destructiveConfirm
        ? keep(state, { kind: "resetSession", provider: snapshot.focusedProvider })
        : move(state, { destructiveConfirm: true });

    case "session_reset":
      return move(state, { destructiveConfirm: false, overlay: intent.reset ? null : state.overlay });

    // ── Model and roles ───────────────────────────────────────────────────────
    case "model_swap_provider": {
      const next = state.modelProvider === "claude" ? "codex" : "claude";
      return move(state, { modelProvider: next, modelDraft: snapshot.lanes[next].requestedModel });
    }

    case "model_submit":
      return move(state, { overlay: null }, { kind: "setModel", provider: state.modelProvider, model: state.modelDraft });

    case "model_erase":
      return move(state, { modelDraft: removeLastGrapheme(state.modelDraft) });

    case "model_type":
      return move(state, { modelDraft: state.modelDraft + intent.text });

    case "role_move":
      return move(state, { roleIndex: (state.roleIndex + intent.offset + ROLE_IDS.length) % ROLE_IDS.length });

    case "role_swap_provider":
      return move(state, { roleProvider: state.roleProvider === "claude" ? "codex" : "claude" });

    case "role_reset_chain":
      return keep(state, { kind: "resetRoleHandoffChain" });

    case "role_submit":
      return move(state, { overlay: null }, {
        kind: "setRole",
        role: ROLE_IDS[state.roleIndex] ?? "scout",
        provider: state.roleProvider,
      });

    // ── Review and findings ───────────────────────────────────────────────────
    case "review_cycle_mechanism": {
      if (!snapshot.review) return keep(state);
      const mechanisms = snapshot.review.availableMechanisms;
      const next = mechanisms[(mechanisms.indexOf(snapshot.review.mechanism) + 1) % mechanisms.length];
      return next ? keep(state, { kind: "setReviewMechanism", mechanism: next }) : keep(state);
    }

    case "review_two_lens":
      return keep(state, { kind: "startTwoLensReview", criteria: state.reviewCriteria });

    case "review_submit":
      return keep(state, { kind: "startReview", criteria: state.reviewCriteria });

    case "review_started":
      return intent.started ? move(state, closedOverlay(state, "review")) : keep(state);

    case "review_erase":
      return move(state, { reviewCriteria: removeLastGrapheme(state.reviewCriteria) });

    case "review_type":
      return move(state, { reviewCriteria: state.reviewCriteria + intent.text });

    case "findings_swap_lens": {
      if (!snapshot.review?.twoLens) return keep(state);
      const next = snapshot.review.activeLens === "claude" ? "codex" : "claude";
      return move(state, { findingIndex: 0 }, { kind: "selectReviewLens", provider: next });
    }

    case "findings_move": {
      const count = Math.max(1, snapshot.review?.findings.length ?? 0);
      const next = (state.findingIndex + intent.offset + count) % count;
      return move(state, { findingIndex: next }, ...selectFindingAt(snapshot, next));
    }

    case "findings_toggle": {
      const finding = snapshot.review?.findings[state.findingIndex] ?? snapshot.review?.findings[0];
      return finding ? keep(state, { kind: "toggleFinding", id: finding.id }) : keep(state);
    }

    case "findings_accept":
      return keep(state, { kind: "finishReview", outcome: "accept" });

    case "findings_exit":
      return keep(state, { kind: "finishReview", outcome: "exit" });

    case "review_finished":
      return intent.finished ? move(state, { overlay: null }) : keep(state);

    case "findings_toggle_stale":
      return snapshot.review?.stale ? move(state, { staleAcknowledged: !state.staleAcknowledged }) : keep(state);

    case "findings_return":
      return snapshot.review
        ? keep(state, { kind: "returnSelectedFindings", staleAcknowledged: state.staleAcknowledged })
        : keep(state);

    case "findings_relayed":
      // The relay lands in the composer and hands the writer gate back, so the
      // confirmation restarts from its first step.
      return intent.relay === null ? keep(state) : move(state, {
        prompt: intent.relay,
        writerProvider: intent.writer,
        writerConfirm: false,
        overlay: "writer",
      });

    // ── Role handoff ──────────────────────────────────────────────────────────
    case "handoff_confirm":
      return keep(state, { kind: "confirmRoleHandoff" });

    case "handoff_prompt":
      return intent.prompt === null ? keep(state) : move(state, { prompt: intent.prompt, overlay: null });

    case "handoff_prepared":
      return intent.ready ? move(state, { overlay: "handoff" }) : keep(state);

    // ── Isolated worktrees ────────────────────────────────────────────────────
    case "isolated_start":
      return snapshot.isolated?.lifecycle === "preview" ? keep(state, { kind: "startIsolated" }) : keep(state);

    case "isolated_cancel_plan":
      return snapshot.isolated?.lifecycle === "preview"
        ? move(state, { overlay: null }, { kind: "cancelIsolatedPlan" })
        : keep(state);

    case "isolated_refresh":
      return isolatedActionable(snapshot) ? keep(state, { kind: "refreshIsolated" }) : keep(state);

    case "isolated_retain":
      return isolatedActionable(snapshot) ? keep(state, { kind: "retainIsolated" }) : keep(state);

    case "isolated_cleanup":
      if (!isolatedActionable(snapshot)) return keep(state);
      return state.destructiveConfirm
        ? move(state, { isolatedDiscardConfirm: false }, { kind: "cleanupIsolated" })
        : move(state, { isolatedDiscardConfirm: false, destructiveConfirm: true });

    case "isolated_cleaned":
      return move(state, { destructiveConfirm: false });

    case "isolated_discard":
      if (!isolatedActionable(snapshot)) return keep(state);
      return state.isolatedDiscardConfirm
        ? move(state, { destructiveConfirm: false }, { kind: "discardIsolated" })
        : move(state, { destructiveConfirm: false, isolatedDiscardConfirm: true });

    case "isolated_discarded":
      return move(state, {
        isolatedDiscardConfirm: false,
        ...(intent.discarded ? closedOverlay(state, "isolated") : {}),
      });

    case "isolated_prepared":
      return intent.ready ? move(state, { overlay: "isolated" }) : keep(state);

    // ── Inspector ─────────────────────────────────────────────────────────────
    case "focus_inspector": {
      if (!context.inspectorShown) {
        return keep(state, {
          kind: "notice",
          message: snapshot.inspectorVisible
            ? `The evidence inspector needs 100+ columns before Tab can focus it; this terminal is ${context.columns}. Option+0 focuses one lane.`
            : "The evidence inspector is hidden. Option+I shows it, then Tab focuses it.",
        });
      }
      const path = snapshot.git.files[state.evidenceIndex];
      return move(state, { inspectorFocused: true }, ...(path ? [{ kind: "selectEvidenceFile" as const, path }] : []));
    }

    case "blur_inspector":
      return move(state, { inspectorFocused: false });

    case "inspector_cycle_tab": {
      const index = INSPECTOR_TABS.indexOf(state.inspectorTab);
      const next = INSPECTOR_TABS[(index + intent.offset + INSPECTOR_TABS.length) % INSPECTOR_TABS.length] ?? "changes";
      return move(state, { inspectorTab: next });
    }

    case "inspector_move": {
      const count = snapshot.git.files.length;
      if (!count) return keep(state, { kind: "notice", message: "No changed files to preview. ^E rechecks the working tree." });
      const next = Math.max(0, Math.min(count - 1, state.evidenceIndex + intent.offset));
      const path = snapshot.git.files[next]!;
      return move(state, { evidenceIndex: next, inspectorTab: "file" }, { kind: "selectEvidenceFile", path });
    }

    case "toggle_inspector": {
      // The width warning belongs only to the turn-on direction; deliberately
      // hiding the inspector is never a failure to show it.
      const turningOn = !snapshot.inspectorVisible;
      const commands: InteractionCommand[] = [{ kind: "toggleInspector" }];
      if (!turningOn) return move(state, { inspectorFocused: false }, ...commands);
      commands.push(context.inspectorWouldFit
        ? { kind: "refreshEvidence" }
        : { kind: "notice", message: `Evidence inspector needs 100+ columns; this terminal is ${context.columns}. Option+0 focuses one lane.` });
      return keep(state, ...commands);
    }

    // ── Global actions ────────────────────────────────────────────────────────
    case "toggle_composer_mode": {
      const next: ComposerMode = state.composerMode === "flow" ? "direct" : "flow";
      if (next !== "flow") return move(state, { composerMode: next });
      // Task flow always builds with Codex. Say that the route and focus moved
      // rather than changing them silently, since every other route change is
      // something the user asked for explicitly.
      const moved = snapshot.target !== "codex" || snapshot.focusedProvider !== "codex";
      const commands: InteractionCommand[] = [{ kind: "focus", provider: "codex" }, { kind: "setTarget", target: "codex" }];
      if (moved) {
        commands.push({ kind: "notice", message: "Task flow builds with Codex, so the send route and lane focus moved to Codex." });
      }
      return move(state, { composerMode: next }, ...commands);
    }

    case "focus_lane":
      return keep(state, { kind: "focus", provider: intent.provider });

    case "cycle_target":
      return move(state, { composerMode: "direct" }, { kind: "cycleTarget" });

    case "cancel_focused":
      return keep(state, { kind: "cancel", provider: snapshot.focusedProvider });

    case "refresh_evidence":
      return keep(state, { kind: "refreshEvidence" });

    case "open_review":
      return move(state, { reviewCriteria: "" }, { kind: "prepareReview" });

    case "review_prepared":
      return intent.ready ? move(state, { overlay: "review" }) : keep(state);

    case "open_findings": {
      if (!snapshot.review) {
        return keep(state, {
          kind: "notice",
          message: "Review findings are available only after a review draft or completed review exists.",
        });
      }
      return move(state, { findingIndex: 0, staleAcknowledged: false, overlay: "findings" }, ...selectFindingAt(snapshot, 0));
    }

    case "open_writer":
      if (snapshot.mode !== "compare") {
        return keep(state, { kind: "notice", message: "Writer promotion is available only from compare mode." });
      }
      return move(state, { writerProvider: snapshot.focusedProvider, writerConfirm: false, overlay: "writer" });

    case "revoke_writer":
      return snapshot.writer
        ? keep(state, { kind: "revokeWriter" })
        : keep(state, { kind: "notice", message: "There is no writer lease to revoke." });

    case "open_approvals":
      return move(state, { approvalIndex: 0, armedApproval: null, dismissedApprovalCount: 0, overlay: "approval" });

    case "open_model":
      return move(state, {
        modelProvider: snapshot.focusedProvider,
        modelDraft: snapshot.lanes[snapshot.focusedProvider].requestedModel,
        overlay: "model",
      });

    case "open_actions":
      return move(state, { overlay: "actions" });

    case "open_help":
      return move(state, { overlay: "help" });

    case "open_activity": {
      const activities = snapshot.lanes[snapshot.focusedProvider].activities;
      return move(state, {
        activityIndex: Math.max(0, activities.length - 1),
        activityExpanded: snapshot.configuration.showTools === "expanded",
        overlay: "activity",
      });
    }

    case "open_queue":
      return move(state, { queueIndex: 0, overlay: "queue" });

    case "open_configuration":
      return move(state, { overlay: "configuration" });

    case "open_reset_session":
      return move(state, { destructiveConfirm: false, overlay: "reset_session" });

    case "open_handoff":
      return keep(state, { kind: "prepareRoleHandoff", prompt: state.prompt });

    case "open_isolated":
      return snapshot.isolated && snapshot.isolated.lifecycle !== "cleaned"
        ? move(state, { destructiveConfirm: false, isolatedDiscardConfirm: false, overlay: "isolated" })
        : move(state, { destructiveConfirm: false, isolatedDiscardConfirm: false }, { kind: "prepareIsolated" });

    case "open_diagnostics":
      return move(state, { overlay: "diagnostics" });

    case "open_roles":
      return move(state, { roleProvider: snapshot.roles[ROLE_IDS[state.roleIndex] ?? "scout"], overlay: "roles" });

    // ── Composer ──────────────────────────────────────────────────────────────
    case "submit":
      if (state.composerMode !== "flow") return keep(state, { kind: "dispatch", prompt: state.prompt });
      if (!state.prompt.trim()) return keep(state, { kind: "notice", message: "Task is empty." });
      if (snapshot.mode !== "compare") {
        return keep(state, {
          kind: "notice",
          message: "Task Flow starts only from compare mode; finish or revoke the current workflow first.",
        });
      }
      return move(state, { writerConfirm: false, overlay: "flow_start" });

    case "dispatch_settled":
      return intent.sent ? move(state, { prompt: "" }) : keep(state);

    case "erase":
      return move(state, { prompt: removeLastGrapheme(state.prompt) });

    case "type":
      return move(state, { prompt: state.prompt + intent.text });

    // ── Snapshot-driven ───────────────────────────────────────────────────────
    case "approvals_changed": {
      if (snapshot.approvals.length === 0) {
        return state.overlay === "approval" ? move(state, { overlay: null }) : keep(state);
      }
      const approvalIndex = Math.min(state.approvalIndex, snapshot.approvals.length - 1);
      // An approval must never take input away from an overlay that already owns
      // it: the draft would be lost and the single-key decisions would land under
      // fingers that were typing something else.
      const opens = state.overlay === null && state.dismissedApprovalCount !== snapshot.approvals.length;
      return move(state, { approvalIndex, ...(opens ? { overlay: "approval" as Overlay } : {}) });
    }

    case "queue_offer_changed":
      if (snapshot.queueOffer) return move(state, { overlay: "queue_offer" });
      return state.overlay === "queue_offer" ? move(state, { overlay: null }) : keep(state);

    case "restorable_changed":
      return snapshot.restorableSessions.length ? move(state, { overlay: "restore" }) : keep(state);

    case "review_status_changed":
      if (!(snapshot.mode === "review" && snapshot.review && snapshot.review.status !== "running")) return keep(state);
      return move(
        state,
        { findingIndex: 0, staleAcknowledged: false, overlay: "findings" },
        ...selectFindingAt(snapshot, 0),
      );

    case "guided_build_status": {
      if (!state.guidedBuildActive) return keep(state);
      const status = snapshot.lanes.codex.status;
      if (status === "COMPLETED" && snapshot.mode === "build" && snapshot.writer === "codex") {
        return move(state, { guidedBuildActive: false, reviewCriteria: "" }, { kind: "prepareReview" });
      }
      if (["FAILED", "CANCELLED", "UNAVAILABLE"].includes(status)) {
        return move(state, { guidedBuildActive: false }, {
          kind: "notice",
          message: `Task flow stopped after Codex ${status.toLowerCase()}; Claude challenge was not started.`,
        });
      }
      return keep(state);
    }

    case "evidence_files_changed":
      return move(state, { evidenceIndex: Math.min(state.evidenceIndex, Math.max(0, snapshot.git.files.length - 1)) });

    case "queue_length_changed":
      return move(state, { queueIndex: Math.min(state.queueIndex, Math.max(0, snapshot.queue.length - 1)) });
  }
}

function isolatedActionable(snapshot: AppSnapshot): boolean {
  const lifecycle = snapshot.isolated?.lifecycle;
  return Boolean(lifecycle) && lifecycle !== "preview" && lifecycle !== "cleaned";
}
