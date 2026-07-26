# Provider Adapter Contract Draft

Status: M0 draft; not a production stack decision

Last updated: 2026-07-26

## Boundary

An adapter translates one official provider transport into normalized events. It
does not render UI, decide routing, infer workspace ownership, execute Git
inspection, or persist credentials. Provider-specific flags and JSON never cross
this boundary.

Conceptual interface:

```text
probe() -> ProbeResult
start_session(options) -> SessionHandle
resume_session(provider_session_id, options) -> SessionHandle
start_turn(session, immutable_prompt, options) -> Async<NormalizedEvent>
respond_approval(provider_request_id, provider_supported_decision) -> Result
interrupt(turn_id) -> InterruptResult
close() -> CloseResult
```

Every operation is scoped to exactly one provider. Handles include their
provider identity, and the orchestrator must reject cross-provider IDs before an
adapter sees them.

## Probe result

`probe()` reports binary availability, version, coarse authentication state,
transport initialization status, and capability descriptors conforming to
`schemas/capability-manifest.schema.json`.

`available` means the current transport can be selected safely for its declared
effect. `blocked` means the CLI surface exists but a requirement such as a live
approval proof has not been met. Version text alone is never enough when a help,
schema, or initialization probe is possible.

## Session and turn options

Common options are provider-neutral:

```text
project_root
requested_model: default | exact provider model ID
effort: provider-supported value | default
workspace_access: read_only | workspace_write
approval_policy: provider-supported policy
deadline
native_capability: optional capability ID and typed input
```

`default` passes no model override. An adapter must return the requested and
effective model separately when the transport exposes both. It must never retry
with another model after an invalid-model failure.

The adapter rejects `workspace_write` unless the orchestrator presents a valid
single-writer lease for that provider and project. Compare and review calls can
only request `read_only`.

## Event rules

Events conform to `schemas/normalized-event.schema.json`. Event IDs are unique
within a run. Provider session and turn IDs are retained as opaque values and
are never reconstructed from prompt history.

Unknown or malformed provider messages become bounded raw diagnostics and, when
useful to the operator, a `provider.warning`. They do not trigger guessed state
transitions. File events are hints for the independent Git observer, not proof
of authorship.

Native events retain provider attribution, capability ID, stability, native
kind, and safety effect. An adapter cannot promote an unknown native event into
a common state transition.

## Cancellation and cleanup

Each provider is launched in its own process group. Interruption first uses a
supported turn-level method when available, then waits a bounded interval. Close
and forced cancellation terminate the whole process group, escalating from
SIGTERM to SIGKILL after the grace period. A forced kill marks provider resume
as requiring validation; it does not affect the other lane.

Adapter shutdown is idempotent. A failed or already-exited process is not a
reason to stop the other provider.

## Approval contract

An approval request exposes only decisions supported by the provider and
includes provider, request ID, command/tool, working directory, affected paths,
network effect, reason, and request timestamp when known.

No adapter may translate a missing approval callback into a bypass flag. Until a
request/response round trip is proven, `interactive_approval` remains `blocked`
and that transport cannot support build mode.

## Diagnostics and secrets

Terminal control sequences are removed before events reach rendering or logs.
Retained output is bounded. Probe and diagnostic records exclude tokens, email,
organization identifiers, credential paths, environment secrets, and provider
configuration contents.
