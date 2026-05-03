import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { AcpService } from "../services/acp-service.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

type MockProc = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: Writable;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

const spawnMock = vi.mocked(spawn);

function runtime() {
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getSetting: vi.fn(() => undefined),
    services: new Map<string, unknown[]>(),
  } as never;
}

function proc(): MockProc {
  const p = new EventEmitter() as MockProc;
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  p.killed = false;
  p.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (signal === "SIGKILL") p.killed = true;
    return true;
  });
  return p;
}

function nextProc(): MockProc {
  const p = proc();
  spawnMock.mockReturnValueOnce(p as never);
  return p;
}

function closeOk(p: MockProc) {
  p.emit("close", 0, null);
}

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AcpService", () => {
  it("spawns a session, emits ready, and stores the session", async () => {
    const p = nextProc();
    const service = new AcpService(runtime());
    const events: Array<[string, string, unknown]> = [];
    service.onSessionEvent((sid, event, data) => events.push([sid, event, data]));
    await service.start();

    const promise = service.spawnSession({ name: "s1", agentType: "codex", workdir: "/tmp/acp-test" });
    p.stdout.emit("data", Buffer.from('{"jsonrpc":"2.0","method":"session_started","params":{"sessionId":"s1"}}\n'));
    closeOk(p);
    const result = await promise;

    expect(result.name).toBe("s1");
    expect(result.status).toBe("ready");
    expect(service.listSessions()).toHaveLength(1);
    expect(events.some(([, event]) => event === "ready")).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith(
      "acpx",
      expect.arrayContaining(["--format", "json", "codex", "sessions", "new", "--name", "s1"]),
      expect.objectContaining({ cwd: "/tmp/acp-test" }),
    );
  });

  it("sendPrompt emits message, tool_running, task_complete, stopped and resolves PromptResult", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    const events: string[] = [];
    service.onSessionEvent((_sid, event) => events.push(event));
    await service.start();
    const spawned = service.spawnSession({ name: "s2", agentType: "codex", workdir: "/tmp/acp-test" });
    closeOk(create);
    const { sessionId } = await spawned;

    const prompt = nextProc();
    const sent = service.sendPrompt(sessionId, "do the thing");
    prompt.stdout.emit("data", Buffer.from('{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"'));
    prompt.stdout.emit("data", Buffer.from(`${sessionId}","sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done"}}}\n`));
    prompt.stdout.emit("data", Buffer.from(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sessionId}","sessionUpdate":"tool_call","toolCall":{"id":"t1","status":"running"}}}\n`));
    prompt.stdout.emit("data", Buffer.from(`{"jsonrpc":"2.0","id":"req-1","result":{"stopReason":"end_turn"},"sessionId":"${sessionId}"}\n`));
    closeOk(prompt);

    const result = await sent;
    expect(result.response).toBe("done");
    expect(result.stopReason).toBe("end_turn");
    expect(events).toEqual(expect.arrayContaining(["message", "tool_running", "task_complete", "stopped"]));
    expect(events.indexOf("message")).toBeLessThan(events.indexOf("task_complete"));
  });

  it("cancelSession sends SIGTERM then SIGKILL after grace", async () => {
    vi.useFakeTimers();
    const create = nextProc();
    const service = new AcpService(runtime());
    await service.start();
    const spawned = service.spawnSession({ name: "s3", agentType: "codex", workdir: "/tmp/acp-test" });
    closeOk(create);
    const { sessionId } = await spawned;

    const prompt = nextProc();
    void service.sendPrompt(sessionId, "long running");
    await service.cancelSession(sessionId);

    expect(prompt.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(prompt.kill).toHaveBeenCalledWith("SIGKILL");
    prompt.emit("close", 130, "SIGTERM");
  });

  it("ignores malformed NDJSON without crashing", async () => {
    const create = nextProc();
    const rt = runtime() as { logger: { warn: ReturnType<typeof vi.fn> } };
    const service = new AcpService(rt as never);
    await service.start();
    const promise = service.spawnSession({ name: "bad-json", agentType: "codex", workdir: "/tmp/acp-test" });
    create.stdout.emit("data", Buffer.from("not-json\n"));
    closeOk(create);
    await expect(promise).resolves.toMatchObject({ name: "bad-json" });
    expect(rt.logger.warn).toHaveBeenCalled();
  });

  it("handles partial lines across chunk boundaries", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    const events: string[] = [];
    service.onSessionEvent((_sid, event) => events.push(event));
    await service.start();
    const spawned = service.spawnSession({ name: "partial", agentType: "codex", workdir: "/tmp/acp-test" });
    closeOk(create);
    const { sessionId } = await spawned;
    const prompt = nextProc();
    const sent = service.sendPrompt(sessionId, "hi");
    prompt.stdout.emit("data", Buffer.from(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sessionId}","sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hel`));
    prompt.stdout.emit("data", Buffer.from(`lo"}}}\n{"jsonrpc":"2.0","id":"req","result":{"stopReason":"end_turn"},"sessionId":"${sessionId}"}\n`));
    closeOk(prompt);
    const result = await sent;
    expect(result.response).toBe("hello");
    expect(events).toContain("task_complete");
  });

  it("maps exit code 1 with auth stderr to auth error event", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    const errors: unknown[] = [];
    service.onSessionEvent((_sid, event, data) => {
      if (event === "error") errors.push(data);
    });
    await service.start();
    const spawned = service.spawnSession({ name: "auth", agentType: "codex", workdir: "/tmp/acp-test" });
    closeOk(create);
    const { sessionId } = await spawned;

    const prompt = nextProc();
    const sent = service.sendPrompt(sessionId, "hi");
    prompt.stderr.emit("data", Buffer.from("401 unauthorized authenticate failed"));
    prompt.emit("close", 1, null);
    await sent;
    expect(errors).toEqual(expect.arrayContaining([expect.objectContaining({ failureKind: "auth" })]));
  });

  it("reattach after dead pid respawns", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    await service.start();
    const spawned = service.spawnSession({ name: "reattach", agentType: "codex", workdir: "/tmp/acp-test" });
    closeOk(create);
    const { sessionId } = await spawned;
    const session = service.getSession(sessionId);
    expect(session).toBeTruthy();
    await (service as unknown as { store: { update: (id: string, patch: unknown) => Promise<void> } }).store.update(sessionId, { pid: 999999 });

    const respawnProc = nextProc();
    const reattached = service.reattachSession(sessionId);
    closeOk(respawnProc);
    const result = await reattached;
    expect(result.sessionId).not.toBe(sessionId);
    expect(result.name).toBe("reattach");
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
