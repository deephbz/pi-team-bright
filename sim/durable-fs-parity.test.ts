import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { nodeHostEnv } from "../src/env/host-env";
import { SimWorld } from "./world";

async function runSim<T>(world: SimWorld, actor: string, action: () => Promise<T>): Promise<T> {
  const pending = world.enter(actor, action);
  await world.scheduler.drain();
  return pending;
}

it("keeps exclusive-create behavior equal across Node and simulator", async () => {
  const world = new SimWorld(101);
  try {
    const env = world.createActor("w1");
    const nodePath = path.join(world.workspace.home, "node-exclusive.txt");
    const simPath = path.join(world.workspace.home, "sim-exclusive.txt");
    fs.writeFileSync(nodePath, "original");
    fs.writeFileSync(simPath, "original");

    const nodeError = await nodeHostEnv.durableFs.writeFile(nodePath, "replacement", { flag: "wx", mode: 0o600 })
      .then(() => "", error => (error as NodeJS.ErrnoException).code);
    const simError = await runSim(world, "w1", () => env.durableFs.writeFile(simPath, "replacement", { flag: "wx", mode: 0o600 })
      .then(() => "", error => (error as NodeJS.ErrnoException).code));

    expect(nodeError).toBe("EEXIST");
    expect(simError).toBe(nodeError);
    expect(fs.readFileSync(nodePath, "utf8")).toBe("original");
    expect(fs.readFileSync(simPath, "utf8")).toBe("original");
    world.assertClean();
  } finally { world.dispose(); }
});

it("keeps open creation modes equal across Node and simulator", async () => {
  const world = new SimWorld(102);
  try {
    const env = world.createActor("w1");
    const nodePath = path.join(world.workspace.home, "node-mode.txt");
    const simPath = path.join(world.workspace.home, "sim-mode.txt");
    const nodeHandle = await nodeHostEnv.durableFs.open(nodePath, "wx", 0o400);
    await nodeHandle.close();
    await runSim(world, "w1", async () => {
      const handle = await env.durableFs.open(simPath, "wx", 0o400);
      await handle.close();
    });

    expect(fs.statSync(simPath).mode & 0o777).toBe(fs.statSync(nodePath).mode & 0o777);
    world.assertClean();
  } finally { world.dispose(); }
});

it("preserves offsets and short-I/O progress across Node and simulator", async () => {
  const world = new SimWorld(103);
  try {
    const env = world.createActor("w1");
    const nodePath = path.join(world.workspace.home, "node-io.txt");
    const simPath = path.join(world.workspace.home, "sim-io.txt");
    const exercise = async (durableFs: typeof nodeHostEnv.durableFs, file: string) => {
      const handle = await durableFs.open(file, "wx+", 0o600);
      const source = Buffer.from("abcdef");
      let offset = 0;
      while (offset < source.length) {
        const result = await handle.write(source, offset, 2, offset);
        expect(result.bytesWritten).toBeGreaterThan(0);
        offset += result.bytesWritten;
      }
      await handle.sync();
      const target = Buffer.alloc(source.length);
      offset = 0;
      while (offset < target.length) {
        const result = await handle.read(target, offset, 2, offset);
        expect(result.bytesRead).toBeGreaterThan(0);
        offset += result.bytesRead;
      }
      await handle.close();
      return target.toString();
    };

    const nodeValue = await exercise(nodeHostEnv.durableFs, nodePath);
    const simValue = await runSim(world, "w1", () => exercise(env.durableFs, simPath));
    expect(simValue).toBe(nodeValue);
    expect(fs.readFileSync(simPath, "utf8")).toBe(nodeValue);
    world.assertClean();
  } finally { world.dispose(); }
});

it("keeps file sync and rename callback order equal across Node and simulator", async () => {
  const world = new SimWorld(104);
  try {
    const env = world.createActor("w1");
    const exercise = async (durableFs: typeof nodeHostEnv.durableFs, root: string, name: string) => {
      const temp = path.join(root, `${name}.tmp`);
      const target = path.join(root, `${name}.json`);
      const order: string[] = [];
      const handle = await durableFs.open(temp, "wx", 0o600);
      await handle.writeFile("committed");
      order.push("write");
      await handle.sync();
      order.push("sync");
      await handle.close();
      order.push("close");
      await durableFs.rename(temp, target, () => order.push("before-rename"));
      order.push("rename");
      return { order, target, temp };
    };

    const node = await exercise(nodeHostEnv.durableFs, world.workspace.home, "node-order");
    const sim = await runSim(world, "w1", () => exercise(env.durableFs, world.workspace.home, "sim-order"));
    const expected = ["write", "sync", "close", "before-rename", "rename"];
    expect(node.order).toEqual(expected);
    expect(sim.order).toEqual(expected);
    expect(fs.readFileSync(sim.target, "utf8")).toBe("committed");
    expect(fs.existsSync(sim.temp)).toBe(false);
    world.assertClean();
  } finally { world.dispose(); }
});

it("cancels queued simulator I/O before its effect while Node I/O completes normally", async () => {
  const world = new SimWorld(105);
  try {
    const actor = world.createActor("w1");
    const nodePath = path.join(world.workspace.home, "node-cancel.txt");
    const simPath = path.join(world.workspace.home, "sim-cancel.txt");
    await nodeHostEnv.durableFs.writeFile(nodePath, "node completed", { flag: "wx", mode: 0o600 });

    const pending = world.enter("w1", () => actor.durableFs.writeFile(simPath, "must cancel", { flag: "wx", mode: 0o600 }));
    world.killPid(actor.process.pid);
    await world.scheduler.drain();

    await expect(pending).rejects.toMatchObject({ code: "ECANCELED" });
    expect(fs.readFileSync(nodePath, "utf8")).toBe("node completed");
    expect(fs.existsSync(simPath)).toBe(false);
    world.assertClean();
  } finally { world.dispose(); }
});
