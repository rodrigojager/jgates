# Phase 1a: Reconnaissance (JGates adaptation)

Adapted from `skills/security-audit/RECONNAISSANCE.md` ("Phase 1: Map the source and plan coverage", agents 1a-1d).
Upstream launches four parallel `research` agents that return structured facts to the parent. JGates runs them as
one bounded reconnaissance context whose four sections keep the four agents' questions; the parent's synthesis
(architecture summary, companion selection and the deterministic coverage ledger) is the separate coverage-planning
context. Reconnaissance reads the resolved scope only and writes nothing.

<!-- block:instructions -->
Map the source of the subjects to examine and the allowed context; do not use network access and do not run anything. Return only source facts with workspace-relative paths and line numbers of files you actually read. Do not infer live reachability. Cover the four reconnaissance questions below in their own sections of the artifact.

1a Product, stack, and local operation: product type, users, operators, and ordinary trust-sensitive actions; languages, frameworks, build system, runtimes, and locally visible deployment models; entry points and subsystem boundaries; comparable software or protocol visible from local documentation and dependencies (if no useful comparison is source-grounded, say so); missing local toolchains or runtime facts that limit validation.

1b Principals, authority, and controls: each lower-trust principal and the actions it has by design; authentication or peer identity at each entry surface; per-resource authorization and tenant/owner scope; process, browser, workload, CI, plugin, model/tool, device, or local-IPC authority; privilege changes, confirmation, revocation, recovery, and fallback paths; which controls are source-visible and which depend on an unobserved deployment fact. Return trust boundaries and control locations.

1c Entry surfaces, copies, and sinks: inventory every source-visible place external or lower-trust input enters (HTTP/browser, RPC/message/protocol, files/archive/document, CLI/env/config, plugins/dependencies/CI, cloud events/IAM selectors, model context/tool arguments, mobile/deep-link/webview, and local IPC). For each surface, follow major transformations, stored or derived copies, and security-relevant sinks. Record source-visible limits and parallel paths to the same effect. Be complete, but do not execute or send inputs.

1d Local validation and deployment visibility: small offline tests or existing fixtures that could validate trust boundaries with dummy data (they are not run here; they feed validation plans); commands that would fetch dependencies, publish artifacts, contact paid/provider APIs, or affect shared state (prohibited); deployed controls and attachments that source cannot establish and therefore require needs_validation if decisive; the final active source path for each deployment mode only where the repository selects it deterministically.

Record the assumptions you made and every omission: an area of the scope you could not map (and why), or a materially distinct deployment mode or subsystem these questions do not map. An omission is never silently dropped: coverage planning turns it into a ledger unit. Suggest the domain companion files whose "When to use this file" boundary you found, with the source fact that requires each; do not suggest a companion merely because a language or dependency name appears.
<!-- /block -->
