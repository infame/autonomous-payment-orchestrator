import { URL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mountExperiment } = (await import(
  new URL("../../../public/experiment-client.js", import.meta.url).href
)) as {
  mountExperiment(this: void, doc: unknown): { refresh(): Promise<boolean> };
};

/** Just the DOM surface used by this controller: mutable nodes, listeners,
 * selectors and text. No browser dependency or duplicated controller logic. */
class TestElement {
  textContent = "";
  value = "";
  hidden = false;
  disabled = false;
  className = "";
  open = false;
  focused = false;
  scrolls = 0;
  parentElement: TestElement | null = null;
  dataset: Record<string, string> = {};
  children: TestElement[] = [];
  readonly selectors = new Map<string, TestElement[]>();
  private readonly selected = new Map<string, TestElement>();
  private readonly handlers = new Map<
    string,
    (event: { preventDefault(): void }) => unknown
  >();
  readonly classList = { toggle: (_name: string, _enabled: boolean) => {} };
  readonly attributes = new Map<string, string>();
  constructor(readonly tag = "div") {}
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(
    name: string,
    handler: (event: { preventDefault(): void }) => unknown,
  ) {
    this.handlers.set(name, handler);
  }
  fire(name: string) {
    return this.handlers.get(name)?.({ preventDefault() {} });
  }
  querySelector(selector: string): TestElement {
    const child = this.children.find((node) => node.tag === selector);
    if (child) return child;
    if (!this.selected.has(selector))
      this.selected.set(selector, new TestElement(selector));
    return this.selected.get(selector)!;
  }
  querySelectorAll(selector: string): TestElement[] {
    if (this.selectors.has(selector)) return this.selectors.get(selector)!;
    return this.children.flatMap((node) => [
      ...(node.tag === selector ? [node] : []),
      ...node.querySelectorAll(selector),
    ]);
  }
  append(...nodes: TestElement[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: TestElement[]) {
    this.children = [...nodes];
  }
  matches(_selector: string) {
    return false;
  }
  closest(selector: string): TestElement | null {
    if (
      selector === this.tag ||
      (selector.startsWith(".") &&
        this.className.split(" ").includes(selector.slice(1)))
    )
      return this;
    return this.parentElement?.closest(selector) ?? null;
  }

  focus() {
    this.focused = true;
  }
  getBoundingClientRect() {
    return { top: 1000, bottom: 1200 };
  }
  scrollIntoView() {
    this.scrolls += 1;
  }
}
function testDocument() {
  const nodes = new Map<string, TestElement>();
  const getElementById = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new TestElement());
    return nodes.get(id)!;
  };
  getElementById("experiment").dataset.mode = "mock";
  getElementById("experiment-error").hidden = true;
  for (const id of ["exchange-details", "evidence-details", "other-tests"])
    getElementById(id).hidden = true;
  const defaultForm = new TestElement("form");
  defaultForm.querySelector("button").dataset.challenge = "temporary_failure";
  getElementById("experiment").selectors.set(".challenge-picker", [
    defaultForm,
  ]);
  return {
    getElementById,
    createElement: (tag: string) => new TestElement(tag),
    activeElement: null as TestElement | null,
    defaultView: null,
  };
}
function startChallenge(
  doc: Pick<ReturnType<typeof testDocument>, "getElementById">,
) {
  doc
    .getElementById("experiment")
    .querySelectorAll(".challenge-picker")[0]!
    .fire("submit");
}
function nodeText(node: TestElement): string {
  return [node.textContent, ...node.children.map(nodeText)].join(" ");
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const json = (body: unknown) => new Response(JSON.stringify(body));
const state = (id: string, status = "executing") => ({
  intent: {
    id,
    status,
    text: "Source",
    proposal: null,
    policyVerdict: null,
    durableLedgerEventId: "event",
  },
});
const evidence = (id: string) => ({
  evidence: {
    run: { runId: `run-${id}` },
    journal: { available: true, attempts: [] },
    ledger: {
      entries: [
        {
          id: `entry-${id}`,
          operationId: `operation-${id}`,
          account: "acquirer_clearing",
          direction: "debit",
          amount: { amount: 120000, currency: "USD" },
        },
      ],
    },
    resendAvailable: false,
  },
});
function completeEvidence(id: string) {
  const paymentId = `payment-${id}`;
  return {
    evidence: {
      ...evidence(id).evidence,
      resendAvailable: true,
      payment: {
        availability: "known",
        snapshot: {
          id: paymentId,
          status: "captured",
          capturedAmount: 50000,
          amountAuthorized: 50000,
          refundedAmount: 0,
          currency: "USD",
        },
      },
      ledger: {
        proof: { paymentId, capturedAmount: 50000, currency: "USD" },
        entries: ["debit", "credit"].map((direction, index) => ({
          id: `entry-${index}`,
          operationId: "op",
          paymentId,
          direction,
          account: "test",
          amount: { amount: 50000, currency: "USD" },
        })),
      },
    },
  };
}
function completedBatch(id: string) {
  const current = completeEvidence(id).evidence;
  return {
    attempted: 10,
    invariantVerified: true,
    receipts: Array.from({ length: 10 }, (_, index) => ({
      delivery: index + 1,
      status: "fulfilled",
      reason: null,
      result: {
        capture: current.payment.snapshot,
        ledgerOutcome: "already_posted",
        unchangedEntries: true,
        entryCountBefore: 2,
        entryCountAfter: 2,
        originalEntryIds: ["entry-0", "entry-1"],
        returnedEntryIds: ["entry-1", "entry-0"],
      },
    })),
  };
}
async function settle() {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("experiment controller response ownership", () => {
  it("keeps workspace slots and previous observations while refreshing without scrolling or stealing focus", async () => {
    const base = testDocument();
    const doc = {
      ...base,
      defaultView: {
        innerWidth: 375,
        innerHeight: 650,
        matchMedia: () => ({ matches: true }),
      },
    };
    const originalFocus = new TestElement("button"),
      nextFocus = new TestElement("button");
    doc.activeElement = originalFocus;
    const post = deferred<Response>(),
      nextRead = deferred<Response>();
    let stateReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (input === "/ui/challenges") return post.promise;
      if (input === "/api/intents/stable")
        return ++stateReads === 1
          ? Promise.resolve(json(state("stable", "completed")))
          : nextRead.promise;
      return Promise.resolve(json(completeEvidence("stable")));
    });
    const controller = mountExperiment(doc);
    const result = doc
      .getElementById("experiment")
      .querySelector(".experiment-results");
    expect(doc.getElementById("lab-verdict").textContent).toBe(
      "Ready for the first payment.",
    );
    for (const id of [
      "creation-exchange",
      "repeat-action-panel",
      "repeat-exchange",
      "main-result",
      "observed-state-fields",
    ])
      expect(doc.getElementById(id).hidden).toBe(false);
    startChallenge(doc);
    doc.activeElement = nextFocus;
    post.resolve(json({ intent: { id: "stable" } }));
    await settle();
    expect(originalFocus.focused).toBe(false);
    expect(nextFocus.focused).toBe(false);
    expect(result.scrolls).toBe(0);
    const previous = doc.getElementById("observed-source").textContent;
    const reading = controller.refresh();
    expect(doc.getElementById("observed-source").textContent).toBe(previous);
    expect(doc.getElementById("observed-read-status").textContent).toContain(
      "last confirmed observation",
    );
    expect(doc.getElementById("observed-state-fields").hidden).toBe(false);
    nextRead.reject(new Error("Read unavailable"));
    await expect(reading).rejects.toThrow("Read unavailable");
    expect(doc.getElementById("observed-source").textContent).toBe(
      "Unavailable",
    );
    expect(doc.getElementById("observed-state-fields").hidden).toBe(false);
    expect(doc.getElementById("actual-amount").textContent).toBe("Unknown");
    expect(doc.getElementById("demonstration-meaning").textContent).toContain(
      "No current result is verified",
    );
    expect(originalFocus.focused).toBe(false);
    expect(result.scrolls).toBe(0);
  });
  it("opens utility panels locally and closes them on explicit reset without submitting", async () => {
    const doc = testDocument(),
      rawButton = new TestElement("button"),
      evidenceButton = new TestElement("button");
    rawButton.dataset.utilityPanel = "exchange-details";
    evidenceButton.dataset.utilityPanel = "evidence-details";
    doc
      .getElementById("experiment")
      .selectors.set("[data-utility-panel]", [rawButton, evidenceButton]);
    const request = vi.spyOn(globalThis, "fetch");
    mountExperiment(doc);
    rawButton.fire("click");
    expect(rawButton.getAttribute("aria-expanded")).toBe("true");
    expect(doc.getElementById("exchange-details").hidden).toBe(false);
    evidenceButton.fire("click");
    expect(rawButton.getAttribute("aria-expanded")).toBe("false");
    expect(evidenceButton.getAttribute("aria-expanded")).toBe("true");
    expect(doc.getElementById("exchange-details").hidden).toBe(true);
    expect(doc.getElementById("evidence-details").hidden).toBe(false);
    expect(doc.getElementById("main-result").hidden).toBe(false);
    expect(request).not.toHaveBeenCalled();
    request.mockImplementation((input) =>
      Promise.resolve(
        json(
          input === "/ui/challenges"
            ? { intent: { id: "utility" } }
            : typeof input === "string" && input.endsWith("/evidence")
              ? completeEvidence("utility")
              : state("utility", "completed"),
        ),
      ),
    );
    startChallenge(doc);
    await settle();
    const beforeReset = request.mock.calls.length;
    doc.getElementById("new-experiment-action").fire("click");
    expect(doc.getElementById("exchange-details").hidden).toBe(true);
    expect(doc.getElementById("evidence-details").hidden).toBe(true);
    expect(doc.getElementById("other-tests").hidden).toBe(true);
    expect(rawButton.getAttribute("aria-expanded")).toBe("false");
    expect(evidenceButton.getAttribute("aria-expanded")).toBe("false");
    expect(request.mock.calls).toHaveLength(beforeReset);
    expect(doc.getElementById("main-result").hidden).toBe(false);
  });
  it("keeps the actual id-only POST acknowledgement separate from later GET observations", async () => {
    const doc = testDocument();
    const form = doc
      .getElementById("experiment")
      .querySelectorAll(".challenge-picker")[0]!;
    form.querySelector("button").dataset.challenge = "duplicates";
    const post = deferred<Response>(),
      firstGet = deferred<Response>();
    let reads = 0,
      postedBody = "";
    const observed = {
      ...state("request-one").intent,
      text: "Pay vendor $500.00. <script>actual stored source</script>",
      proposal: {
        kind: "propose_payment",
        amount: 50000,
        currency: "USD",
        merchantId: "vendor",
      },
      policyVerdict: {
        decision: "needs_approval",
        reason: "above_auto_approve_threshold",
      },
    };
    vi.spyOn(globalThis, "fetch").mockImplementation((input, options) => {
      if (input === "/ui/challenges") {
        postedBody =
          options?.body instanceof URLSearchParams
            ? options.body.toString()
            : "unexpected body";
        return post.promise;
      }
      if (input === "/api/intents/request-one")
        return ++reads === 1
          ? firstGet.promise
          : Promise.resolve(
              json({ intent: { ...observed, status: "completed" } }),
            );
      if (input === "/api/intents/request-one/evidence")
        return Promise.resolve(json(completeEvidence("request-one")));
      throw new Error("Unexpected request");
    });
    const controller = mountExperiment(doc);
    expect(doc.getElementById("creation-exchange").hidden).toBe(false);
    form.fire("submit");
    expect(postedBody).toBe("scenario=duplicates");
    expect(doc.getElementById("create-request-body").textContent).toBe(
      postedBody,
    );
    expect(doc.getElementById("create-response-summary").textContent).toContain(
      "Waiting for acknowledgement",
    );
    expect(doc.getElementById("observed-state").hidden).toBe(false);
    post.resolve(
      json({
        intent: { id: "request-one" },
        credentials: "must-not-be-captured",
      }),
    );
    await settle();
    const ack = doc.getElementById("create-response-raw").textContent;
    expect(JSON.parse(ack)).toEqual({ intent: { id: "request-one" } });
    expect(ack).not.toContain("credentials");
    expect(doc.getElementById("create-response-summary").textContent).toContain(
      "Payment is read separately",
    );
    expect(doc.getElementById("observed-state-fields").hidden).toBe(false);
    firstGet.resolve(json({ intent: observed }));
    await settle();
    expect(doc.getElementById("observed-source").textContent).toBe(
      observed.text,
    );
    expect(doc.getElementById("observed-proposal").textContent).toBe(
      "500.00 USD to vendor.",
    );
    expect(doc.getElementById("observed-policy").textContent).toContain(
      "Simulation authorized",
    );
    expect(doc.getElementById("observed-policy").textContent).toContain(
      "approval required by policy",
    );
    expect(doc.getElementById("payment-record-id").textContent).toBe(
      "Payment record ID: payment-request-one",
    );
    await controller.refresh();
    expect(doc.getElementById("create-response-raw").textContent).toBe(ack);
    expect(doc.getElementById("create-response-reference").textContent).toBe(
      "Request reference: request-one",
    );
    expect(doc.getElementById("demonstration-meaning").textContent).toContain(
      "baseline; repeats have not been tested yet",
    );
    expect(
      JSON.parse(doc.getElementById("backend-state-raw").textContent),
    ).toMatchObject({ intent: { text: observed.text } });
  });
  it("retains actual replay receipts through a failed GET and verifies only after read-only recovery", async () => {
    const doc = testDocument();
    const form = doc
      .getElementById("experiment")
      .querySelectorAll(".challenge-picker")[0]!;
    form.querySelector("button").dataset.challenge = "duplicates";
    let failRead = false;
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, options) => {
      if (typeof input !== "string") throw new Error("Expected string path");
      calls.push(`${options?.method || "GET"} ${input}`);
      if (input === "/ui/challenges")
        return Promise.resolve(json({ intent: { id: "trace" } }));
      if (input.endsWith("/redeliver")) {
        failRead = true;
        return Promise.resolve(
          json({ ...completedBatch("trace"), credentials: "not-for-display" }),
        );
      }
      if (failRead) throw new Error("GET unavailable");
      return Promise.resolve(
        json(
          input.endsWith("/evidence")
            ? completeEvidence("trace")
            : state("trace", "completed"),
        ),
      );
    });
    mountExperiment(doc);
    form.fire("submit");
    await settle();
    const ack = doc.getElementById("create-response-raw").textContent;
    doc.getElementById("repeat-action").fire("click");
    await settle();
    const batch = doc.getElementById("repeat-response-raw").textContent;
    const parsedBatch = JSON.parse(batch) as { receipts: unknown[] };
    expect(parsedBatch.receipts).toHaveLength(10);
    expect(batch).not.toContain("credentials");
    expect(doc.getElementById("repeat-response-summary").textContent).toContain(
      "10 delivery receipts returned",
    );
    expect(doc.getElementById("repeat-request-path").textContent).toBe(
      "POST /api/intents/trace/redeliver",
    );
    expect(doc.getElementById("actual-amount").textContent).toBe("Unknown");
    expect(doc.getElementById("observed-state-fields").hidden).toBe(false);
    expect(doc.getElementById("backend-state-raw").textContent).toContain(
      "Earlier raw state is not shown as current",
    );
    expect(doc.getElementById("demonstration-meaning").textContent).toContain(
      "No current result is verified",
    );
    expect(doc.getElementById("before-repeats").textContent).toContain(
      "500.00 USD",
    );
    expect(doc.getElementById("create-response-raw").textContent).toBe(ack);
    failRead = false;
    const beforeRead = calls.length;
    doc.getElementById("recovery-action").fire("click");
    await settle();
    expect(
      calls.slice(beforeRead).every((call) => call.startsWith("GET ")),
    ).toBe(true);
    expect(doc.getElementById("repeat-response-raw").textContent).toBe(batch);
    expect(doc.getElementById("create-response-raw").textContent).toBe(ack);
    expect(doc.getElementById("demonstration-meaning").textContent).toContain(
      "In this sequential simulator test",
    );
    expect(calls.filter((call) => call.startsWith("POST "))).toHaveLength(2);
  });
  it("requires an explicit reset after an unknown original submission", async () => {
    const doc = testDocument();
    const form = doc
      .getElementById("experiment")
      .querySelectorAll(".challenge-picker")[0]!;
    form.querySelector("button").dataset.challenge = "duplicates";
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unknown submission outcome"));
    mountExperiment(doc);
    form.fire("submit");
    await settle();
    expect(form.querySelector("button").disabled).toBe(true);
    expect(doc.getElementById("main-result").hidden).toBe(false);
    expect(doc.getElementById("create-response-summary").textContent).toContain(
      "No acknowledgement received",
    );
    expect(doc.getElementById("create-response-raw").textContent).toBe("");
    expect(doc.getElementById("observed-state").hidden).toBe(false);
    form.fire("submit");
    await settle();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    doc.getElementById("new-experiment-action").fire("click");
    expect(form.querySelector("button").disabled).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(doc.getElementById("creation-exchange").hidden).toBe(false);
    form.querySelector("button").dataset.challenge = "permanent_decline";
    form.fire("submit");
    await settle();
    expect(doc.getElementById("create-request-body").textContent).toBe(
      "scenario=permanent_decline",
    );
    expect(doc.getElementById("create-response-raw").textContent).toBe("");
    expect(doc.getElementById("repeat-exchange").hidden).toBe(false);
  });
  it.each([
    { phase: "state", outcome: "failure" },
    { phase: "evidence", outcome: "failure" },
    { phase: "evidence", outcome: "success" },
  ])(
    "ignores an obsolete poll $phase $outcome after a newer experiment loads",
    async ({ phase, outcome }) => {
      vi.useFakeTimers();
      const doc = testDocument();
      const stale = deferred<Response>();
      let submissions = 0;
      let aReads = 0;
      let aEvidence = 0;
      let bReads = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        if (typeof input !== "string")
          throw new Error("Expected string request path");
        const path = input;
        if (path === "/ui/challenges")
          return Promise.resolve(
            json({ intent: { id: ++submissions === 1 ? "a" : "b" } }),
          );
        if (path === "/api/intents/a")
          return ++aReads === 2 && phase === "state"
            ? stale.promise
            : Promise.resolve(json(state("a")));
        if (path === "/api/intents/a/evidence")
          return ++aEvidence === 2 && phase === "evidence"
            ? stale.promise
            : Promise.resolve(json(evidence("a")));
        if (path === "/api/intents/b") {
          bReads++;
          return Promise.resolve(json(state("b")));
        }
        if (path === "/api/intents/b/evidence")
          return Promise.resolve(json(evidence("b")));
        throw new Error(`Unexpected request ${path}`);
      });
      mountExperiment(doc);
      startChallenge(doc);
      await settle();
      expect(doc.getElementById("ledger-ids").textContent).toContain("entry-a");
      vi.advanceTimersByTime(1500);
      await settle(); // Old poll is now waiting.
      startChallenge(doc);
      await settle();
      expect(doc.getElementById("ledger-ids").textContent).toContain("entry-b");
      expect(
        JSON.parse(doc.getElementById("create-response-raw").textContent),
      ).toEqual({ intent: { id: "b" } });
      expect(doc.getElementById("experiment-error").hidden).toBe(true);
      if (outcome === "failure")
        stale.reject(new Error("obsolete offline request"));
      else stale.resolve(json(evidence("obsolete")));
      await settle();
      expect(doc.getElementById("ledger-ids").textContent).toContain("entry-b");
      expect(
        JSON.parse(doc.getElementById("create-response-raw").textContent),
      ).toEqual({ intent: { id: "b" } });
      expect(doc.getElementById("experiment-error").hidden).toBe(true);
      expect(doc.getElementById("experiment-status").textContent).toBe(
        "Payment workflow is running",
      );
      expect(vi.getTimerCount()).toBe(1);
      const previous = bReads;
      vi.advanceTimersByTime(1500);
      await settle();
      expect(bReads).toBe(previous + 1);
    },
  );

  it("shows an unknown pending challenge instead of retaining a prior payment result", async () => {
    vi.useFakeTimers();
    const doc = testDocument();
    const form = new TestElement("form");
    form.querySelector("button").dataset.challenge = "permanent_decline";
    doc.getElementById("experiment").selectors.set(".challenge-picker", [form]);
    const pending = deferred<Response>();
    let starts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (input === "/ui/challenges")
        return ++starts === 1
          ? Promise.resolve(json({ intent: { id: "prior" } }))
          : pending.promise;
      if (input === "/api/intents/prior")
        return Promise.resolve(json(state("prior", "completed")));
      return Promise.resolve(
        json({
          ...evidence("prior"),
          evidence: {
            ...evidence("prior").evidence,
            payment: {
              availability: "known",
              snapshot: {
                id: "prior",
                status: "captured",
                currency: "USD",
                capturedAmount: 50000,
              },
            },
          },
        }),
      );
    });
    mountExperiment(doc);
    startChallenge(doc);
    await settle();
    expect(doc.getElementById("actual-amount").textContent).toBe("500.00 USD");
    form.fire("submit");
    await settle();
    expect(doc.getElementById("actual-amount").textContent).toBe("—");
    expect(doc.getElementById("experiment-status").textContent).toContain(
      "Starting an isolated",
    );
    pending.resolve(
      new Response(
        JSON.stringify({ error: { message: "challenge unavailable" } }),
        { status: 503 },
      ),
    );
    await settle();
    expect(doc.getElementById("experiment-error").textContent).toBe(
      "challenge unavailable",
    );
    expect(doc.getElementById("actual-amount").textContent).toBe("—");
  });
  it("filters real rows locally and preserves selection across partial updates", async () => {
    vi.useFakeTimers();
    const doc = testDocument();
    const records = [
      {
        id: "auth",
        runId: "run",
        eventId: "event",
        step: "authorize",
        phase: "workflow",
        paymentId: "p",
        operationId: null,
        idempotencyKey: "authorize-key",
        startedAt: "2026-10-16T00:00:00.000Z",
        endedAt: "2026-10-16T00:00:00.020Z",
        outcome: "succeeded",
        errorCode: null,
      },
      {
        id: "capture",
        runId: "run",
        eventId: "event",
        step: "capture",
        phase: "resend",
        paymentId: "p",
        operationId: null,
        idempotencyKey: "capture-key",
        startedAt: "2026-10-16T00:00:00.030Z",
        endedAt: null,
        outcome: "started",
        errorCode: null,
      },
    ];
    vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      Promise.resolve(
        json(
          input === "/ui/challenges"
            ? { intent: { id: "log" } }
            : typeof input === "string" && input.endsWith("/evidence")
              ? {
                  evidence: {
                    ...evidence("log").evidence,
                    journal: { available: true, attempts: records },
                  },
                }
              : state("log"),
        ),
      ),
    );
    const controller = mountExperiment(doc);
    startChallenge(doc);
    await settle();
    expect(doc.getElementById("attempt-list").children).toHaveLength(2);
    doc
      .getElementById("attempt-list")
      .children[0]!.querySelector("button")
      .fire("click");
    expect(doc.getElementById("operation-raw").textContent).toContain("20 ms");
    doc.getElementById("log-step").value = "capture";
    doc.getElementById("log-step").fire("change");
    expect(doc.getElementById("attempt-list").children).toHaveLength(1);
    expect(doc.getElementById("log-summary").textContent).toBe(
      "Showing 1 of 2 recorded operations",
    );
    expect(
      doc.getElementById("attempt-list").children[0]?.dataset.attemptId,
    ).toBe("capture");
    await controller.refresh();
    expect(doc.getElementById("operation-raw").textContent).toContain(
      "authorize-key",
    );
    expect(doc.getElementById("log-step").value).toBe("capture");
  });
  it("keeps a single selected delivery response across log filters and refreshes", async () => {
    const doc = testDocument();
    const form = new TestElement("form");
    form.querySelector("button").dataset.challenge = "duplicates";
    doc.getElementById("experiment").selectors.set(".challenge-picker", [form]);
    const outer = new TestElement("details");
    outer.className = "evidence-drawer";
    const panel = new TestElement("section");
    panel.parentElement = outer;
    doc.getElementById("batch-selection").parentElement = panel;
    const rawDisclosure = new TestElement("details");
    rawDisclosure.parentElement = panel;
    doc.getElementById("batch-receipts").parentElement = rawDisclosure;
    const receipts = Array.from({ length: 10 }, (_, index) => ({
      delivery: index + 1,
      status: "fulfilled",
      result: { marker: `receipt-${index + 1}` },
    }));
    vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      Promise.resolve(
        json(
          input === "/ui/challenges"
            ? { intent: { id: "copies" } }
            : typeof input === "string" && input.endsWith("/redeliver")
              ? { receipts, invariantVerified: false }
              : typeof input === "string" && input.endsWith("/evidence")
                ? {
                    evidence: {
                      ...completeEvidence("copies").evidence,
                    },
                  }
                : state("copies", "completed"),
        ),
      ),
    );
    const controller = mountExperiment(doc);
    form.fire("submit");
    await settle();
    expect(doc.getElementById("delivery-chips").children).toHaveLength(0);
    doc.getElementById("repeat-action").fire("click");
    await settle();
    expect(doc.getElementById("delivery-chips").children).toHaveLength(10);
    expect(doc.getElementById("delivery-rows").children).toHaveLength(10);
    expect(nodeText(doc.getElementById("delivery-rows"))).toContain(
      "Delivery 10",
    );
    doc.getElementById("delivery-chips").children[6]!.fire("click");

    expect(rawDisclosure.open).toBe(false);
    expect(doc.getElementById("batch-selection").focused).toBe(true);
    expect(
      JSON.parse(doc.getElementById("batch-receipts").textContent),
    ).toEqual(receipts[6]);
    doc.getElementById("receipt-raw-disclosure").open = true;
    const seventhRow = doc.getElementById("delivery-rows").children[6]!;
    seventhRow.querySelector("button").fire("click");
    expect(
      seventhRow.querySelector("button").getAttribute("aria-pressed"),
    ).toBe("true");
    doc.getElementById("log-phase").value = "resend";
    doc.getElementById("log-phase").fire("change");
    await controller.refresh();
    expect(
      JSON.parse(doc.getElementById("batch-receipts").textContent),
    ).toEqual(receipts[6]);
    expect(doc.getElementById("batch-selection").textContent).toContain(
      "Delivery 7 of 10",
    );
    expect(doc.getElementById("receipt-raw-disclosure").open).toBe(true);
    expect(doc.getElementById("delivery-rows").children[6]).toBe(seventhRow);
  });
  it("renders safe structured operation details and keeps raw disclosure and filtered selection", async () => {
    const doc = testDocument();
    const malicious = '<img src=x onerror="alert(1)">';
    const record = {
      id: "local",
      runId: malicious,
      eventId: "event",
      step: "post-ledger",
      phase: "resend",
      paymentId: "p",
      operationId: "op",
      idempotencyKey: `key-${malicious}`,
      startedAt: "2026-10-16T00:00:00.000Z",
      endedAt: "2026-10-16T00:00:00.030Z",
      outcome: "failed",
      errorCode: malicious,
    };
    vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      Promise.resolve(
        json(
          input === "/ui/challenges"
            ? { intent: { id: "safe" } }
            : typeof input === "string" && input.endsWith("/evidence")
              ? {
                  evidence: {
                    ...evidence("safe").evidence,
                    journal: { available: true, attempts: [record] },
                    payment: {
                      availability: "known",
                      snapshot: {
                        id: "p",
                        status: "captured",
                        capturedAmount: 7345,
                        currency: "USD",
                      },
                    },
                  },
                }
              : state("safe", "completed"),
        ),
      ),
    );
    const controller = mountExperiment(doc);
    startChallenge(doc);
    await settle();
    expect(doc.getElementById("operation-title").textContent).toBe(
      "Save the payment record",
    );
    expect(doc.getElementById("operation-purpose").textContent).toContain(
      "not an HTTP call",
    );
    expect(doc.getElementById("operation-outcome").textContent).toContain(
      "30 ms",
    );
    const fields = doc.getElementById("operation-fields");
    expect(nodeText(fields)).toContain(malicious);
    const values = fields.querySelectorAll("span");
    expect(
      values.find((value) => value.className.includes("error-code"))
        ?.textContent,
    ).toBe(malicious);
    expect(values.every((value) => value.children.length === 0)).toBe(true);
    expect(nodeText(doc.getElementById("operation-related"))).toContain(
      "Current captured amount",
    );
    expect(nodeText(doc.getElementById("operation-related"))).toContain(
      "73.45 USD",
    );
    expect(
      JSON.parse(doc.getElementById("operation-raw").textContent),
    ).not.toHaveProperty("currentPaymentSnapshot");
    doc.getElementById("operation-raw-disclosure").open = true;
    doc.getElementById("log-step").value = "authorize";
    doc.getElementById("log-step").fire("change");
    expect(doc.getElementById("attempt-list").children).toHaveLength(0);
    expect(doc.getElementById("log-empty").hidden).toBe(false);
    expect(doc.getElementById("log-empty").textContent).toContain(
      "No operations match",
    );
    await controller.refresh();
    expect(doc.getElementById("operation-raw-disclosure").open).toBe(true);
    expect(doc.getElementById("operation-title").textContent).toBe(
      "Save the payment record",
    );
    expect(doc.getElementById("log-step").value).toBe("authorize");
    expect(doc.getElementById("case-observed-technical").textContent).toContain(
      "1 recorded operations",
    );
    doc.getElementById("log-outcome").value = "succeeded";
    doc.getElementById("log-phase").value = "workflow";
    doc.getElementById("log-phase").fire("change");
    doc.getElementById("reset-log-filters").fire("click");
    expect(
      ["log-step", "log-outcome", "log-phase"].map(
        (id) => doc.getElementById(id).value,
      ),
    ).toEqual(["all", "all", "all"]);
    expect(doc.getElementById("attempt-list").children).toHaveLength(1);
    expect(doc.getElementById("log-empty").hidden).toBe(true);
    expect(doc.getElementById("log-summary").textContent).toBe(
      "Showing 1 of 1 recorded operations",
    );
    expect(doc.getElementById("operation-raw-disclosure").open).toBe(true);
    expect(doc.getElementById("operation-title").textContent).toBe(
      "Save the payment record",
    );
  });
  it("shows batch evidence only for duplicate pending or unknown results and hides it on other requests", async () => {
    const doc = testDocument();
    const forms = [new TestElement("form"), new TestElement("form")];
    forms[0]!.querySelector("button").dataset.challenge = "duplicates";
    forms[1]!.querySelector("button").dataset.challenge = "temporary_failure";
    doc.getElementById("experiment").selectors.set(".challenge-picker", forms);
    const duplicate = deferred<Response>(),
      temporary = deferred<Response>(),
      manual = deferred<Response>();
    let challenges = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (input === "/ui/challenges")
        return ++challenges === 1 ? duplicate.promise : temporary.promise;
      if (input === "/ui/challenges") return manual.promise;
      if (typeof input === "string" && input.endsWith("/redeliver"))
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { message: "Batch outcome unavailable" } }),
            { status: 503 },
          ),
        );
      const id =
        typeof input === "string" && input.includes("dupe") ? "dupe" : "other";
      return Promise.resolve(
        json(
          typeof input === "string" && input.endsWith("/evidence")
            ? {
                evidence: {
                  ...completeEvidence(id).evidence,
                  resendAvailable: id === "dupe",
                },
              }
            : state(id, id === "dupe" ? "completed" : "needs_approval"),
        ),
      );
    });
    mountExperiment(doc);
    forms[0]!.fire("submit");
    expect(doc.getElementById("repeat-delivery-section").hidden).toBe(true);
    expect(doc.getElementById("batch-selection").textContent).toBe(
      "No batch attempted.",
    );
    duplicate.resolve(json({ intent: { id: "dupe" } }));
    await settle();
    doc.getElementById("repeat-action").fire("click");
    await settle();
    expect(doc.getElementById("repeat-delivery-section").hidden).toBe(true);
    expect(doc.getElementById("batch-selection").textContent).toContain(
      "Unknown",
    );
    forms[1]!.fire("submit");
    expect(doc.getElementById("repeat-delivery-section").hidden).toBe(true);
    expect(doc.getElementById("journal-provenance").textContent).not.toContain(
      "ten repeat deliveries",
    );
    temporary.resolve(json({ intent: { id: "other" } }));
    await settle();
    expect(doc.getElementById("repeat-delivery-section").hidden).toBe(true);
  });
  it("requires a second click with fresh baseline evidence and never repeats an uncertain batch", async () => {
    const doc = testDocument(),
      form = new TestElement("form");
    form.querySelector("button").dataset.challenge = "duplicates";
    doc.getElementById("experiment").selectors.set(".challenge-picker", [form]);
    let proofAvailable = false,
      repeats = 0;
    const delivery = deferred<Response>();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (input === "/ui/challenges")
        return Promise.resolve(json({ intent: { id: "baseline" } }));
      if (typeof input === "string" && input.endsWith("/redeliver")) {
        repeats++;
        return delivery.promise;
      }
      return Promise.resolve(
        json(
          typeof input === "string" && input.endsWith("/evidence")
            ? proofAvailable
              ? completeEvidence("baseline")
              : {
                  evidence: {
                    ...completeEvidence("baseline").evidence,
                    ledger: { proof: null, entries: [] },
                  },
                }
            : state("baseline", "completed"),
        ),
      );
    });
    mountExperiment(doc);
    form.fire("submit");
    expect(doc.getElementById("lab-verdict").textContent).toBe(
      "Starting the test…",
    );
    await settle();
    expect(repeats).toBe(0);
    expect(doc.getElementById("repeat-action").disabled).toBe(true);
    expect(doc.getElementById("recovery-action").hidden).toBe(false);
    doc.getElementById("repeat-action").fire("click");
    expect(repeats).toBe(0);
    proofAvailable = true;
    await vi.advanceTimersByTimeAsync(1500);
    await settle();
    expect(repeats).toBe(0);
    expect(doc.getElementById("repeat-action").disabled).toBe(false);
    doc.getElementById("repeat-action").fire("click");
    doc.getElementById("repeat-action").fire("click");
    expect(repeats).toBe(1);
    const before = doc.getElementById("baseline-raw").textContent;
    expect(JSON.parse(before)).toMatchObject({
      capturedAmount: 50000,
      paymentId: "payment-baseline",
    });
    expect(doc.getElementById("actual-amount").textContent).toBe("Unknown");
    expect(doc.getElementById("duplicate-proof").hidden).toBe(false);
    expect(doc.getElementById("before-repeats").textContent).toContain(
      "Baseline: 500.00 USD",
    );
    delivery.reject(new Error("network outcome unknown"));
    await settle();
    expect(doc.getElementById("baseline-raw").textContent).toBe(before);
    expect(doc.getElementById("actual-amount").textContent).toBe("Unknown");
    expect(doc.getElementById("repeat-action").disabled).toBe(true);
    doc.getElementById("recovery-action").fire("click");
    await settle();
    doc.getElementById("repeat-action").fire("click");
    expect(repeats).toBe(1);
    expect(doc.getElementById("baseline-raw").textContent).toBe(before);
  });

  it("polls executing to completed without sending repeats and reads uncached state", async () => {
    vi.useFakeTimers();
    const doc = testDocument(),
      form = new TestElement("form");
    form.querySelector("button").dataset.challenge = "duplicates";
    doc.getElementById("experiment").selectors.set(".challenge-picker", [form]);
    let stateReads = 0,
      repeats = 0;
    const cacheModes: RequestInit["cache"][] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, options) => {
      cacheModes.push(options?.cache);
      if (input === "/ui/challenges")
        return Promise.resolve(json({ intent: { id: "poll" } }));
      if (typeof input === "string" && input.endsWith("/redeliver")) {
        repeats++;
        throw new Error("Unexpected repeat");
      }
      return Promise.resolve(
        json(
          typeof input === "string" && input.endsWith("/evidence")
            ? completeEvidence("poll")
            : state("poll", ++stateReads === 1 ? "executing" : "completed"),
        ),
      );
    });
    mountExperiment(doc);
    form.fire("submit");
    await settle();
    expect(doc.getElementById("experiment-status").textContent).toBe(
      "Payment workflow is running",
    );
    expect(doc.getElementById("lab-verdict").textContent).toBe(
      "Waiting for the simulated payment to finish.",
    );
    expect(doc.getElementById("lab-verdict-panel").className).not.toContain(
      "warn",
    );
    expect(doc.getElementById("recovery-help").textContent).not.toContain(
      "delivery receipts",
    );
    await vi.advanceTimersByTimeAsync(1500);
    await settle();
    expect(doc.getElementById("experiment-status").textContent).toBe(
      "Payment completed",
    );
    expect(doc.getElementById("repeat-action").disabled).toBe(false);
    expect(repeats).toBe(0);
    expect(cacheModes.every((mode) => mode === "no-store")).toBe(true);
  });
  it("keeps partial replay refresh read-only and resets without submitting another experiment", async () => {
    const doc = testDocument(),
      form = new TestElement("form");
    form.querySelector("button").dataset.challenge = "duplicates";
    doc.getElementById("experiment").selectors.set(".challenge-picker", [form]);
    const requests: { path: string; method: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input, options) => {
      if (typeof input !== "string") throw new Error("Expected string path");
      const path = input;
      requests.push({ path, method: options?.method ?? "GET" });
      if (path === "/ui/challenges")
        return Promise.resolve(json({ intent: { id: "partial" } }));
      if (path.endsWith("/redeliver"))
        return Promise.resolve(
          json({
            invariantVerified: false,
            attempted: 1,
            receipts: Array.from({ length: 10 }, (_, index) => ({
              delivery: index + 1,
              status: index === 0 ? "unknown" : "not_attempted",
              result: null,
              reason:
                index === 0 ? "delivery_outcome_unknown" : "batch_stopped",
            })),
          }),
        );
      return Promise.resolve(
        json(
          path.endsWith("/evidence")
            ? completeEvidence("partial")
            : state("partial", "completed"),
        ),
      );
    });
    mountExperiment(doc);
    expect(doc.getElementById("main-result").hidden).toBe(false);
    expect(doc.getElementById("evidence-details").hidden).toBe(true);
    form.fire("submit");
    await settle();
    expect(form.querySelector("button").disabled).toBe(true);
    const afterOriginal = requests.length;
    form.fire("submit");
    await settle();
    expect(requests).toHaveLength(afterOriginal);
    doc.getElementById("repeat-action").fire("click");
    await settle();
    expect(doc.getElementById("lab-verdict").textContent).toBe(
      "Repeat verification is incomplete.",
    );
    expect(doc.getElementById("batch-status").textContent).toContain(
      "1 attempted · 0 fulfilled",
    );
    expect(doc.getElementById("batch-status").textContent).toContain(
      "1 unknown · 0 failed · 9 skipped",
    );
    expect(doc.getElementById("demonstration-meaning").textContent).toContain(
      "repeat test remains unverified",
    );
    expect(doc.getElementById("recovery-action").hidden).toBe(false);
    expect(doc.getElementById("repeat-delivery-section").hidden).toBe(false);
    expect(doc.getElementById("repeat-action").disabled).toBe(true);
    const originalPosts = requests.filter(
      (request) => request.method === "POST",
    ).length;
    expect(doc.getElementById("recovery-help").textContent).toContain(
      "Missing delivery receipts cannot be recovered",
    );
    const beforeRead = requests.length;
    doc.getElementById("recovery-action").fire("click");
    await settle();
    expect(
      requests.slice(beforeRead).every((request) => request.method === "GET"),
    ).toBe(true);
    expect(doc.getElementById("lab-verdict").textContent).toBe(
      "Repeat verification is incomplete.",
    );
    const beforeReset = requests.length;
    doc.getElementById("new-experiment-action").fire("click");
    await settle();
    expect(requests).toHaveLength(beforeReset);
    expect(
      requests.filter((request) => request.method === "POST"),
    ).toHaveLength(originalPosts);
    expect(doc.getElementById("main-result").hidden).toBe(false);
    expect(doc.getElementById("evidence-details").hidden).toBe(true);
    expect(form.querySelector("button").disabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats actual null evidence before execution as complete and stops reading without inventing rows", async () => {
    const doc = testDocument();
    vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      Promise.resolve(
        json(
          input === "/ui/challenges"
            ? { intent: { id: "blocked" } }
            : typeof input === "string" && input.endsWith("/evidence")
              ? { evidence: null }
              : {
                  intent: {
                    ...state("blocked", "rejected").intent,
                    durableLedgerEventId: null,
                    policyVerdict: {
                      decision: "reject",
                      reason: "amount_not_grounded",
                    },
                  },
                },
        ),
      ),
    );
    mountExperiment(doc);
    startChallenge(doc);
    await settle();
    expect(doc.getElementById("recovery-action").hidden).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(doc.getElementById("experiment-error").hidden).toBe(true);
    expect(doc.getElementById("attempt-count").textContent).toBe("—");
    expect(doc.getElementById("log-summary").textContent).toBe(
      "No workflow started.",
    );
    expect(doc.getElementById("attempt-list").children).toHaveLength(0);
  });
  it.each([
    { body: {}, event: null },
    { body: { evidence: null }, event: "event" },
  ])(
    "keeps malformed or contradictory no-execution evidence distinct from an unchanged read: %j",
    async ({ body, event }) => {
      const doc = testDocument();
      vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
        Promise.resolve(
          json(
            input === "/ui/challenges"
              ? { intent: { id: "bad-evidence" } }
              : typeof input === "string" && input.endsWith("/evidence")
                ? body
                : {
                    intent: {
                      ...state("bad-evidence", "completed").intent,
                      durableLedgerEventId: event,
                    },
                  },
          ),
        ),
      );
      mountExperiment(doc);
      startChallenge(doc);
      await settle();
      doc.getElementById("recovery-action").fire("click");
      await settle();
      expect(doc.getElementById("read-status").textContent).toContain(
        "evidence is unavailable",
      );
      expect(doc.getElementById("recovery-action").hidden).toBe(false);
    },
  );
  it("bounds terminal proof reads and exposes only a GET recovery action after the pause", async () => {
    const doc = testDocument();
    let ready = false,
      posts = 0,
      gets = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, options) => {
      if (options?.method === "POST") {
        posts++;
        return Promise.resolve(json({ intent: { id: "capped" } }));
      }
      gets++;
      return Promise.resolve(
        json(
          typeof input === "string" && input.endsWith("/evidence")
            ? ready
              ? completeEvidence("capped")
              : {
                  evidence: {
                    ...completeEvidence("capped").evidence,
                    ledger: { proof: null, entries: [] },
                  },
                }
            : state("capped", "completed"),
        ),
      );
    });
    mountExperiment(doc);
    startChallenge(doc);
    await settle();
    expect(doc.getElementById("recovery-action").hidden).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60 * 1500);
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    expect(doc.getElementById("recovery-action").hidden).toBe(false);
    expect(doc.getElementById("recovery-action").textContent).toBe(
      "Refresh evidence",
    );
    expect(doc.getElementById("read-status").textContent).toContain("paused");
    expect(gets).toBe(122);
    ready = true;
    doc.getElementById("recovery-action").fire("click");
    await settle();
    expect(posts).toBe(1);
    expect(gets).toBe(124);
    expect(doc.getElementById("recovery-action").hidden).toBe(false);
    expect(doc.getElementById("lab-verdict").textContent).toContain(
      "recovery evidence is incomplete",
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps reading a failed terminal payment until its actual snapshot arrives, without waiting for journal completeness", async () => {
    const doc = testDocument(),
      form = doc
        .getElementById("experiment")
        .querySelectorAll(".challenge-picker")[0]!;
    form.querySelector("button").dataset.challenge = "permanent_decline";
    let reads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      if (input === "/ui/challenges")
        return Promise.resolve(json({ intent: { id: "decline600" } }));
      if (typeof input === "string" && input.endsWith("/evidence"))
        return Promise.resolve(
          json({
            evidence: {
              run: { runId: "run", status: "failed" },
              journal: { available: false, attempts: [] },
              ledger: { proof: null, entries: [] },
              payment:
                ++reads === 1
                  ? { availability: "unknown", snapshot: null }
                  : {
                      availability: "known",
                      snapshot: {
                        id: "p",
                        status: "failed",
                        capturedAmount: 0,
                        amountAuthorized: 60000,
                        currency: "USD",
                      },
                    },
            },
          }),
        );
      return Promise.resolve(
        json({
          intent: {
            ...state("decline600", "failed").intent,
            text: "Pay the vendor $600.00 for the invoice.",
            proposal: {
              kind: "propose_payment",
              amount: 60000,
              currency: "USD",
            },
            policyVerdict: {
              decision: "needs_approval",
              reason: "above_auto_approve_threshold",
              detail:
                "Amount is at or above the auto-approve threshold of 50000",
            },
          },
        }),
      );
    });
    mountExperiment(doc);
    startChallenge(doc);
    expect(doc.getElementById("source-invoice-amount").textContent).toBe(
      "$600.00 USD",
    );
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    expect(doc.getElementById("actual-amount").textContent).toBe("Unknown");
    await vi.advanceTimersByTimeAsync(1500);
    await settle();
    expect(reads).toBe(2);
    expect(doc.getElementById("actual-amount").textContent).toBe("0.00 USD");
    expect(doc.getElementById("source-invoice-amount").textContent).toBe(
      "$600.00 USD",
    );
    expect(doc.getElementById("policy-decision").textContent).toBe(
      "Simulation authorized",
    );
    expect(doc.getElementById("policy-explanation").textContent).not.toContain(
      "50000",
    );
    expect(doc.getElementById("backend-state-raw").textContent).toContain(
      "threshold of 50000",
    );
    expect(doc.getElementById("recovery-action").hidden).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("offers GET-only reconnect after a network failure and does not redeliver or start a new experiment", async () => {
    const doc = testDocument();
    let offline = true,
      posts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, options) => {
      if (options?.method === "POST") {
        posts++;
        return Promise.resolve(json({ intent: { id: "reconnect" } }));
      }
      if (offline) return Promise.reject(new Error("network offline"));
      return Promise.resolve(
        json(
          typeof input === "string" && input.endsWith("/evidence")
            ? completeEvidence("reconnect")
            : state("reconnect", "completed"),
        ),
      );
    });
    mountExperiment(doc);
    startChallenge(doc);
    await settle();
    expect(doc.getElementById("recovery-action").hidden).toBe(false);
    expect(doc.getElementById("recovery-action").textContent).toBe(
      "Refresh evidence",
    );
    expect(doc.getElementById("read-status").textContent).toContain(
      "network offline",
    );
    offline = false;
    doc.getElementById("recovery-action").fire("click");
    doc.getElementById("recovery-action").fire("click");
    await settle();
    expect(posts).toBe(1);
    expect(doc.getElementById("recovery-action").hidden).toBe(false);
    expect(doc.getElementById("experiment-error").hidden).toBe(true);
  });
});
