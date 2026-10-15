import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { SimWorld } from "./world";

it("cancels queued filesystem work before its effect", async () => {
  const world = new SimWorld(71);
  try {
    const actor = world.createActor("w1");
    const file = path.join(world.workspace.home, "cancelled.txt");
    const pending = world.enter("w1", () => fsp.writeFile(file, "never")).then(() => "", error => String((error as NodeJS.ErrnoException).code));
    world.killPid(actor.process.pid);
    await world.scheduler.drain();
    expect(await pending).toBe("ECANCELED");
    expect(fs.existsSync(file)).toBe(false);
    world.assertClean();
  } finally { world.dispose(); }
});

it("refuses old-generation filesystem continuations after actor replacement", async () => {
  const world = new SimWorld(72);
  try {
    const old = world.createActor("w1");
    const dir = path.join(world.workspace.home, "first-effect");
    const file = path.join(world.workspace.home, "old-continuation.txt");
    const pending = world.enter("w1", async () => {
      try { await fsp.mkdir(dir); }
      catch { await fsp.writeFile(file, "must not be written by replacement"); }
    }).then(() => undefined, () => undefined);
    world.killPid(old.process.pid);
    world.envs.delete("w1");
    const replacement = world.createActor("w1");
    await world.scheduler.drain();
    await pending;
    expect(world.processes.exists(old.process.pid)).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    expect(replacement.process.pid).not.toBe(old.process.pid);
    expect(world.guard.violations).toEqual(expect.arrayContaining([expect.stringContaining("Stale actor generation")]));
  } finally { world.dispose(); }
});
