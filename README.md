# @0xsolace/plugin-acpx

[![npm version](https://img.shields.io/npm/v/@0xsolace/plugin-acpx.svg)](https://www.npmjs.com/package/@0xsolace/plugin-acpx)
[![CI](https://github.com/0xSolace/plugin-acpx/actions/workflows/ci.yml/badge.svg)](https://github.com/0xSolace/plugin-acpx/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

An **acpx-backed task and subagent plugin** for ElizaOS. It wraps the [`acpx`](https://github.com/0xouroboros/acp) CLI to spawn local coding agents, such as codex, claude, and gemini, as background sessions and exposes them through ElizaOS actions.

It is drop-in compatible with the action surface used by `@elizaos/plugin-agent-orchestrator`, but swaps the transport from terminal scraping to structured Agent Client Protocol events.

> Naming: this plugin is not `@elizaos/plugin-acp`. That package is Shaw's ACP gateway client for IDE bridge flows over a remote ACP gateway. `@0xsolace/plugin-acpx` is the local task backend that runs coding-agent subprocesses through the `acpx` CLI on the same host as the runtime.

## Product frame

Eliza is the IDE, not the code agent.

`plugin-acpx` lets Eliza coordinate work: intent, session lifecycle, context, user-visible actions, and runtime state. The actual code-writing remains inside purpose-built coding-agent CLIs, such as codex, claude, or gemini. That boundary is the point. Eliza should not become a brittle terminal emulator, and code agents should not need to know about Eliza internals.

## Why ACP instead of PTY parsing

`@elizaos/plugin-agent-orchestrator` runs coding agents inside pseudo-terminals and recovers structure from terminal bytes: ANSI escape stripping, prompt regexes, key sends, stall heuristics, and screen-buffer state.

That can work, but every terminal UI has different quirks. `plugin-acpx` uses `acpx`, which speaks Agent Client Protocol and emits typed JSON-RPC / NDJSON events:

- `agent_message_chunk` streaming text instead of PTY buffer reads
- `tool_call` and `tool_call_update` events instead of ANSI scraping
- blocked/auth states as protocol data instead of prompt regexes
- cooperative cancellation through ACP semantics
- session/load recovery paths for runtime restarts
- clean container boundaries: subprocesses stay local and explicit
- parallel sessions in the same workspace without terminal-state collisions

The plugin keeps the same action names so existing task-agent flows can move between transports by changing the plugin import and service alias configuration.

## Installation

```bash
npm install @0xsolace/plugin-acpx
npm install -g acpx@latest
acpx --version
```

`acpx` is intentionally not bundled as a runtime dependency. The package shells out to an executable, defaulting to `acpx` on `PATH`. If you install it somewhere else, set `ELIZA_ACP_CLI=/absolute/path/to/acpx`.

You also need at least one supported coding-agent CLI installed and authenticated on the same host:

```bash
codex --version
claude --version
gemini --version
```

Only install the CLIs you plan to use. Authentication is owned by those tools, not by this plugin.

## Quick start

```ts
import acpPlugin from "@0xsolace/plugin-acpx";

export default {
  plugins: [acpPlugin],
};
```

Once loaded, the plugin registers:

- `AcpxSubprocessService`
- `AcpService` export alias
- `ACP_SERVICE` / `ACP_SUBPROCESS_SERVICE`
- `PTY_SERVICE` compatibility alias by default
- six task-agent actions
- one available-agents provider

## Actions

| Action | Purpose |
| --- | --- |
| `SPAWN_AGENT` | Start a long-lived acpx coding-agent session. Returns `data.agents[]`. |
| `SEND_TO_AGENT` | Send a prompt, input, or key sequence to a running session. |
| `LIST_AGENTS` | List active and persisted sessions. |
| `STOP_AGENT` | Cooperatively cancel and close a session. |
| `CREATE_TASK` | One-shot: spawn, prompt, await completion, and return. Used by Nyx-style task agents. |
| `CANCEL_TASK` | Cancel one in-flight task or all active sessions. |

`CREATE_TASK` returns a shape compatible with `plugin-agent-orchestrator`:

```ts
{
  data: {
    agents: [{ id, sessionId, agentType, name, workdir }],
  },
  text: "...",
}
```

## Service usage

```ts
import { AcpService } from "@0xsolace/plugin-acpx";

const acp = runtime.getService("PTY_SERVICE") as AcpService;
// or: runtime.getService("ACP_SERVICE") as AcpService;

const { sessionId } = await acp.spawnSession({
  agentType: "codex",
  workdir: "/tmp/my-task",
  approvalPreset: "permissive",
});

const result = await acp.sendPrompt(sessionId, "what is 7 + 8?");
console.log(result.finalText); // "15"
console.log(result.stopReason); // "end_turn"
console.log(result.durationMs); // e.g. 4864
```

### Subscribing to events

```ts
acp.onSessionEvent((sessionId, eventName, data) => {
  // eventName: "ready" | "message" | "tool_running" | "task_complete" |
  // "stopped" | "error" | "blocked" | "login_required" | "reconnected"
  console.log(sessionId, eventName, data);
});
```

The `task_complete` event matches the orchestrator-compatible shape:

```ts
{ response: string, durationMs: number, stopReason: "end_turn" | "error" | string }
```

## Spawn parallel sessions

You can run several agents at once. Each session gets its own ID and can stream independently.

```ts
const specs = [
  { name: "nebula", task: "build and deploy the callsign worker" },
  { name: "ember", task: "build and deploy the night-signal worker" },
  { name: "aurora", task: "build and deploy the pocket worker" },
];

const sessions = await Promise.all(
  specs.map((spec) =>
    acp.spawnSession({
      name: spec.name,
      agentType: "codex",
      workdir: `/tmp/${spec.name}`,
      approvalPreset: "autonomous",
    }),
  ),
);

const results = await Promise.all(
  sessions.map((session, index) => acp.sendPrompt(session.sessionId, specs[index].task)),
);
```

This is the path validated on 2026-05-06 when Nyx ran three parallel acpx-spawned codex subagents and deployed three Cloudflare Workers: `nebula-callsign-forge-demo`, `embermark-night-signal`, and `aurora-pocket`.

## Configuration

All configuration is via environment variables. Most users only need `ELIZA_ACP_CLI` if `acpx` is not on `PATH`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ELIZA_ACP_CLI` | `acpx` | ACPX executable name or absolute path. |
| `ELIZA_ACP_DEFAULT_AGENT` | `codex` | Default agent type. |
| `ELIZA_ACP_DEFAULT_APPROVAL` | `autonomous` | Approval preset: `read-only`, `auto`, `permissive`, `autonomous`, or `full-access`. |
| `ELIZA_ACP_PROMPT_TIMEOUT_MS` | `1800000` | Per-prompt timeout, 30 minutes by default. |
| `ELIZA_ACP_AUTH_TIMEOUT_MS` | `120000` | Auth handshake timeout. |
| `ELIZA_ACP_STATE_DIR` | `~/.eliza/plugin-acpx` | Where to persist session state when no runtime DB is available. |
| `ELIZA_ACP_WORKSPACE_ROOT` | runtime cwd | Base directory for spawned agent workdirs. |
| `ELIZA_ACP_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |
| `ELIZA_ACP_MAX_SESSIONS` | unlimited | Concurrent session cap. |
| `ELIZA_ACP_REGISTER_AS_PTY_SERVICE` | `true` | Register service under `PTY_SERVICE` for back-compat. |

## Persistence

Session state uses a tiered backend:

1. If `runtime.databaseAdapter` exposes SQL methods, sessions live in an `acp_sessions` table.
2. Otherwise, sessions persist to `$ELIZA_ACP_STATE_DIR/sessions.json` with atomic temp-file writes.
3. Last resort is an in-memory `Map`, with a warning that sessions will not survive restart.

## Failure modes and operational notes

- **`acpx` not found:** install `acpx` globally or set `ELIZA_ACP_CLI` to an absolute executable path.
- **Agent CLI missing:** install `codex`, `claude`, `gemini`, or whichever acpx adapter you select.
- **Auth gates:** this plugin does not log into coding agents. Run the agent CLI manually first and complete device/browser auth.
- **Codex or acpx version skew:** if JSON-RPC events stop parsing or an adapter disappears, upgrade `acpx` and the affected agent CLI together.
- **Sandbox boundaries:** spawned agents run with the host permissions, working directory, sandbox, and approval mode provided to their CLI. Do not point autonomous agents at directories they should not edit.
- **Container boundaries:** `plugin-acpx` runs local subprocesses. If Eliza runs in a container, install `acpx` and the agent CLIs inside that container or mount explicit binaries and auth state.
- **Approval preset mismatch:** `autonomous` and `full-access` are powerful. Use `read-only` or `permissive` when validating a new runtime.
- **Prompt timeouts:** long coding tasks may exceed the default 30 minute prompt timeout. Increase `ELIZA_ACP_PROMPT_TIMEOUT_MS` for large migrations.

## End-to-end smoke test

The repo ships with a real e2e smoke at `tests/e2e/acp-codex-smoke.mjs`:

```bash
npm install -g acpx@latest
# authenticate codex first
bun run build
node tests/e2e/acp-codex-smoke.mjs
```

It spawns a real codex session, sends `what is 7 + 8?`, and verifies `task_complete` fires with response `15`.

## Compatibility with `@elizaos/plugin-agent-orchestrator`

You can run both plugins side-by-side. The actions do not conflict by name in practice because Eliza dispatches by description matching and runtime context, not only name collision.

To make `runtime.getService("PTY_SERVICE")` return the acpx subprocess service, keep `ELIZA_ACP_REGISTER_AS_PTY_SERVICE=true` and do not load `plugin-agent-orchestrator` as the owner of that alias.

To use both transports in the same runtime, set:

```bash
ELIZA_ACP_REGISTER_AS_PTY_SERVICE=false
```

Then access this plugin through `ACP_SERVICE` / `ACP_SUBPROCESS_SERVICE` and let the orchestrator own `PTY_SERVICE`.

## Status

`0.1.0` stable release prep. Current receipts:

- 38 unit tests passing under `bun test`
- TypeScript build passing with `bun run build`
- Biome check passing with `bunx @biomejs/biome check .`
- real production validation from three parallel Nyx/acpx/codex worker deployments on 2026-05-06

Deferred to later versions:

- `provision_workspace` / `finalize_workspace`, use git directly for now
- `manage_issues` / GitHub integration
- swarm-coordinator and sibling-to-sibling agent comms
- broader adapter-specific hardening as acpx expands coverage

## Contributing

Run these before opening a PR:

```bash
bun test
bun run build
bunx @biomejs/biome check .
```

## License

MIT. See [LICENSE](./LICENSE).
