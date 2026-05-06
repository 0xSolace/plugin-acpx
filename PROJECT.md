# @0xsolace/plugin-acpx

ElizaOS plugin: an acpx-backed task and subagent backend that wraps the `acpx` CLI to spawn coding agents as local subprocesses.

`plugin-acpx` is a sibling transport to `@elizaos/plugin-agent-orchestrator`. It keeps the familiar task-agent action surface, but uses Agent Client Protocol JSON-RPC events instead of PTY scraping. It is also distinct from `@elizaos/plugin-acp`, which is Shaw's ACP gateway client for IDE bridge flows.

## 0.1.0 reality

Status: stable release prep complete for `0.1.0`.

This package now implements the full v0.1 task-agent backend:

- acpx CLI subprocess integration
- codex, claude, gemini, and acpx adapter selection support
- parallel coding-agent sessions
- JSON-RPC / NDJSON event parsing
- message, tool, blocked, auth, completion, error, stopped, and reconnect session events
- cooperative cancel and stop paths
- runtime SQL, file, or memory-backed session persistence
- plugin-agent-orchestrator-compatible action result shapes
- `PTY_SERVICE` compatibility alias, enabled by default
- unit tests plus a real acpx + codex e2e smoke script

## Product framing

Eliza is the IDE, not the code agent.

The runtime coordinates intent, sessions, context, memory, and user-facing actions. The actual code-writing capability stays in the dedicated coding-agent CLIs, such as codex, claude, or gemini, launched through acpx. That boundary keeps Eliza from becoming a fragile terminal emulator while still giving it a clean, typed task execution backend.

## Why this exists

`plugin-agent-orchestrator` runs agents inside pseudo-terminals and recovers structure from terminal bytes: ANSI stripping, prompt regex dismissal, stall classifiers, key sends, and PTY state capture.

Agent Client Protocol gives us the structure directly:

- typed `session/update` events
- message chunks without screen-buffer reads
- tool-call lifecycle updates without regex parsing
- auth and blocked states as protocol events
- cooperative `session/cancel`
- `session/load` recovery semantics

`plugin-acpx` exists to expose those ACP semantics to Eliza while preserving the action names existing orchestrator flows already understand.

## Goals for 0.1.x

- Keep action compatibility with `plugin-agent-orchestrator`.
- Prefer ACP typed events over PTY parsing everywhere possible.
- Keep subprocesses container-local and explicit, no hidden remote execution.
- Make codex production-grade first, while preserving adapter selection for claude and gemini.
- Maintain clean test, build, and Biome receipts before npm release.

## Non-goals

- Replacing `plugin-agent-orchestrator` outright.
- Implementing git workspace provisioning actions in this package.
- Building an xterm frontend view.
- Publishing to npm from the release-prep branch.
- Owning authentication for codex, claude, gemini, or other CLIs. Those CLIs must already be installed and authenticated on the host.

## Action surface

| Action | Purpose |
|---|---|
| `SPAWN_AGENT` | Spawn an acpx coding-agent session. |
| `SEND_TO_AGENT` | Send prompt or input to a running session. |
| `LIST_AGENTS` | List active and persisted sessions. |
| `STOP_AGENT` | Stop a session through cooperative cancel / close handling. |
| `CREATE_TASK` | Spawn, prompt, await completion, and return a task result. |
| `CANCEL_TASK` | Cancel one in-flight task or all sessions. |

## Provider

`availableAgentsProvider` exposes installed/auth-status and active-session information to runtime state so the model can pick the right coding agent.

## Architecture

```text
┌─────────────────────────┐
│ Eliza runtime           │
│  ├─ actions             │
│  ├─ provider            │
│  └─ service registry    │
└──────────┬──────────────┘
           │
┌──────────v──────────────┐
│ AcpxSubprocessService   │
│  - spawn acpx process   │
│  - parse NDJSON stream  │
│  - emit typed events    │
│  - persist sessions     │
│  - cancel / reconnect   │
└──────────┬──────────────┘
           │
┌──────────v──────────────┐
│ acpx CLI subprocess     │
│  codex / claude / etc   │
│  Agent Client Protocol  │
└─────────────────────────┘
```

## Production receipt

On 2026-05-06, Nyx used this plugin path to run three parallel acpx-spawned codex subagents. Each completed a real Cloudflare Worker deployment:

- `nebula-callsign-forge-demo`
- `embermark-night-signal`
- `aurora-pocket`

That receipt validates parallel spawn, streaming, task completion, and deployment workflow behavior in production-like use.

## Layout

```text
src/
  index.ts
  actions/
  providers/
  services/
  __tests__/
  test-utils/
docs/
  ACPX_REFERENCE.md
  PARITY_SPEC.md
tests/e2e/
  acp-codex-smoke.mjs
```

## Release checks

Required before publishing:

```bash
bun test
bun run build
bunx @biomejs/biome check .
```

## License

MIT
