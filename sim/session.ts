import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { HostEnv } from "../src/env/host-env";

/** Inject Pi's two allocation primitives only for synchronous in-memory SessionManager calls. */
function withSessionPrimitives<T>(env: HostEnv, action: () => T): T {
  const RealDate = globalThis.Date;
  const uuid = crypto.randomUUID;
  class SessionDate extends RealDate {
    constructor(...args: any[]) { super(args.length ? args[0] : env.clock.now()); }
    static now(): number { return env.clock.now(); }
  }
  globalThis.Date = SessionDate as DateConstructor;
  crypto.randomUUID = () => env.random.uuid() as ReturnType<typeof crypto.randomUUID>;
  syncBuiltinESMExports();
  try { return action(); }
  finally { globalThis.Date = RealDate; crypto.randomUUID = uuid; syncBuiltinESMExports(); }
}

/** Real Pi branch and compaction algorithms. A5 remains advisory until its Pi probe passes. */
export function createSimSession(env: HostEnv, cwd: string): SessionManager {
  const session = withSessionPrimitives(env, () => SessionManager.inMemory(cwd, { id: env.random.uuid() }));
  return new Proxy(session, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      return typeof value === "function"
        ? (...args: unknown[]) => withSessionPrimitives(env, () => {
          if (key === "newSession") args[0] = { id: env.random.uuid(), ...(args[0] as object | undefined) };
          if (key === "createBranchedSession") throw new Error("Cross-Session fork needs an injected Session id");
          return value.apply(target, args);
        })
        : value;
    },
  });
}
