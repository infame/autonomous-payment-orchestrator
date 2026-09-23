import { describe, expect, it } from "vitest";
import { createInngestClient } from "./client.js";

describe("createInngestClient base URLs", () => {
  it("keeps the SDK's distinct cloud API and event defaults when baseUrl is omitted", () => {
    const client = createInngestClient({
      isDev: false,
      eventKey: "event-key",
      signingKey: "signing-key",
    });

    expect(client.apiBaseUrl).toBe("https://api.inngest.com/");
    expect(client.eventBaseUrl).toBe("https://inn.gs/");
  });

  it("uses one explicit base only for the local dev server override", () => {
    const client = createInngestClient({
      isDev: true,
      baseUrl: "http://localhost:8288",
    });

    expect(client.apiBaseUrl).toBe("http://localhost:8288");
    expect(client.eventBaseUrl).toBe("http://localhost:8288");
  });
});
