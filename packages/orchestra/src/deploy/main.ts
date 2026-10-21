import { spawn } from "node:child_process";
import { URL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { servicePlan } from "./config.js";
import { Supervisor } from "./supervisor.js";

try {
  const services = servicePlan(process.env);
  const supervisor = new Supervisor({
    startupTimeoutMs: 120_000,
    shutdownTimeoutMs: 15_000,
    spawn(service) {
      const cwd = fileURLToPath(
        new URL(`../../../${service.name}/`, import.meta.url),
      );
      const child = spawn(process.execPath, ["dist/main.js"], {
        cwd,
        env: service.env,
        stdio: "inherit",
      });
      console.log(`single-vm: starting ${service.name}`);
      const exited = new Promise<void>((resolve) => {
        child.once("error", () => {
          console.error(`single-vm: ${service.name} failed to spawn`);
          resolve();
        });
        child.once("exit", () => {
          console.log(`single-vm: ${service.name} exited`);
          resolve();
        });
      });
      return {
        exited,
        kill: (signal) => {
          if (child.exitCode === null && child.signalCode === null)
            child.kill(signal);
        },
      };
    },
    async ready(service, signal) {
      while (!signal.aborted) {
        const probe = new AbortController();
        const abortProbe = (): void => {
          probe.abort();
        };
        signal.addEventListener("abort", abortProbe, { once: true });
        const timer = setTimeout(abortProbe, 2000);
        try {
          const response = await fetch(
            `http://127.0.0.1:${String(service.port)}/healthz`,
            {
              signal: probe.signal,
              redirect: "error",
            },
          );
          await response.body?.cancel();
          if (response.ok) return;
        } catch {
          /* Startup includes migrations and may take multiple probes. */
        } finally {
          clearTimeout(timer);
          signal.removeEventListener("abort", abortProbe);
        }
        await delay(250, undefined, { signal });
      }
      throw new Error("Readiness interrupted");
    },
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void supervisor.stop(false, signal);
    });
  }
  await supervisor.start(services);
  process.exit(await supervisor.done);
} catch {
  console.error(
    "single-vm: invalid configuration; check required deployment variables",
  );
  process.exit(1);
}
