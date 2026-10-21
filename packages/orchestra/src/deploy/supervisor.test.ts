import { describe, expect, it, vi } from "vitest";
import { Supervisor, type Child } from "./supervisor.js";
import type { Service } from "./config.js";

const services: Service[] = ["pay", "ledger", "agent", "gateway"].map(
  (name, i) => ({ name, port: 3000 + i, env: {} }),
);
function child() {
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => {
    exit = resolve;
  });
  const kill = vi.fn(() => {
    exit();
  });
  return { exited, kill, exit };
}
describe("supervisor", () => {
  it("starts in readiness order and shuts down siblings on an unexpected clean exit", async () => {
    const events: string[] = [];
    const children = services.map(() => child());
    const supervisor = new Supervisor({
      startupTimeoutMs: 100,
      shutdownTimeoutMs: 100,
      spawn: (service) => {
        events.push(`spawn:${service.name}`);
        return children[services.indexOf(service)] as Child;
      },
      ready: (service) => {
        events.push(`ready:${service.name}`);
        return Promise.resolve();
      },
    });
    await supervisor.start(services);
    expect(events).toEqual(
      services.flatMap((s) => [`spawn:${s.name}`, `ready:${s.name}`]),
    );
    children[0]?.exit();
    expect(await supervisor.done).toBe(1);
    for (const c of children) expect(c.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("does not expose gateway after spawn failure", async () => {
    const first = child();
    const spawn = vi.fn((service: Service) => {
      if (service.name === "ledger") throw new Error("spawn");
      return first;
    });
    const supervisor = new Supervisor({
      spawn,
      ready: () => Promise.resolve(),
      startupTimeoutMs: 10,
      shutdownTimeoutMs: 10,
    });
    await supervisor.start(services);
    expect(await supervisor.done).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(first.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("fails readiness within deadline and kills an uncooperative child", async () => {
    const first = child();
    first.kill.mockImplementation(() => {});
    const supervisor = new Supervisor({
      spawn: () => first,
      ready: () => new Promise(() => {}),
      startupTimeoutMs: 10,
      shutdownTimeoutMs: 10,
    });
    await supervisor.start(services);
    expect(await supervisor.done).toBe(1);
    expect(first.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
  });
  it("handles repeated shutdown during readiness once, without starting another child", async () => {
    const first = child();
    const spawn = vi.fn(() => first);
    const supervisor = new Supervisor({
      spawn,
      ready: () => new Promise(() => {}),
      startupTimeoutMs: 100,
      shutdownTimeoutMs: 10,
    });
    const started = supervisor.start(services);
    const stop = supervisor.stop();
    expect(supervisor.stop()).toBe(stop);
    await started;
    expect(await supervisor.done).toBe(0);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(first.kill).toHaveBeenCalledTimes(1);
  });
  it("forwards SIGINT exactly once", async () => {
    const first = child();
    const supervisor = new Supervisor({
      spawn: () => first,
      ready: () => Promise.resolve(),
      startupTimeoutMs: 100,
      shutdownTimeoutMs: 10,
    });
    await supervisor.start(services.slice(0, 1));
    await supervisor.stop(false, "SIGINT");
    await supervisor.stop(false, "SIGTERM");
    expect(await supervisor.done).toBe(0);
    expect(first.kill.mock.calls).toEqual([["SIGINT"]]);
  });
});
