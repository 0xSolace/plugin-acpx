# @elizaos/plugin-acp

[![npm version](https://img.shields.io/npm/v/@elizaos/plugin-acp.svg)](https://www.npmjs.com/package/@elizaos/plugin-acp)
[![license](https://img.shields.io/npm/l/@elizaos/plugin-acp.svg)](./LICENSE)

`@elizaos/plugin-acp` is an ElizaOS plugin for orchestrating coding agents through ACPX, the Agent Client Protocol CLI. It is designed as a structured, ACP-native sibling to the PTY-based `@elizaos/plugin-agent-orchestrator`, exposing the same high-level action surface while using typed streaming events, named sessions, and cooperative cancellation under the hood.

## Status

Alpha. This package is currently bootstrapped for `0.1.0-rc.1`; services, actions, and providers are scaffolded but not implemented yet.

## Installation

```bash
npm install @elizaos/plugin-acp
```

ACPX must also be installed and available on your `PATH`, or configured with `ELIZA_ACP_CLI`:

```bash
npm install -g acpx
acpx --help
```

## Quick start

Load the plugin in your Eliza project:

```ts
import acpPlugin from "@elizaos/plugin-acp";

export default {
  plugins: [acpPlugin],
};
```

Then invoke the ACP-compatible orchestration actions from your Eliza runtime once the implementation lands.

## Actions reference

| Action | Purpose | Status |
| --- | --- | --- |
| `SPAWN_AGENT` | Start an ACP coding-agent session. | Planned |
| `SEND_TO_AGENT` | Send a prompt or follow-up input to a running session. | Planned |
| `LIST_AGENTS` | List active and persisted ACP sessions. | Planned |
| `STOP_AGENT` | Stop a running session using cooperative ACP cancellation. | Planned |
| `CREATE_TASK` | Spawn an agent, send the first prompt, and return when complete. | Planned |
| `CANCEL_TASK` | Cancel an async task cooperatively. | Planned |

## Configuration

Configuration is read from environment variables.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ELIZA_ACP_CLI` | `acpx` | ACPX executable to spawn. |
| `ELIZA_ACP_DEFAULT_AGENT` | `codex` | Default ACP-compatible agent when an action does not specify one. |
| `ELIZA_ACP_TIMEOUT` | `300000` | Default action/session timeout in milliseconds. |
| `ELIZA_ACP_WORKDIR` | runtime working directory | Base working directory for spawned coding agents. |
| `ELIZA_ACP_MAX_SESSIONS` | implementation-defined | Optional cap on concurrently tracked sessions. |
| `ELIZA_ACP_LOG_LEVEL` | `info` | Logging verbosity for ACP subprocess events. |

## Relationship to plugin-agent-orchestrator

This package is a sibling, not a replacement, for `@elizaos/plugin-agent-orchestrator`. The orchestrator plugin manages CLI agents through PTYs and terminal-output heuristics. `@elizaos/plugin-acp` targets the same action surface as a drop-in transport swap, but relies on ACPX and structured Agent Client Protocol events instead of terminal scraping.

## Contributing

Contributions are welcome while the package is in alpha. Please keep changes aligned with the parity goals in `PROJECT.md`, add tests for implemented actions and services, and avoid publishing staged release candidates without maintainer approval.

## License

MIT. See [LICENSE](./LICENSE).
