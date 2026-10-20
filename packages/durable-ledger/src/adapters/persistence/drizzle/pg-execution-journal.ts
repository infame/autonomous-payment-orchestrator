import pg from "pg";
import type {
  ExecutionAttempt,
  ExecutionJournal,
} from "../../../ports/execution-journal.js";

/** Dedicated tiny pool: observability cannot exhaust the business pool. */
export class PgExecutionJournal implements ExecutionJournal {
  private readonly pool;
  constructor(databaseUrl: string, pool?: InstanceType<typeof pg.Pool>) {
    this.pool =
      pool ??
      new pg.Pool({
        connectionString: databaseUrl,
        max: 2,
        connectionTimeoutMillis: 100,
        query_timeout: 100,
        statement_timeout: 100,
      });
    // Idle-client failures are EventEmitter errors, outside query promises.
    // Never forward their raw message/connection details or throw from telemetry.
    this.pool.on("error", () => {
      try {
        console.warn(
          "durable-ledger: execution journal connection unavailable",
        );
      } catch {
        /* Logging must not turn observation failure into payment failure. */
      }
    });
  }
  async start(a: ExecutionAttempt): Promise<void> {
    await this.pool.query(
      `INSERT INTO ledger.execution_attempts
      (id,run_id,event_id,step,phase,payment_id,operation_id,idempotency_key,started_at,outcome)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        a.id,
        a.runId,
        a.eventId,
        a.step,
        a.phase,
        a.paymentId,
        a.operationId,
        a.idempotencyKey,
        a.startedAt,
        a.outcome,
      ],
    );
  }
  async finish(
    id: string,
    r: Pick<
      ExecutionAttempt,
      "paymentId" | "outcome" | "errorCode" | "endedAt"
    >,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ledger.execution_attempts SET payment_id=$2,outcome=$3,error_code=$4,ended_at=$5 WHERE id=$1`,
      [id, r.paymentId, r.outcome, r.errorCode, r.endedAt],
    );
  }
  async findByRunId(runId: string): Promise<readonly ExecutionAttempt[]> {
    const result = await this.pool.query<
      Omit<ExecutionAttempt, "startedAt" | "endedAt"> & {
        startedAt: Date;
        endedAt: Date | null;
      }
    >(
      `SELECT id,run_id AS "runId",event_id AS "eventId",step,phase,payment_id AS "paymentId",operation_id AS "operationId",idempotency_key AS "idempotencyKey",started_at AS "startedAt",ended_at AS "endedAt",outcome,error_code AS "errorCode" FROM ledger.execution_attempts WHERE run_id=$1 ORDER BY started_at,id LIMIT 200`,
      [runId],
    );
    return result.rows.map((row) => ({
      ...row,
      startedAt: row.startedAt.toISOString(),
      endedAt: row.endedAt?.toISOString() ?? null,
    }));
  }
  close(): Promise<void> {
    return this.pool.end();
  }
}
