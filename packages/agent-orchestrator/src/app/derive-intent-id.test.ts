import { describe, expect, it } from "vitest";
import { deriveIntentId, uuidv5 } from "./derive-intent-id.js";
import { IntentIdParam } from "../adapters/http/server-schemas.js";

// RFC 4122 DNS namespace UUID — used ONLY to prove the hash/bit-twiddling
// logic against the RFC's own known-good test vector. Never used as this
// package's actual namespace.
const RFC_DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

describe("uuidv5", () => {
  it("matches the RFC 4122 DNS-namespace test vector", () => {
    expect(uuidv5(RFC_DNS_NAMESPACE, "www.example.org")).toBe(
      "74738ff5-5367-5958-9aee-98fffdcd1876",
    );
  });
});

describe("deriveIntentId", () => {
  it("is deterministic: identical inputs produce identical output across multiple calls", () => {
    const a = deriveIntentId("cust_1", "key-1");
    const b = deriveIntentId("cust_1", "key-1");
    const c = deriveIntentId("cust_1", "key-1");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("a different customerId produces a different id, same idempotencyKey", () => {
    const a = deriveIntentId("cust_1", "key-1");
    const b = deriveIntentId("cust_2", "key-1");
    expect(a).not.toBe(b);
  });

  it("a different idempotencyKey produces a different id, same customerId", () => {
    const a = deriveIntentId("cust_1", "key-1");
    const b = deriveIntentId("cust_1", "key-2");
    expect(a).not.toBe(b);
  });

  it("produces a string that IntentIdParam accepts (a real, well-formed UUID)", () => {
    const result = deriveIntentId("cust_1", "key-1");
    expect(() => IntentIdParam.parse(result)).not.toThrow();
  });

  it("sets the version nibble to 5 and the variant nibble to one of 8|9|a|b", () => {
    const result = deriveIntentId("cust_1", "key-1");
    expect(result[14]).toBe("5");
    expect(["8", "9", "a", "b"]).toContain(result[19]);
  });
});
