import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { Intent } from "../../../domain/intent.js";
import { PgIntentRepository } from "./pg-intent-repository.js";
import { withTestDb } from "./test-support.js";
const { db } = withTestDb();
describe("immutable execution profile metadata", () => {
  it("roundtrips atomically, survives repository restart, and rejects direct mutation", async () => {
    const repo = new PgIntentRepository(db);
    const intent = Intent.submit({
      id: randomUUID(),
      customerId: "owner",
      text: "Pay vendor $500",
    });
    const created = await repo.create(intent, {
      executionProfile: "demo_transient",
    });
    expect(created.executionProfile).toBe("demo_transient");
    const restarted = new PgIntentRepository(db);
    const stored = await restarted.findById(intent.id);
    expect(stored?.executionProfile).toBe("demo_transient");
    expect(
      (await restarted.update(stored!.intent, stored!.version))
        .executionProfile,
    ).toBe("demo_transient");
    await expect(
      db.execute(
        sql`UPDATE agent.intents SET execution_profile='demo_decline' WHERE id=${intent.id}`,
      ),
    ).rejects.toThrow();
    expect((await restarted.findById(intent.id))?.executionProfile).toBe(
      "demo_transient",
    );
  });
});
