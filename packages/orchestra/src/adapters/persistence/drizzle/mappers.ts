import { Grant } from "../../../domain/grant.js";
import type { LiveGrantRow } from "./schema.js";

/** Maps a `live_grants` row read back from Postgres to the domain `Grant`, re-validating every invariant through `Grant.create` — never trust a row shape alone, the same discipline `agent-orchestrator`'s own `mappers.ts` documents for `parseProposal`/`parsePolicyVerdict`. */
export function rowToGrant(row: LiveGrantRow): Grant {
  return Grant.create({
    jti: row.jti,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    maxCalls: row.maxCalls,
    usedCalls: row.usedCalls,
    boundSessionId: row.boundSessionId,
  });
}
