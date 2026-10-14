"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RecipientDeliveryLifecycle = void 0;
const host_env_1 = require("../env/host-env");
/** One exact recipient fence; each delivery engine owns an independent failure and retry. */
class RecipientDeliveryLifecycle {
    dependencies;
    active;
    constructor(dependencies) {
        this.dependencies = dependencies;
    }
    get binding() { return this.active?.binding; }
    async activate(binding) {
        this.deactivate();
        const pair = this.dependencies.makePair(binding, (name, error) => { void this.fail(activation, name, "scan", error); });
        const activation = { binding, publication: Promise.resolve(), slots: {
                alert: { engine: pair.direct, running: false, generation: 0, failures: 0 },
                task: { engine: pair.task, running: false, generation: 0, failures: 0 },
            } };
        this.active = activation;
        // Preserve initial lease ordering. Each start catches its own failure and
        // schedules its own retry before activation proceeds to the next engine.
        await this.start(activation, "alert");
        await this.start(activation, "task");
    }
    deactivate() {
        const active = this.active;
        this.active = undefined;
        if (!active)
            return;
        for (const slot of Object.values(active.slots)) {
            (0, host_env_1.hostEnv)().clock.clearTimeout(slot.retry);
            slot.retry = undefined;
            this.stop(slot);
        }
    }
    async observeContext(messages) {
        await this.forward("context", engine => engine.observeContext(messages));
    }
    async commitPresentedAfterSuccessfulTurn(reason) {
        await this.forward("acknowledgement", engine => engine.commitPresentedAfterSuccessfulTurn(reason));
    }
    async current(active) {
        if (this.active !== active)
            return false;
        const check = active.checking ??= this.dependencies.isCurrentBinding(active.binding);
        let current;
        try {
            current = await check;
        }
        finally {
            if (active.checking === check)
                active.checking = undefined;
        }
        if (this.active !== active)
            return false;
        if (!current)
            this.deactivate();
        return current;
    }
    async start(active, name, retry = false) {
        const slot = active.slots[name];
        const generation = slot.generation;
        try {
            if (this.active !== active || (retry && !await this.current(active)))
                return;
            // Admission validates initial activation. Engines retain their own exact
            // effect fences; only a delayed retry needs another shared binding read.
            await slot.engine.start();
            if (this.active !== active || slot.generation !== generation)
                return;
            slot.running = true;
            slot.failures = 0;
            await this.publish(active, name, { state: "running", observedAt: (0, host_env_1.hostEnv)().clock.now() });
        }
        catch (error) {
            if (slot.generation === generation)
                await this.fail(active, name, "start", error);
        }
    }
    async forward(operation, call) {
        const active = this.active;
        if (!active)
            return;
        await Promise.all(["alert", "task"].map(async (name) => {
            const slot = active.slots[name];
            if (!slot.running)
                return;
            const generation = slot.generation;
            try {
                if (this.active === active)
                    await call(slot.engine);
            }
            catch (error) {
                if (slot.generation === generation)
                    await this.fail(active, name, operation, error);
            }
        }));
    }
    async fail(active, name, operation, error) {
        if (this.active !== active)
            return;
        const slot = active.slots[name];
        if (slot.retry)
            return;
        this.stop(slot);
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(slot.failures++, 5));
        const observedAt = (0, host_env_1.hostEnv)().clock.now();
        slot.retry = (0, host_env_1.hostEnv)().clock.setTimeout(() => {
            slot.retry = undefined;
            void this.start(active, name, true);
        }, delay);
        if ("unref" in slot.retry)
            slot.retry.unref();
        await this.publish(active, name, { state: "degraded", engine: name, operation,
            message: error instanceof Error ? error.message : String(error), observedAt, retryAt: observedAt + delay });
    }
    stop(slot) {
        slot.generation += 1;
        slot.running = false;
        try {
            slot.engine.stop();
        }
        catch (error) {
            console.error("[pi-teams] delivery cleanup failed:", error);
        }
    }
    async publish(active, name, state) {
        active.publication = active.publication.then(async () => {
            if (this.active === active)
                await this.dependencies.publishState?.(active.binding, name, state);
        }).catch(error => { console.error("[pi-teams] delivery state publication failed:", error); });
        await active.publication;
    }
}
exports.RecipientDeliveryLifecycle = RecipientDeliveryLifecycle;
