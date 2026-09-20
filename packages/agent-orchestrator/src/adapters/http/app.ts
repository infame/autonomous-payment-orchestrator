import { Hono } from "hono";
import type { SubmitIntent } from "../../app/submit-intent.js";
import type { GetIntent } from "../../app/get-intent.js";
import type { AnswerClarification } from "../../app/answer-clarification.js";
import type { ApproveIntent } from "../../app/approve-intent.js";
import type { AutoApproveIntent } from "../../app/auto-approve-intent.js";
import type { RejectIntent } from "../../app/reject-intent.js";
import type { SyncIntentExecution } from "../../app/sync-intent-execution.js";
import { IntentNotFoundError } from "../../domain/errors.js";
import { IntentVersionConflictError } from "../../ports/intent-repository.js";
import {
  AnswerClarificationBody,
  IntentIdParam,
  SubmitIntentBody,
} from "./server-schemas.js";
import {
  optionalIdempotencyKey,
  readJsonBody,
  requireCustomerId,
} from "./request.js";
import { mapError } from "./server-error-mapper.js";

export interface AgentOrchestratorAppDeps {
  readonly submitIntent: Pick<SubmitIntent, "execute">;
  /**
   * Two jobs, both load-bearing: (1) the ownership pre-check on all four
   * id-addressed routes, and (2) the re-read fallback when
   * `SyncIntentExecution` loses a version race on `GET`. Never the primary
   * handler for `GET /intents/:id` — that is `syncIntentExecution`.
   */
  readonly getIntent: Pick<GetIntent, "execute">;
  readonly answerClarification: Pick<AnswerClarification, "execute">;
  readonly approveIntent: Pick<ApproveIntent, "execute">;
  /**
   * Called from exactly ONE place: `POST /intents`, immediately after a
   * keyed `submitIntent` call lands on `proposed` (see that handler's own
   * comment for why no ownership pre-check is needed there). Never exposed
   * on any other route.
   */
  readonly autoApproveIntent: Pick<AutoApproveIntent, "execute">;
  readonly rejectIntent: Pick<RejectIntent, "execute">;
  readonly syncIntentExecution: Pick<SyncIntentExecution, "execute">;
}

/**
 * Builds the driving HTTP adapter for `agent-orchestrator`: a Hono `app`
 * wired against the seven `app/*` use-cases (`autoApproveIntent`, slice 2,
 * is the newest — see `POST /intents`'s own handler comment for its single,
 * narrow call site). Route handlers stay small — read header/param,
 * validate, call the use-case, return the result — and never catch, except
 * `GET /intents/:id`'s single documented fallback below.
 * Every other error propagates to the single `app.onError` below, which
 * maps it through `mapError`. Mirrors `packages/durable-ledger/src/adapters/
 * http/app.ts`'s and `packages/pay-core/src/adapters/http/app.ts`'s shape
 * and conventions.
 *
 * ## The ownership check, and why it runs before every use-case call
 *
 * `X-Customer-Id` is the sole caller-identity channel (ADR-0014). On every
 * id-addressed route (`clarify`/`approve`/`reject`/`GET`), this file reads
 * the header, reads and validates `:id`, calls `deps.getIntent.execute(id)`,
 * and — if the stored `customerId` does not match the header — throws the
 * SAME `IntentNotFoundError` a genuine miss would throw, BEFORE calling the
 * route's real use-case. This ordering is the single most dangerous thing
 * to get wrong in this file, in the same register `approve-intent.ts`'s own
 * header uses for its most dangerous possible simplification: moving the
 * ownership check after the use-case call — or deleting it and trusting the
 * use-case's own (deliberately absent, see each `app/*` file's own "No
 * caller/customer scoping" section) internal check — would let a 422/409/
 * `ExecutionRaceLostError` response leak the existence and current state of
 * another customer's intent, AND would let an unauthorized caller trigger
 * `ApproveIntent`'s real payment or `SyncIntentExecution`'s external call +
 * write on someone else's row before ever being rejected. See
 * ADR-0014 for the full "why 404, not 403" argument.
 *
 * `requireCustomerId` is called explicitly at the top of EACH handler body
 * — never as `app.use("/intents/*", ...)` middleware. A `/intents/*`
 * matcher does not cover the bare `/intents` route itself in Hono's
 * routing, and explicit per-handler calls are simpler to audit here
 * anyway — matching both sibling packages' zero-middleware convention.
 */
export function createAgentOrchestratorApp(
  deps: AgentOrchestratorAppDeps,
): Hono {
  const app = new Hono();

  app.post("/intents", async (c) => {
    const customerId = requireCustomerId(c);
    // Read/validate the header before touching the request body, so a
    // malformed Idempotency-Key fails fast without consuming the stream —
    // same ordering durable-ledger's own POST /workflows/payment uses.
    const idempotencyKey = optionalIdempotencyKey(c);
    const body = SubmitIntentBody.parse(await readJsonBody(c));
    const submitted = await deps.submitIntent.execute({
      ...body,
      customerId,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    });
    if (
      idempotencyKey === undefined ||
      submitted.intent.status !== "proposed"
    ) {
      return c.json(
        { intent: submitted.intent, verdict: submitted.verdict },
        201,
      );
    }
    // Only reachable with a caller-supplied key AND a fresh "proposed"
    // status — per SubmitIntent's own header, "proposed" uniquely means
    // policy's last evaluation returned "allow" (its only two callers,
    // submit-intent.ts/answer-clarification.ts, both apply policy before
    // their one write, which moves the intent off "proposed" on any other
    // verdict). No SEPARATE ownership pre-check is done here, unlike the
    // four id-addressed routes below: intentId here was JUST derived from
    // THIS caller's own X-Customer-Id (deriveIntentId(customerId,
    // idempotencyKey), inside SubmitIntent) or freshly minted — a caller can
    // only ever address an id inside its own derivation namespace, and
    // reaching another customer's row would require an actual UUIDv5
    // collision. `autoApproveIntent.execute()` still takes `customerId` and
    // checks it itself, as defense in depth (see auto-approve-intent.ts's
    // own header, "Caller/customer scoping") — not because this call site
    // needs it. Do NOT expose autoApproveIntent on any other route.
    const auto = await deps.autoApproveIntent.execute({
      intentId: submitted.intent.id,
      customerId,
    });
    return c.json({ intent: auto.intent, verdict: auto.verdict }, 201);
  });

  app.post("/intents/:id/clarify", async (c) => {
    const customerId = requireCustomerId(c);
    const intentId = IntentIdParam.parse(c.req.param("id"));
    const existing = await deps.getIntent.execute(intentId);
    // MUST run before the body is read or answerClarification is called —
    // see this file's header.
    if (existing.customerId !== customerId) {
      throw new IntentNotFoundError(intentId);
    }
    const body = AnswerClarificationBody.parse(await readJsonBody(c));
    const result = await deps.answerClarification.execute({
      intentId,
      ...body,
    });
    return c.json({ intent: result.intent, verdict: result.verdict }, 200);
  });

  app.post("/intents/:id/approve", async (c) => {
    const customerId = requireCustomerId(c);
    const intentId = IntentIdParam.parse(c.req.param("id"));
    const existing = await deps.getIntent.execute(intentId);
    // MUST run before approveIntent is called — this is the check that
    // stops an unauthorized caller from triggering a REAL payment against
    // someone else's intent. See this file's header.
    if (existing.customerId !== customerId) {
      throw new IntentNotFoundError(intentId);
    }
    const result = await deps.approveIntent.execute({ intentId });
    return c.json({ intent: result }, 200);
  });

  app.post("/intents/:id/reject", async (c) => {
    const customerId = requireCustomerId(c);
    const intentId = IntentIdParam.parse(c.req.param("id"));
    const existing = await deps.getIntent.execute(intentId);
    // MUST run before rejectIntent is called — see this file's header.
    if (existing.customerId !== customerId) {
      throw new IntentNotFoundError(intentId);
    }
    const result = await deps.rejectIntent.execute({ intentId });
    return c.json({ intent: result }, 200);
  });

  app.get("/intents/:id", async (c) => {
    const customerId = requireCustomerId(c);
    const intentId = IntentIdParam.parse(c.req.param("id"));
    const existing = await deps.getIntent.execute(intentId);
    // MUST run before syncIntentExecution is called — it makes an external
    // call and can write on this intent's behalf. See this file's header.
    if (existing.customerId !== customerId) {
      throw new IntentNotFoundError(intentId);
    }

    let view;
    try {
      view = await deps.syncIntentExecution.execute({ intentId });
    } catch (err) {
      if (!(err instanceof IntentVersionConflictError)) {
        throw err;
      }
      // A read must not surface a write race. The winner's write already
      // recorded the true state — re-read it. `sync-intent-execution.ts`'s
      // own "No retry on a version conflict" section explicitly defers this
      // decision to this HTTP layer. `customerId` is immutable on `Intent`,
      // so the ownership check above still holds for this re-read view.
      view = await deps.getIntent.execute(intentId);
    }
    return c.json({ intent: view }, 200);
  });

  app.get("/healthz", (c) => c.json({ status: "ok" }, 200));

  app.onError((err, c) => {
    const { status, body } = mapError(err);
    return c.json(body, status);
  });

  app.notFound((c) =>
    c.json({ error: { code: "not_found", message: "Not found" } }, 404),
  );

  return app;
}
