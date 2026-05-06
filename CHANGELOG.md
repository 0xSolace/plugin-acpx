# Changelog

## 0.1.0 (2026-05-06)

Stable graduation release for `@0xsolace/plugin-acpx`, the ACP-backed task and subagent backend for ElizaOS.

### Features

- Added ElizaOS plugin integration for spawning coding-agent sessions through the `acpx` CLI.
- Added `SPAWN_AGENT`, `SEND_TO_AGENT`, `LIST_AGENTS`, `STOP_AGENT`, `CREATE_TASK`, and `CANCEL_TASK` actions with compatibility shapes for `@elizaos/plugin-agent-orchestrator` consumers.
- Added `AcpxSubprocessService` / `AcpService` for long-lived subprocess session lifecycle management.
- Added parallel session support so multiple codex, claude, or gemini workers can run from the same runtime without PTY state collisions.
- Added structured event streaming from acpx JSON-RPC / NDJSON, including agent message chunks, tool-call updates, task completion, blocked states, auth failures, reconnects, and errors.
- Added cooperative cancellation and stop handling for in-flight prompts and sessions.
- Added auto-approval preset mapping for read-only, auto/permissive, autonomous, and full-access agent runs.
- Added provider support for installed/auth-status discovery so the runtime can choose among codex, claude, gemini, and other acpx-backed adapters.
- Added tiered persistence via runtime SQL adapters, file state, or in-memory fallback.
- Added an e2e smoke test that spawns a real acpx + codex session and verifies completion.

### Architecture

- Replaced terminal scraping with ACP JSON-RPC as the transport boundary: typed events are parsed directly instead of extracting intent from ANSI escape sequences, prompt regexes, or PTY buffers.
- Kept the plugin-agent-orchestrator action surface while moving the implementation to a cleaner ACP subprocess service, making this a sibling transport rather than a replacement product.
- Preserved container-boundary cleanliness: Eliza remains the coordinating IDE/runtime, while codex, claude, gemini, and future ACP agents remain the code agents executing inside their own authenticated CLIs.
- Added session/load recovery hooks and dead-process reattach behavior so persisted sessions can be rediscovered after runtime restarts when the underlying acpx/agent state is still available.
- Centralized state, prompt timeout, approval, workspace-root, and service-alias configuration behind `ELIZA_ACP_*` environment variables.

### Production validation

- Verified on 2026-05-06 with Nyx running three parallel acpx-spawned codex subagents against real Cloudflare Worker deployment tasks.
- Production receipt sessions:
  - `nebula-callsign-forge-demo`, deployed cleanly.
  - `embermark-night-signal`, deployed cleanly.
  - `aurora-pocket`, deployed cleanly.
- This validates concurrent spawn, prompt streaming, task completion, and practical deployment workflow readiness for default-canon adoption work in Eliza.

### Tooling and release readiness

- Bumped package version from `0.1.0-rc.1` to `0.1.0`.
- Completed npm metadata for repository, bugs, homepage, license, author, keywords, and publish files.
- Updated README and project status documentation for stable release expectations.
- Ensured unit tests pass under `bun test`, including Bun-compatible test shims for mocked child processes and isolated action state.
