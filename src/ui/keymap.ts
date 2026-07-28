import type { Intent, Overlay } from "./interaction.ts";

/** Ink's key object, narrowed to what the map reads. A plain shape so the map can
 * be exercised with synthetic keystrokes instead of a live terminal. */
export interface KeyEvent {
  input: string;
  ctrl?: boolean;
  meta?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  backspace?: boolean;
  delete?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
}

/** Intents the renderer answers itself because they need viewport geometry. */
export type ViewportIntent =
  | { type: "scroll_page"; direction: "up" | "down" | "top" | "bottom" }
  | { type: "toggle_view" };

export type ResolvedIntent = Intent | ViewportIntent;

export interface KeyScope {
  overlay: Overlay;
  inspectorFocused: boolean;
}

export function isViewportIntent(intent: ResolvedIntent): intent is ViewportIntent {
  return intent.type === "scroll_page" || intent.type === "toggle_view";
}

/** Ink reports Ctrl+<letter> as the bare letter with `ctrl` set, so an action
 * matched on the letter alone also fires for the Ctrl shortcut that shares it —
 * that is how Ctrl+G once granted a writer lease from the task-flow confirmation.
 * Every letter action in this file goes through `letter`, which is empty for a
 * modified keystroke. */
function letter(key: KeyEvent): string {
  return key.ctrl || key.meta ? "" : key.input.toLowerCase();
}

function ctrl(key: KeyEvent, name: string): boolean {
  return Boolean(key.ctrl) && key.input === name;
}

function meta(key: KeyEvent, name: string): boolean {
  return Boolean(key.meta) && key.input.toLowerCase() === name;
}

/** Text that belongs in a field rather than in a shortcut. */
function typed(key: KeyEvent): string | null {
  return !key.ctrl && !key.meta && key.input ? key.input : null;
}

export function resolveIntent(key: KeyEvent, scope: KeyScope): ResolvedIntent | null {
  if (ctrl(key, "q")) return { type: "quit" };
  if (key.escape) return !scope.overlay && scope.inspectorFocused ? { type: "blur_inspector" } : { type: "escape" };

  const overlayIntent = scope.overlay ? resolveOverlay(key, scope.overlay) : null;
  // An overlay owns input completely: an unmapped key inside one must not fall
  // through to a global shortcut, or a modal would answer keys it never showed.
  if (scope.overlay) return overlayIntent;

  if (scope.inspectorFocused) {
    if (key.tab) return { type: "blur_inspector" };
    if (key.input === "[" || key.input === "]") return { type: "inspector_cycle_tab", offset: key.input === "]" ? 1 : -1 };
    if (key.upArrow || key.downArrow) return { type: "inspector_move", offset: key.downArrow ? 1 : -1 };
    // Only modifier shortcuts continue past the inspector. Text keys stop here:
    // falling through appended them to the composer while the user believed they
    // were navigating a read-only panel, and the Enter that followed opened the
    // writer-grant gate on a prompt nobody wrote.
    if (key.return || key.backspace || key.delete || typed(key)) return null;
  }

  if (key.tab) return { type: "focus_inspector" };
  if (key.pageUp) return { type: "scroll_page", direction: "up" };
  if (key.pageDown) return { type: "scroll_page", direction: "down" };
  if (key.home) return { type: "scroll_page", direction: "top" };
  if (key.end) return { type: "scroll_page", direction: "bottom" };

  if (meta(key, "d")) return { type: "toggle_composer_mode" };
  if (key.meta && key.input === "0") return { type: "toggle_view" };
  if (key.meta && key.input === "1") return { type: "focus_lane", provider: "claude" };
  if (key.meta && key.input === "2") return { type: "focus_lane", provider: "codex" };
  if (meta(key, "i")) return { type: "toggle_inspector" };
  if (meta(key, "m")) return { type: "open_model" };
  if (meta(key, "h")) return { type: "open_handoff" };

  if (ctrl(key, "r")) return { type: "cycle_target" };
  if (ctrl(key, "x")) return { type: "cancel_focused" };
  if (ctrl(key, "e")) return { type: "refresh_evidence" };
  if (ctrl(key, "v")) return { type: "open_review" };
  if (ctrl(key, "f")) return { type: "open_findings" };
  if (ctrl(key, "b")) return { type: "open_writer" };
  if (ctrl(key, "w")) return { type: "revoke_writer" };
  if (ctrl(key, "a")) return { type: "open_approvals" };
  if (ctrl(key, "p")) return { type: "open_actions" };
  if (ctrl(key, "g")) return { type: "open_help" };
  if (ctrl(key, "t")) return { type: "open_activity" };
  if (ctrl(key, "k")) return { type: "open_queue" };
  if (ctrl(key, "u")) return { type: "open_configuration" };
  if (ctrl(key, "n")) return { type: "open_reset_session" };
  if (ctrl(key, "l")) return { type: "open_isolated" };
  if (ctrl(key, "d")) return { type: "open_diagnostics" };
  if (ctrl(key, "o")) return { type: "open_roles" };

  if (key.return) return { type: "submit" };
  if (key.backspace || key.delete) return { type: "erase" };
  const text = typed(key);
  return text ? { type: "type", text } : null;
}

function resolveOverlay(key: KeyEvent, overlay: NonNullable<Overlay>): Intent | null {
  switch (overlay) {
    case "help":
      return ctrl(key, "g") ? { type: "close_overlay" } : null;
    case "actions":
      return ctrl(key, "p") ? { type: "close_overlay" } : null;
    case "diagnostics":
      return ctrl(key, "d") ? { type: "close_overlay" } : null;
    case "configuration":
      return ctrl(key, "u") ? { type: "close_overlay" } : null;

    case "flow_start":
      if (meta(key, "d")) return { type: "flow_to_direct" };
      if (key.return) return { type: "flow_enter" };
      return letter(key) === "g" ? { type: "flow_grant" } : null;

    case "writer":
      if (key.tab) return { type: "writer_swap_provider" };
      if (key.return) return { type: "writer_enter" };
      return letter(key) === "g" ? { type: "writer_grant" } : null;

    case "approval":
      if (key.upArrow) return { type: "approval_move", offset: -1 };
      if (key.downArrow) return { type: "approval_move", offset: 1 };
      if (letter(key) === "a") return { type: "approval_allow" };
      if (letter(key) === "d") return { type: "approval_deny" };
      return letter(key) === "x" ? { type: "approval_cancel_turn" } : null;

    case "activity":
      if (key.upArrow) return { type: "activity_move", offset: -1 };
      if (key.downArrow) return { type: "activity_move", offset: 1 };
      if (key.input === " ") return { type: "activity_toggle_expand" };
      return ctrl(key, "t") ? { type: "close_overlay" } : null;

    case "queue_offer":
      if (letter(key) === "q") return { type: "queue_offer_confirm" };
      return letter(key) === "c" ? { type: "queue_offer_cancel" } : null;

    case "queue":
      if (key.upArrow) return { type: "queue_move", offset: -1 };
      if (key.downArrow) return { type: "queue_move", offset: 1 };
      if (letter(key) === "d") return { type: "queue_remove" };
      return letter(key) === "c" ? { type: "queue_confirm" } : null;

    case "restore":
      if (letter(key) === "i") return { type: "restore_toggle_inspect" };
      if (letter(key) === "n") return { type: "restore_new" };
      return letter(key) === "r" ? { type: "restore_confirm" } : null;

    case "reset_session":
      return letter(key) === "r" ? { type: "reset_confirm" } : null;

    case "model":
      if (key.tab) return { type: "model_swap_provider" };
      if (key.return) return { type: "model_submit" };
      if (key.backspace || key.delete) return { type: "model_erase" };
      // A field takes every unmodified key, which is also why no letter in this
      // overlay may be bound to an action.
      return key.ctrl || key.meta ? null : { type: "model_type", text: key.input };

    case "roles":
      if (key.upArrow) return { type: "role_move", offset: -1 };
      if (key.downArrow) return { type: "role_move", offset: 1 };
      if (key.tab) return { type: "role_swap_provider" };
      if (letter(key) === "x") return { type: "role_reset_chain" };
      return key.return ? { type: "role_submit" } : null;

    case "review":
      if (key.tab) return { type: "review_cycle_mechanism" };
      if (meta(key, "t")) return { type: "review_two_lens" };
      if (key.return) return { type: "review_submit" };
      if (key.backspace || key.delete) return { type: "review_erase" };
      return key.ctrl || key.meta ? null : { type: "review_type", text: key.input };

    case "findings":
      if (key.tab) return { type: "findings_swap_lens" };
      if (key.upArrow) return { type: "findings_move", offset: -1 };
      if (key.downArrow) return { type: "findings_move", offset: 1 };
      if (key.input === " ") return { type: "findings_toggle" };
      if (letter(key) === "a") return { type: "findings_accept" };
      if (letter(key) === "e") return { type: "findings_exit" };
      if (letter(key) === "s") return { type: "findings_toggle_stale" };
      return letter(key) === "r" ? { type: "findings_return" } : null;

    case "handoff":
      return key.return ? { type: "handoff_confirm" } : null;

    case "isolated":
      if (key.return) return { type: "isolated_start" };
      if (letter(key) === "x") return { type: "isolated_cancel_plan" };
      if (letter(key) === "r") return { type: "isolated_refresh" };
      if (letter(key) === "k") return { type: "isolated_retain" };
      if (letter(key) === "c") return { type: "isolated_cleanup" };
      return letter(key) === "d" ? { type: "isolated_discard" } : null;
  }
}
