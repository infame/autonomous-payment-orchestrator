import { createHash } from "node:crypto";

/**
 * Fixed, hard-coded namespace for this package's derived intent ids. Never
 * change it: changing it re-maps every future key and silently breaks
 * in-flight retries.
 */
export const INTENT_ID_NAMESPACE = "41800694-b0e1-45ce-928e-676a7a3e2c17";

/** Parses a canonical hyphenated UUID string into its 16 raw bytes. */
function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Formats 16 raw bytes as a canonical hyphenated, lowercase UUID string. */
function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/**
 * RFC 4122 UUIDv5: `SHA1(namespaceBytes + nameBytes)`, truncated to 16 bytes,
 * with the version nibble forced to `5` and the variant bits forced to `10`.
 * Hand-rolled over `node:crypto`'s SHA-1 rather than pulling in a UUID
 * library — exported (rather than kept private to `deriveIntentId`) so its
 * bit-twiddling can be proven independently against the RFC 4122 DNS-namespace
 * test vector in `derive-intent-id.test.ts`.
 */
export function uuidv5(namespaceUuid: string, name: string): string {
  const namespaceBytes = uuidToBytes(namespaceUuid);
  const nameBytes = Buffer.from(name, "utf8");
  const hash = createHash("sha1")
    .update(namespaceBytes)
    .update(nameBytes)
    .digest();

  const bytes = new Uint8Array(hash.subarray(0, 16));
  // Version nibble: high nibble of byte 6 becomes 0101 (5).
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  // Variant bits: top two bits of byte 8 become 10.
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  return bytesToUuid(bytes);
}

/**
 * RFC 4122 UUIDv5 over `${customerId}:${idempotencyKey}`, namespaced by the
 * fixed `INTENT_ID_NAMESPACE`. Deterministic, customer-scoped, no I/O.
 *
 * The `:` separator between `customerId` and `idempotencyKey` is provably
 * unambiguous: `CUSTOMER_ID_PATTERN` (`domain/intent.ts`) is
 * `/^[A-Za-z0-9_-]{1,128}$/` and can therefore never itself contain a `:`.
 */
export function deriveIntentId(
  customerId: string,
  idempotencyKey: string,
): string {
  return uuidv5(INTENT_ID_NAMESPACE, `${customerId}:${idempotencyKey}`);
}
