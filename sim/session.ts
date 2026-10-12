import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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

/** Real Pi branch and compaction algorithms; A5's recorded probe bounds apply. */
export function createSimSession(env: HostEnv, cwd: string): SessionManager {
  const session = withSessionPrimitives(env, () => SessionManager.inMemory(cwd, { id: env.random.uuid() }));
  const sessionFile = () => path.join(cwd, ".pi", "sessions", `${session.getSessionId()}.jsonl`);
  const persist = () => {
    fs.mkdirSync(path.dirname(sessionFile()), { recursive: true });
    fs.writeFileSync(sessionFile(), [session.getHeader(), ...session.getEntries()].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  };
  persist();
  return new Proxy(session, {
    get(target, key) {
      if (key === "getSessionFile") return sessionFile;
      const value = Reflect.get(target, key, target);
      return typeof value === "function"
        ? (...args: unknown[]) => withSessionPrimitives(env, () => {
          if (key === "newSession") args[0] = { id: env.random.uuid(), ...(args[0] as object | undefined) };
          if (key === "createBranchedSession") throw new Error("Cross-Session fork needs an injected Session id");
          const result = value.apply(target, args);
          if (typeof key === "string" && (key.startsWith("append") || key === "newSession" || key === "branch")) persist();
          return result;
        })
        : value;
    },
  });
}
