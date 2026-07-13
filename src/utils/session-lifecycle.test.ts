import { afterEach, describe, expect, it, vi } from "vitest";
import piTeams from "../../extensions/index";
import * as paths from "./paths";

type Handler = (event: unknown, ctx: SessionContext) => Promise<void>;

type SessionContext = {
  isIdle: ReturnType<typeof vi.fn>;
  ui: {
    setStatus: ReturnType<typeof vi.fn>;
  };
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Pi session lifecycle", () => {
  it("never polls a replaced or shut-down lead session context", async () => {
    vi.useFakeTimers();
    vi.spyOn(paths, "ensureDirs").mockImplementation(() => undefined);
    vi.stubEnv("PI_TEAM_NAME", "lifecycle-test");

    const handlers = new Map<string, Handler>();
    piTeams({
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      registerTool() {},
      sendUserMessage() {},
    } as never);

    const first = {
      isIdle: vi.fn(() => false),
      ui: { setStatus: vi.fn() },
    };
    const replacement = {
      isIdle: vi.fn(() => false),
      ui: { setStatus: vi.fn() },
    };

    await handlers.get("session_start")?.({}, first);
    expect(vi.getTimerCount()).toBe(1);
    await handlers.get("session_start")?.({}, replacement);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(first.isIdle).not.toHaveBeenCalled();
    expect(replacement.isIdle).toHaveBeenCalledTimes(1);

    await handlers.get("session_shutdown")?.({}, replacement);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(replacement.isIdle).toHaveBeenCalledTimes(1);
  });
});
