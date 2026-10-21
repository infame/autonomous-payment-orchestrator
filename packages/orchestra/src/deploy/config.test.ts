import { describe, expect, it } from "vitest";
import { servicePlan } from "./config.js";

const env = {
  DATABASE_URL: "postgres://test",
  DURABLE_LEDGER_SERVICE_SECRET: "s".repeat(32),
  PUBLIC_BASE_URL: "https://demo.example.com",
  INNGEST_EVENT_KEY: "event-secret",
  INNGEST_SIGNING_KEY: "signing-secret",
};
describe("single VM configuration", () => {
  it("isolates child environments and forces simulator/mock and cloud mode", () => {
    const plan = servicePlan({
      ...env,
      ANTHROPIC_API_KEY: "live",
      ADMIN_SECRET: "admin",
      LLM_MODE: "live",
      INNGEST_DEV: "true",
      INNGEST_BASE_URL: "http://evil",
      HOST: "0.0.0.0",
    });
    expect(plan.map((s) => s.name)).toEqual([
      "pay-core",
      "durable-ledger",
      "agent-orchestrator",
      "orchestra",
    ]);
    expect(plan.map((s) => s.env.HOST)).toEqual([
      "127.0.0.1",
      "127.0.0.1",
      "127.0.0.1",
      "0.0.0.0",
    ]);
    expect(plan[0]?.env.PAYMENT_PROVIDER).toBe("simulator");
    expect(plan[1]?.env).toMatchObject({
      INNGEST_DEV: "false",
      INNGEST_SERVE_ORIGIN: env.PUBLIC_BASE_URL,
      DEMO_RESEND_ENABLED: "true",
    });
    expect(plan[1]?.env.INNGEST_BASE_URL).toBeUndefined();
    expect(plan[2]?.env).toMatchObject({
      LLM_MODE: "mock",
      DEMO_CHALLENGES_ENABLED: "true",
      DEMO_RESEND_ENABLED: "true",
    });
    for (const child of plan) {
      expect(child.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(child.env.ADMIN_SECRET).toBeUndefined();
    }
    expect(plan[3]?.env.DURABLE_LEDGER_SERVICE_SECRET).toBeUndefined();
  });
  it.each([
    "http://demo.example.com",
    "https://demo.example.com/",
    "https://demo.example.com/sub",
    "https://u:p@demo.example.com",
    "https://demo.example.com?x=1",
  ])("rejects noncanonical cloud origin %s", (origin) => {
    expect(() => servicePlan({ ...env, PUBLIC_BASE_URL: origin })).toThrow();
  });
  it("requires secrets without printing their values", () => {
    expect(() =>
      servicePlan({ ...env, INNGEST_SIGNING_KEY: undefined }),
    ).toThrow("INNGEST_SIGNING_KEY");
    expect(() =>
      servicePlan({ ...env, DURABLE_LEDGER_SERVICE_SECRET: "secret" }),
    ).not.toThrow("secret");
  });
  it("requires explicit local mode and forbids it on Fly", () => {
    const local = {
      ...env,
      SINGLE_VM_LOCAL_TEST: "true",
      PUBLIC_BASE_URL: "http://demo:3300",
      LOCAL_INNGEST_URL: "http://inngest:8288",
    };
    expect(servicePlan(local)[1]?.env.INNGEST_DEV).toBe("true");
    expect(() => servicePlan({ ...local, FLY_APP_NAME: "demo" })).toThrow(
      "forbidden",
    );
    expect(() =>
      servicePlan({ ...local, SINGLE_VM_LOCAL_TEST: undefined }),
    ).toThrow();
  });
});
