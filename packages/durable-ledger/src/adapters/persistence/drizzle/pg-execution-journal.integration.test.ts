import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PgExecutionJournal } from "./pg-execution-journal.js";
import { testDatabaseUrl } from "./test-db-url.js";

const journal = new PgExecutionJournal(testDatabaseUrl());
afterAll(() => journal.close());
describe("migrated execution journal", () => {
  it("persists unfinished and finalized records and isolates run queries", async () => {
    const runId = randomUUID();
    const id = randomUUID();
    await journal.start({
      id,
      runId,
      eventId: "event",
      step: "capture",
      phase: "workflow",
      paymentId: "payment",
      operationId: null,
      idempotencyKey: "capture-key",
      startedAt: new Date().toISOString(),
      endedAt: null,
      outcome: "started",
      errorCode: null,
    });
    expect((await journal.findByRunId(runId))[0]?.outcome).toBe("started");
    await journal.finish(id, {
      paymentId: "payment",
      outcome: "succeeded",
      errorCode: null,
      endedAt: new Date().toISOString(),
    });
    expect((await journal.findByRunId(runId))[0]).toMatchObject({
      id,
      outcome: "succeeded",
      idempotencyKey: "capture-key",
    });
    expect(await journal.findByRunId(randomUUID())).toEqual([]);
  });
});
