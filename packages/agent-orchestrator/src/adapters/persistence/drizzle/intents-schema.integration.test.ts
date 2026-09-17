import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { intents, type NewIntentRow } from "./schema.js";
import { withTestDb } from "./test-support.js";

const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);

/**
 * Real-Postgres suite hitting the raw Drizzle client directly. A repository
 * now exists (`pg-intent-repository.ts`, covered by its own
 * `pg-intent-repository.integration.test.ts`), but this file deliberately
 * builds rows by hand — it covers raw CHECK constraints and the set-once
 * trigger that a repository built on valid domain objects can never
 * exercise (it never emits a row a CHECK would reject, and never changes
 * `durable_ledger_event_id` after it's set). Skipped (not silently — see
 * `test-support.ts`) unless `TEST_DATABASE_URL` is set; `pnpm test` never
 * picks this file up at all (`vitest.config.ts` excludes
 * `*.integration.test.ts`), so this guard only matters for a
 * direct/misconfigured invocation.
 */
describe.skipIf(!hasTestDb)("agent.intents schema (integration)", () => {
  if (!hasTestDb) return;

  const { db } = withTestDb();

  /** A syntactically-valid row, overridable per test — used to probe one column's CHECK in isolation. */
  function baseRow(overrides: Partial<NewIntentRow> = {}): NewIntentRow {
    return {
      id: randomUUID(),
      customerId: "cust_1",
      intentText: "Pay vendor-42 $50.00 for invoice #123.",
      status: "received",
      proposal: null,
      policyVerdict: null,
      durableLedgerEventId: null,
      clarificationAnswer: null,
      version: 1,
      ...overrides,
    };
  }

  function pgErrorOf(
    err: unknown,
  ): { code?: string; constraint?: string; message?: string } | undefined {
    if (typeof err !== "object" || err === null || !("cause" in err)) {
      return undefined;
    }
    const cause = (err as { cause?: unknown }).cause;
    if (typeof cause !== "object" || cause === null) {
      return undefined;
    }
    return cause;
  }

  async function expectConstraintViolation(
    promise: Promise<unknown>,
    constraint: string,
  ): Promise<void> {
    await expect(promise).rejects.toSatisfy(
      (err: unknown) => pgErrorOf(err)?.constraint === constraint,
    );
  }

  async function expectMessageIncludes(
    promise: Promise<unknown>,
    substring: string,
  ): Promise<void> {
    await expect(promise).rejects.toSatisfy((err: unknown) =>
      Boolean(pgErrorOf(err)?.message?.includes(substring)),
    );
  }

  describe("round-trip", () => {
    it("preserves all columns through insert + select", async () => {
      const row = baseRow({
        proposal: { kind: "clarify", question: "Which invoice?" },
        version: 3,
      });
      await db.insert(intents).values(row);

      const rows = await db
        .select()
        .from(intents)
        .where(eq(intents.id, row.id));
      expect(rows).toHaveLength(1);
      const found = rows[0];
      expect(found?.customerId).toBe(row.customerId);
      expect(found?.intentText).toBe(row.intentText);
      expect(found?.status).toBe(row.status);
      expect(found?.proposal).toEqual(row.proposal);
      expect(found?.policyVerdict).toBeNull();
      expect(found?.durableLedgerEventId).toBeNull();
      expect(found?.clarificationAnswer).toBeNull();
      expect(found?.version).toBe(3);
      expect(found?.createdAt).toBeInstanceOf(Date);
      expect(found?.updatedAt).toBeInstanceOf(Date);
    });

    it("preserves a non-null clarificationAnswer through insert + select", async () => {
      const row = baseRow({
        status: "proposed",
        proposal: {
          kind: "propose_payment",
          amount: 5_000,
          currency: "USD",
          merchantId: "vendor-42",
          reasoning: "x",
        },
        clarificationAnswer: "Invoice #123, $50.00",
      });
      await db.insert(intents).values(row);

      const rows = await db
        .select()
        .from(intents)
        .where(eq(intents.id, row.id));
      expect(rows[0]?.clarificationAnswer).toBe("Invoice #123, $50.00");
    });
  });

  describe("DB constraints reject what they should", () => {
    it("rejects an invalid status (intents_status_valid)", async () => {
      await expectConstraintViolation(
        db.insert(intents).values(baseRow({ status: "bogus" })),
        "intents_status_valid",
      );
    });

    it("rejects version <= 0 (intents_version_positive)", async () => {
      await expectConstraintViolation(
        db.insert(intents).values(baseRow({ version: 0 })),
        "intents_version_positive",
      );
      await expectConstraintViolation(
        db.insert(intents).values(baseRow({ version: -1 })),
        "intents_version_positive",
      );
    });

    it("rejects a malformed customer_id (intents_customer_id_format)", async () => {
      await expectConstraintViolation(
        db.insert(intents).values(baseRow({ customerId: "cust 1!" })),
        "intents_customer_id_format",
      );
      await expectConstraintViolation(
        db.insert(intents).values(baseRow({ customerId: "" })),
        "intents_customer_id_format",
      );
    });

    it("rejects whitespace-only intent_text (intents_text_bounded)", async () => {
      await expectConstraintViolation(
        db.insert(intents).values(baseRow({ intentText: "   " })),
        "intents_text_bounded",
      );
    });

    it("rejects intent_text over 10000 characters after trimming (intents_text_bounded)", async () => {
      await expectConstraintViolation(
        db.insert(intents).values(baseRow({ intentText: "x".repeat(10_001) })),
        "intents_text_bounded",
      );
    });

    it("rejects status='executing' with a null durable_ledger_event_id (intents_executing_requires_event_id)", async () => {
      await expectConstraintViolation(
        db.insert(intents).values(
          baseRow({
            status: "executing",
            proposal: {
              kind: "propose_payment",
              amount: 100,
              currency: "USD",
              merchantId: "vendor-42",
              reasoning: "x",
            },
            durableLedgerEventId: null,
          }),
        ),
        "intents_executing_requires_event_id",
      );
    });

    it("accepts status='executing' with a durable_ledger_event_id set (positive control)", async () => {
      const row = baseRow({
        status: "executing",
        proposal: {
          kind: "propose_payment",
          amount: 100,
          currency: "USD",
          merchantId: "vendor-42",
          reasoning: "x",
        },
        durableLedgerEventId: "evt_1",
      });
      await db.insert(intents).values(row);
      const rows = await db
        .select()
        .from(intents)
        .where(eq(intents.id, row.id));
      expect(rows).toHaveLength(1);
    });

    it("rejects a whitespace-only clarification_answer (intents_clarification_answer_bounded)", async () => {
      await expectConstraintViolation(
        db.insert(intents).values(
          baseRow({
            status: "proposed",
            proposal: {
              kind: "propose_payment",
              amount: 100,
              currency: "USD",
              merchantId: "vendor-42",
              reasoning: "x",
            },
            clarificationAnswer: "   ",
          }),
        ),
        "intents_clarification_answer_bounded",
      );
    });

    it("rejects a clarification_answer over 2000 characters after trimming (intents_clarification_answer_bounded)", async () => {
      await expectConstraintViolation(
        db.insert(intents).values(
          baseRow({
            status: "proposed",
            proposal: {
              kind: "propose_payment",
              amount: 100,
              currency: "USD",
              merchantId: "vendor-42",
              reasoning: "x",
            },
            clarificationAnswer: "x".repeat(2_001),
          }),
        ),
        "intents_clarification_answer_bounded",
      );
    });

    it("rejects a clarification_answer present while status is 'received' (intents_clarification_answer_requires_resolution)", async () => {
      await expectConstraintViolation(
        db.insert(intents).values(
          baseRow({
            status: "received",
            clarificationAnswer: "Invoice #123, $50.00",
          }),
        ),
        "intents_clarification_answer_requires_resolution",
      );
    });

    it("rejects a clarification_answer present while status is 'needs_clarification' (intents_clarification_answer_requires_resolution)", async () => {
      await expectConstraintViolation(
        db.insert(intents).values(
          baseRow({
            status: "needs_clarification",
            proposal: { kind: "clarify", question: "Which invoice?" },
            clarificationAnswer: "Invoice #123, $50.00",
          }),
        ),
        "intents_clarification_answer_requires_resolution",
      );
    });

    it("accepts a non-null clarification_answer with status='proposed' (positive control)", async () => {
      const row = baseRow({
        status: "proposed",
        proposal: {
          kind: "propose_payment",
          amount: 100,
          currency: "USD",
          merchantId: "vendor-42",
          reasoning: "x",
        },
        clarificationAnswer: "Invoice #123, $50.00",
      });
      await db.insert(intents).values(row);
      const rows = await db
        .select()
        .from(intents)
        .where(eq(intents.id, row.id));
      expect(rows).toHaveLength(1);
    });

    it("accepts a NULL clarification_answer for any status (positive control)", async () => {
      const row = baseRow({ status: "received", clarificationAnswer: null });
      await db.insert(intents).values(row);
      const rows = await db
        .select()
        .from(intents)
        .where(eq(intents.id, row.id));
      expect(rows).toHaveLength(1);
    });
  });

  describe("set-once trigger on durable_ledger_event_id", () => {
    it("rejects an UPDATE changing a non-null event id to a different value", async () => {
      const row = baseRow({
        status: "executing",
        proposal: {
          kind: "propose_payment",
          amount: 100,
          currency: "USD",
          merchantId: "vendor-42",
          reasoning: "x",
        },
        durableLedgerEventId: "evt_1",
      });
      await db.insert(intents).values(row);

      await expectMessageIncludes(
        db
          .update(intents)
          .set({ durableLedgerEventId: "evt_2" })
          .where(eq(intents.id, row.id)),
        "set-once",
      );
    });

    it("permits an UPDATE from null to a value", async () => {
      const row = baseRow({ status: "proposed" });
      await db.insert(intents).values(row);

      await db
        .update(intents)
        .set({ durableLedgerEventId: "evt_1", status: "executing" })
        .where(eq(intents.id, row.id));

      const rows = await db
        .select()
        .from(intents)
        .where(eq(intents.id, row.id));
      expect(rows[0]?.durableLedgerEventId).toBe("evt_1");
    });

    it("permits an UPDATE setting the same value again (value -> same value)", async () => {
      const row = baseRow({
        status: "executing",
        proposal: {
          kind: "propose_payment",
          amount: 100,
          currency: "USD",
          merchantId: "vendor-42",
          reasoning: "x",
        },
        durableLedgerEventId: "evt_1",
      });
      await db.insert(intents).values(row);

      await db
        .update(intents)
        .set({ durableLedgerEventId: "evt_1", version: 2 })
        .where(eq(intents.id, row.id));

      const rows = await db
        .select()
        .from(intents)
        .where(eq(intents.id, row.id));
      expect(rows[0]?.durableLedgerEventId).toBe("evt_1");
      expect(rows[0]?.version).toBe(2);
    });
  });

  describe("column types", () => {
    it("rejects a non-UUID id string", async () => {
      await expect(
        db.insert(intents).values(baseRow({ id: "not-a-uuid" })),
      ).rejects.toBeDefined();
    });
  });
});
