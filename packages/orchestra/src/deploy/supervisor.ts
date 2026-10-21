import type { Service } from "./config.js";

export interface Child {
  readonly exited: Promise<void>;
  kill(signal: NodeJS.Signals): void;
}
export interface SupervisorDeps {
  spawn(service: Service): Child;
  ready(service: Service, signal: AbortSignal): Promise<void>;
  readonly startupTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
}

/** One failure terminates the complete unit. The gateway is started last. */
export class Supervisor {
  private readonly children: Child[] = [];
  private readonly abort = new AbortController();
  private stopping: Promise<void> | undefined;
  private failed = false;
  private finish!: (code: number) => void;
  readonly done = new Promise<number>((resolve) => {
    this.finish = resolve;
  });

  constructor(private readonly deps: SupervisorDeps) {}

  async start(services: readonly Service[]): Promise<void> {
    try {
      for (const service of services) {
        if (this.stopping || this.abort.signal.aborted) return;
        const child = this.deps.spawn(service);
        this.children.push(child);
        void child.exited.then(() => {
          if (!this.stopping) void this.stop(true);
        });
        const readiness = new AbortController();
        const abortReady = (): void => {
          readiness.abort();
        };
        this.abort.signal.addEventListener("abort", abortReady, { once: true });
        const timer = setTimeout(abortReady, this.deps.startupTimeoutMs);
        const signal = readiness.signal;
        try {
          await Promise.race([
            this.deps.ready(service, signal),
            new Promise<never>((_, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  reject(new Error("Startup interrupted"));
                },
                { once: true },
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
          this.abort.signal.removeEventListener("abort", abortReady);
        }
      }
    } catch {
      if (!this.stopping) await this.stop(true);
    }
  }

  stop(failed = false, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    if (this.stopping) return this.stopping;
    this.failed = failed;
    // Set stopping before kill/abort can synchronously emit child events.
    this.stopping = Promise.resolve().then(async () => {
      this.abort.abort();
      for (const child of [...this.children].reverse()) child.kill(signal);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(this.children.map((child) => child.exited)),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.failed = true;
            for (const child of this.children) child.kill("SIGKILL");
            resolve();
          }, this.deps.shutdownTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
      this.finish(this.failed ? 1 : 0);
    });
    return this.stopping;
  }
}
