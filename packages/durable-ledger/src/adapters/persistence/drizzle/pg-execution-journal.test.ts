import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { PgExecutionJournal } from "./pg-execution-journal.js";
import { recordAttempt } from "../../../workflow/record-attempt.js";

describe("journal idle connection failures", () => {
  it("contains pool error events, logs only a fixed message, and lets business IO continue", async () => {
    const pool = new pg.Pool({
      connectionString: "postgres://test:test@127.0.0.1:1/test",
      connectionTimeoutMillis: 10,
    });
    const journal = new PgExecutionJournal("unused", pool);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const effect = vi.fn().mockResolvedValue("payment-completed");
    try {
      expect(() =>
        pool.emit("error", new Error("secret-connection-string-and-token")),
      ).not.toThrow();
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        "durable-ledger: execution journal connection unavailable",
      );
      expect(warning.mock.calls.flat().join(" ")).not.toContain("secret");
      await expect(
        recordAttempt(
          journal,
          {
            runId: "r",
            eventId: null,
            step: "capture",
            phase: "workflow",
            paymentId: "p",
            operationId: null,
            idempotencyKey: "k",
          },
          effect,
          () => "p",
        ),
      ).resolves.toBe("payment-completed");
      expect(effect).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
      await journal.close();
    }
  });
  it("does not throw even when the reporting sink itself throws", async () => {
    const pool = new pg.Pool();
    const journal = new PgExecutionJournal("unused", pool);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("sink down");
    });
    try {
      expect(() => pool.emit("error", new Error("idle failure"))).not.toThrow();
    } finally {
      warning.mockRestore();
      await journal.close();
    }
  });
});
