import type { Plugin } from "@elizaos/core";
// TODO(W6): import actions once implemented.
// TODO(W6): import availableAgents provider once implemented.
// TODO(W4/W5): import AcpxSubprocessService and SessionStore once implemented.

export const acpPlugin: Plugin = {
  name: "@elizaos/plugin-acp",
  description: "ACP-based coding agent orchestration",
  actions: [
    // TODO(W6): SPAWN_AGENT, SEND_TO_AGENT, LIST_AGENTS, STOP_AGENT, CREATE_TASK, CANCEL_TASK.
  ],
  providers: [
    // TODO(W6): availableAgents provider.
  ],
  services: [
    // TODO(W4/W5): AcpxSubprocessService and SessionStore.
  ],
};

export default acpPlugin;
