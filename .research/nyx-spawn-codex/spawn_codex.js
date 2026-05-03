/**
 * `spawn_codex` tool — wrap plugin-agent-orchestrator's CREATE_TASK action with
 * `agentType: "codex"` so the native reasoning loop can delegate focused
 * multi-step work to a codex subagent and return the final transcript.
 *
 * Design notes:
 *  - The orchestrator action is fundamentally async: it spawns a PTY session
 *    via `PTY_SERVICE` and reports lifecycle through `SessionEventCallback`s.
 *    There is no "await for done" surface on the action itself, so we wire one
 *    up here:
 *      1. Resolve the `CREATE_TASK` Action via `runtime.actions.find(...)`.
 *      2. Build a synthetic Memory message that carries the codex agentType,
 *         the user-supplied task text, and the chosen workdir.
 *      3. Pass an in-process buffering `HandlerCallback` so any text the
 *         orchestrator/coordinator emits (failures, login prompts, etc.) is
 *         captured rather than going to chat.
 *      4. Subscribe to `PTY_SERVICE.onSessionEvent` for the session ids the
 *         action returns in `ActionResult.data.agents`, gathering the latest
 *         `task_complete` `response` payload, plus any `error.message`.
 *      5. Resolve when *all* session ids reach a terminal state (`stopped` or
 *         `error`) or when a settle window after the last `task_complete`
 *         elapses, or the wall-clock timeout trips. Whichever fires first.
 *
 *  - We never throw out of the handler. Every error path returns
 *    `{ content: "subagent failed: <reason>", is_error: true }`.
 *
 *  - The codex CLI auth lives at `/root/.codex/auth.json` inside the nyx
 *    container; the orchestrator's `task-agent-auth.ts` already knows how to
 *    surface it, so we don't re-implement here. We do log when codex falls
 *    back to a different framework so wave-2 can decide whether to escalate.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
const DEFAULT_TIMEOUT_MS = 600_000; // 10 min
const SETTLE_WINDOW_MS = 1_500; // quiet time after final task_complete
const DEFAULT_WORKDIR_ROOT = "/workspace/tasks";
export const tool = {
    type: "custom",
    name: "spawn_codex",
    description: "Spawn a codex subagent to do focused multi-step work (long-running " +
        "coding, research, or refactor tasks) in a sandboxed workspace and " +
        "return the final transcript or summary. The subagent runs " +
        "autonomously inside its own PTY session; this tool blocks until it " +
        "finishes, errors, or the timeout trips. Use this when the task is " +
        "large enough that you'd rather not occupy the main loop step-by-" +
        "step (e.g. 'implement X feature with tests', 'investigate Y bug end-" +
        "to-end').",
    input_schema: {
        type: "object",
        properties: {
            task: {
                type: "string",
                description: "Natural-language description of what the subagent should do.",
            },
            workdir: {
                type: "string",
                description: "Working directory for the subagent. Defaults to a fresh " +
                    "timestamped dir under /workspace/tasks.",
            },
            timeout_ms: {
                type: "number",
                description: "Wall-clock timeout in milliseconds (default 600000 = 10 min).",
            },
            model: {
                type: "string",
                description: "Optional model override forwarded to codex (sets OPENAI_MODEL " +
                    "in the subagent's env via the orchestrator). Leave unset for " +
                    "the orchestrator's default.",
            },
        },
        required: ["task"],
        additionalProperties: false,
    },
};
export const handler = async (rawInput, runtime, message) => {
    const input = (rawInput ?? {});
    if (typeof input.task !== "string" || input.task.trim().length === 0) {
        return safeError("'task' is required and must be a non-empty string");
    }
    if (!runtime) {
        return safeError("runtime not available in tool context");
    }
    const action = findCreateTaskAction(runtime);
    if (!action) {
        return safeError("plugin-agent-orchestrator CREATE_TASK action not registered on this runtime");
    }
    const ptyService = runtime.getService("PTY_SERVICE");
    if (!ptyService || typeof ptyService.onSessionEvent !== "function") {
        return safeError("PTY_SERVICE is not available; cannot await subagent");
    }
    const workdir = input.workdir?.trim() || generateDefaultWorkdir();
    const timeoutMs = pickTimeout(input.timeout_ms);
    // Buffer for any text the orchestrator emits via its callback (errors,
    // permission prompts, fallback summaries). We never forward these to chat.
    const callbackTexts = [];
    const captureCallback = async (response) => {
        if (response && typeof response.text === "string" && response.text) {
            callbackTexts.push(response.text);
        }
        return [];
    };
    // Build a synthetic Memory carrying the codex routing hints. The
    // orchestrator action reads both `options.parameters` and
    // `message.content` for these fields, so we set them in `content` so the
    // shape is stable regardless of the action's parameter-extraction order.
    const syntheticMessage = buildSyntheticMessage(message, runtime, {
        task: input.task,
        workdir,
        model: input.model,
    });
    // Subscribe to PTY events BEFORE invoking the action so we don't miss
    // the first emit (the orchestrator emits "ready" within one tick of
    // spawnSession). We track session ids as the action returns them.
    const tracker = createSessionTracker(ptyService);
    let actionResult;
    let invokeError;
    try {
        actionResult = await action.handler(runtime, syntheticMessage, undefined, {
            parameters: {
                task: input.task,
                agentType: "codex",
                ...(input.model ? { model: input.model } : {}),
            },
        }, captureCallback);
    }
    catch (err) {
        invokeError = err;
    }
    if (invokeError) {
        tracker.dispose();
        return safeError(`CREATE_TASK threw: ${errMsg(invokeError)}${callbackTexts.length ? ` | ${callbackTexts.join(" | ")}` : ""}`);
    }
    if (!actionResult) {
        tracker.dispose();
        return safeError(`CREATE_TASK returned no result${callbackTexts.length ? `: ${callbackTexts.join(" | ")}` : ""}`);
    }
    if (actionResult.success === false) {
        tracker.dispose();
        const reason = actionResult.text ||
            actionResult.error ||
            callbackTexts.join(" | ") ||
            "unknown orchestrator failure";
        return safeError(`CREATE_TASK failed: ${reason}`);
    }
    const sessionIds = extractSessionIds(actionResult.data);
    if (sessionIds.length === 0) {
        tracker.dispose();
        return safeError(`CREATE_TASK succeeded but produced no session ids${callbackTexts.length ? `: ${callbackTexts.join(" | ")}` : ""}`);
    }
    tracker.track(sessionIds);
    // Note any framework downgrade so wave-2 can decide policy.
    const agentRecords = actionResult.data?.agents ?? [];
    const downgrade = agentRecords.find((a) => a.agentType && a.agentType !== "codex");
    const waitOutcome = await tracker.waitForTerminal(timeoutMs);
    tracker.dispose();
    const transcript = buildTranscript({
        callbackTexts,
        responses: waitOutcome.responses,
        errors: waitOutcome.errors,
        downgradedTo: downgrade?.agentType,
        timedOut: waitOutcome.timedOut,
        sessionIds,
        workdir,
    });
    if (waitOutcome.timedOut) {
        return {
            content: `subagent failed: timed out after ${timeoutMs}ms\n\n${transcript}`,
            is_error: true,
        };
    }
    if (waitOutcome.errors.length > 0 && waitOutcome.responses.length === 0) {
        return {
            content: `subagent failed: ${waitOutcome.errors.join(" | ")}\n\n${transcript}`,
            is_error: true,
        };
    }
    return { content: transcript, is_error: false };
};
// ─────────────────────────────────────────────────────────────────────────────
// helpers (exported only for test use)
// ─────────────────────────────────────────────────────────────────────────────
export function safeError(reason) {
    return { content: `subagent failed: ${reason}`, is_error: true };
}
export function generateDefaultWorkdir(now = new Date()) {
    const ts = `${now.getUTCFullYear()}` +
        String(now.getUTCMonth() + 1).padStart(2, "0") +
        String(now.getUTCDate()).padStart(2, "0") +
        "-" +
        String(now.getUTCHours()).padStart(2, "0") +
        String(now.getUTCMinutes()).padStart(2, "0") +
        String(now.getUTCSeconds()).padStart(2, "0");
    const short = randomUUID().slice(0, 8);
    return path.posix.join(DEFAULT_WORKDIR_ROOT, `${ts}-${short}`);
}
function pickTimeout(requested) {
    if (typeof requested === "number" &&
        Number.isFinite(requested) &&
        requested > 0) {
        // hard cap at 30 min so the loop never wedges indefinitely
        return Math.min(requested, 30 * 60 * 1000);
    }
    return DEFAULT_TIMEOUT_MS;
}
function findCreateTaskAction(runtime) {
    const actions = runtime.actions;
    if (!Array.isArray(actions))
        return undefined;
    const direct = actions.find((a) => a?.name === "CREATE_TASK");
    if (direct)
        return direct;
    return actions.find((a) => Array.isArray(a?.similes)
        ? a.similes.some((s) => s === "CREATE_TASK")
        : false);
}
function buildSyntheticMessage(parent, runtime, fields) {
    const parentContent = (parent?.content ?? {});
    const content = {
        ...parentContent,
        text: fields.task,
        task: fields.task,
        agentType: "codex",
        workdir: fields.workdir,
        source: "native-reasoning:spawn_codex",
    };
    if (fields.model)
        content.model = fields.model;
    // Cast through unknown — the eliza Memory type has many implementation-
    // specific required fields (createdAt, etc.) that are filled in by the
    // runtime's persistence layer. The orchestrator action only reads
    // `content`, `roomId`, `entityId`, and `agentId` from this surface, all
    // of which we populate here.
    const rt = runtime;
    const id = parent?.id ?? `spawn-codex-${randomUUID()}`;
    return {
        id,
        entityId: parent?.entityId ?? rt.agentId,
        agentId: parent?.agentId ?? rt.agentId,
        roomId: parent?.roomId ?? rt.agentId,
        worldId: parent?.worldId,
        content: content,
        createdAt: Date.now(),
    };
}
function extractSessionIds(data) {
    if (!data || typeof data !== "object")
        return [];
    const agents = data.agents;
    if (!Array.isArray(agents))
        return [];
    return agents
        .map((a) => (a && typeof a.sessionId === "string" ? a.sessionId : ""))
        .filter((s) => s.length > 0);
}
function errMsg(err) {
    return err instanceof Error ? err.message : String(err);
}
function createSessionTracker(pty) {
    const states = new Map();
    let tracked = [];
    const responses = [];
    const errors = [];
    let resolveTerminal = null;
    // All events flow through this; we bucket only the ones for tracked
    // sessions. We subscribe immediately so events emitted between
    // spawnSession and `track()` are not lost — we backfill on track.
    const buffered = [];
    let unsubscribed = false;
    const unsubscribe = pty.onSessionEvent((sid, event, data) => {
        if (unsubscribed)
            return;
        if (!tracked.includes(sid)) {
            buffered.push([sid, event, data]);
            return;
        }
        ingest(sid, event, data);
    });
    function ingest(sid, event, data) {
        const state = states.get(sid) ?? { terminal: false };
        const payload = (data ?? {});
        if (event === "task_complete") {
            const resp = typeof payload.response === "string" ? payload.response : "";
            if (resp)
                state.latestResponse = resp;
            state.taskCompleteAt = Date.now();
        }
        else if (event === "stopped") {
            if (typeof payload.response === "string" && payload.response) {
                state.latestResponse = payload.response;
            }
            state.terminal = true;
        }
        else if (event === "error") {
            const msg = typeof payload.message === "string" ? payload.message : "unknown";
            errors.push(`[${sid}] ${msg}`);
            state.terminal = true;
        }
        states.set(sid, state);
        maybeResolve();
    }
    function maybeResolve() {
        if (!resolveTerminal)
            return;
        const allTerminal = tracked.every((sid) => states.get(sid)?.terminal);
        if (allTerminal && tracked.length > 0) {
            resolveTerminal();
            return;
        }
        // Settle window: if every tracked session has emitted at least one
        // task_complete and SETTLE_WINDOW_MS has elapsed since the latest one,
        // treat that as terminal-equivalent (codex sessions that don't auto-
        // stop after answering).
        const now = Date.now();
        const allTaskComplete = tracked.every((sid) => states.get(sid)?.taskCompleteAt !== undefined);
        if (!allTaskComplete)
            return;
        const latest = Math.max(...tracked.map((sid) => states.get(sid)?.taskCompleteAt ?? 0));
        if (now - latest >= SETTLE_WINDOW_MS)
            resolveTerminal();
    }
    return {
        track(sessionIds) {
            tracked = [...sessionIds];
            for (const [sid, event, data] of buffered) {
                if (tracked.includes(sid))
                    ingest(sid, event, data);
            }
            buffered.length = 0;
        },
        dispose() {
            unsubscribed = true;
            try {
                unsubscribe();
            }
            catch {
                /* ignore */
            }
        },
        waitForTerminal(timeoutMs) {
            return new Promise((resolve) => {
                let settled = false;
                const finish = (timedOut) => {
                    if (settled)
                        return;
                    settled = true;
                    clearTimeout(hardTimer);
                    clearInterval(settleTicker);
                    for (const sid of tracked) {
                        const r = states.get(sid)?.latestResponse;
                        if (r)
                            responses.push(r);
                    }
                    resolve({ responses, errors, timedOut });
                };
                resolveTerminal = () => finish(false);
                const hardTimer = setTimeout(() => finish(true), timeoutMs);
                // Periodic ticker to apply the settle window even if no new
                // events come in.
                const settleTicker = setInterval(maybeResolve, SETTLE_WINDOW_MS / 3);
                maybeResolve();
            });
        },
    };
}
function buildTranscript(args) {
    const lines = [];
    lines.push(`# spawn_codex result`);
    lines.push(`workdir: ${args.workdir}`);
    lines.push(`sessions: ${args.sessionIds.join(", ")}`);
    if (args.downgradedTo) {
        lines.push(`note: orchestrator routed this task to '${args.downgradedTo}' instead of codex`);
    }
    if (args.timedOut)
        lines.push(`note: TIMED OUT before terminal event`);
    if (args.errors.length > 0) {
        lines.push("");
        lines.push("## errors");
        for (const e of args.errors)
            lines.push(`- ${e}`);
    }
    if (args.callbackTexts.length > 0) {
        lines.push("");
        lines.push("## orchestrator messages");
        for (const t of args.callbackTexts)
            lines.push(t);
    }
    if (args.responses.length > 0) {
        lines.push("");
        lines.push("## subagent output");
        for (const r of args.responses)
            lines.push(r);
    }
    else if (!args.timedOut && args.errors.length === 0) {
        lines.push("");
        lines.push("(no subagent output captured)");
    }
    return lines.join("\n");
}
