/** Same-page experiment controller. Every backend/model string uses textContent. */
export async function requestJson(
  url,
  options = {},
  fetchImpl = globalThis.fetch,
) {
  const response = await fetchImpl(url, {
    ...options,
    cache: "no-store",
    headers: { Accept: "application/json", ...options.headers },
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      "The service returned an unreadable response. Check the current state before retrying an action.",
    );
  }
  if (!response.ok)
    throw new Error(
      body?.error?.message ||
        `The request failed (${response.status}). Check the current state before retrying an action.`,
    );
  return body;
}
export function formatMoney(amount, currency) {
  return Number.isSafeInteger(amount) && typeof currency === "string"
    ? `${(amount / 100).toFixed(2)} ${currency}`
    : "Amount unavailable";
}
export function summarizeLedger(entries) {
  if (!entries.length) return { balanced: false, label: "No entries yet" };
  const currency = entries[0].amount.currency;
  let debit = 0,
    credit = 0;
  for (const entry of entries) {
    if (
      entry.amount.currency !== currency ||
      !Number.isSafeInteger(entry.amount.amount) ||
      entry.amount.amount <= 0 ||
      !["debit", "credit"].includes(entry.direction)
    )
      return { balanced: false, label: "Entries need inspection" };
    if (entry.direction === "debit") debit += entry.amount.amount;
    else credit += entry.amount.amount;
  }
  return {
    balanced: debit === credit && debit > 0,
    label: `${formatMoney(debit, currency)} debit = ${formatMoney(credit, currency)} credit; net ${formatMoney(credit - debit, currency)}`,
  };
}
const explanations = {
  above_auto_approve_threshold:
    "This amount requires your approval before payment can start.",
  amount_not_grounded:
    "The proposed amount does not appear in the source request or accepted clarification.",
  merchant_not_grounded:
    "The proposed recipient is not supported by the request.",
  currency_not_allowed: "The proposed currency is not allowed.",
  hard_limit_exceeded: "The amount exceeds the payment policy's maximum limit.",
  daily_rate_limit_exceeded:
    "The payment policy's daily request limit has been reached.",
};

const challengePlans = {
  duplicates: {
    title: "One payment, ten repeat deliveries",
    expected:
      "The $500 payment should stay $500 after ten repeat deliveries. First: authorize, capture, and record one payment (3 operations). Then: 10 sequential deliveries, each repeating capture + ledger posting (20 operations). A healthy recorded path has 23 operations, one payment identity, and the same two ledger entries.",
  },
  temporary_failure: {
    title: "A temporary provider failure",
    expected:
      "The payment should recover and complete once. The simulator fails the first authorization and first capture call. The workflow retries each, then records the payment: 5 operations on the expected recovery path.",
  },
  inflated_amount: {
    title: "An unsupported assistant amount",
    expected:
      "The proposed increase should be stopped. The simulated assistant proposes $5,000 for a $500 source. The real policy should stop it before a payment workflow starts: no payment operations expected.",
  },
  permanent_decline: {
    title: "A permanent authorization decline",
    expected:
      "The $600 payment should be refused, with $0 captured. One authorization call should return a failed payment record. No capture or ledger posting should follow. The captured amount must come from the payment service.",
  },
};
export function casePlanPresentation(challenge, intent, evidence, batch) {
  const plan = challengePlans[challenge] || {
    title: "Choose an experiment",
    expected:
      "Each challenge states its expected path before you start. Expected counts describe a healthy test path; observed results come from the backend.",
  };
  const attempts = evidence?.journal?.attempts || [];
  let observed = !intent
    ? "No saved result yet."
    : !intent.durableLedgerEventId
      ? intent.policyVerdict?.decision === "reject"
        ? `Stopped by policy: ${explanations[intent.policyVerdict.reason] || "The proposal was rejected."} No workflow was started.`
        : "No payment workflow has started; inspect the proposal and review state."
      : !evidence
        ? "Workflow started; execution evidence is not available yet."
        : evidence.journal?.available
          ? `${attempts.length} recorded operations: ${attempts.filter((a) => a.outcome === "succeeded").length} returned, ${attempts.filter((a) => a.outcome === "failed").length} errors, ${attempts.filter((a) => a.outcome === "started").length} outcomes not finalized.`
          : "Operation history is unavailable; the workflow and payment result remain independent.";
  if (batch?.receipts)
    observed += ` Repeat-delivery receipts: ${batch.receipts.length}; ${batch.receipts.filter((r) => r.status !== "not_attempted").length} attempted, ${batch.receipts.filter((r) => r.status === "fulfilled").length} fulfilled, ${batch.receipts.filter((r) => r.status === "failed").length} failed, ${batch.receipts.filter((r) => r.status === "unknown").length} unknown, ${batch.receipts.filter((r) => r.status === "not_attempted").length} not attempted.`;
  else if (batch?.unknown)
    observed +=
      " Repeat-delivery response is unavailable; outcomes are unknown.";
  return {
    ...plan,
    observed,
    provenance:
      "Journal operations are best-effort observations of payment-service calls and local ledger work. Missing records or extra resends can change the count." +
      (challenge === "duplicates" || (batch !== null && batch !== undefined)
        ? " Batch receipts describe the ten repeat deliveries separately; they are not mapped to journal rows. The journal is not a delivery counter."
        : ""),
  };
}
export function operationPresentation(attempt) {
  const local = attempt.step === "post-ledger";
  const purpose = {
    authorize: [
      "Ask permission to pay",
      "The payment service checks whether this payment can be authorized.",
    ],
    capture: [
      "Complete the payment",
      "The payment service receives a capture request for the payment.",
    ],
    "post-ledger": [
      "Save the payment record",
      "The local ledger repository writes or finds the balanced entry pair for this payment.",
    ],
  }[attempt.step] || [
    "Inspect recorded operation",
    "This is a backend observation; inspect its technical fields.",
  ];
  const start = Date.parse(attempt.startedAt),
    end = attempt.endedAt === null ? NaN : Date.parse(attempt.endedAt);
  return {
    title: purpose[0],
    purpose: purpose[1],
    transport: local
      ? "Local ledger repository operation (not an HTTP call)"
      : "Payment-service client call",
    outcome:
      attempt.outcome === "succeeded"
        ? "Returned"
        : attempt.outcome === "failed"
          ? "Operation error"
          : "In progress / outcome unknown",
    tone: attempt.outcome === "succeeded" ? "returned" : "uncertain",
    duration:
      Number.isFinite(start) && Number.isFinite(end) && end >= start
        ? `${end - start} ms`
        : "Duration unknown",
    phase:
      attempt.phase === "resend"
        ? "Repeat request (journal observation; no delivery number)"
        : "Original workflow",
    caveat:
      attempt.outcome === "failed"
        ? "This operation recorded an error. Inspect later attempts and the final payment result; this row alone does not establish money moved."
        : attempt.outcome === "started"
          ? "No final outcome recorded yet."
          : "Returned means this operation resolved. It does not by itself prove a successful payment.",
  };
}
export function currentOperationContext(attempt, evidence) {
  const snapshot =
    evidence?.payment?.availability === "known" &&
    evidence.payment.snapshot?.id === attempt.paymentId
      ? evidence.payment.snapshot
      : null;
  const entries = (evidence?.ledger?.entries || []).filter(
    (entry) =>
      entry.paymentId === attempt.paymentId &&
      (attempt.operationId === null ||
        entry.operationId === attempt.operationId),
  );
  return { snapshot, entryIds: entries.map((entry) => entry.id) };
}
export function receiptPresentation(receipt, evidence) {
  const result = receipt.result;
  const sameIds =
    result &&
    Array.isArray(result.originalEntryIds) &&
    Array.isArray(result.returnedEntryIds) &&
    result.originalEntryIds.length === 2 &&
    JSON.stringify([...result.originalEntryIds].sort()) ===
      JSON.stringify([...result.returnedEntryIds].sort());
  const returned =
    receipt.status === "fulfilled" &&
    result?.capture?.id &&
    result.capture.status === "captured" &&
    Number.isSafeInteger(result.capture.capturedAmount) &&
    result.capture.capturedAmount > 0 &&
    result.ledgerOutcome === "already_posted" &&
    result.unchangedEntries === true &&
    sameIds &&
    result.entryCountBefore === 2 &&
    result.entryCountAfter === 2;
  const proof = evidence?.ledger?.proof;
  const referenceIds = (evidence?.ledger?.entries || [])
    .map((entry) => entry.id)
    .sort();
  const matching =
    returned &&
    proof?.paymentId === result.capture.id &&
    proof.currency === result.capture.currency &&
    proof.capturedAmount === result.capture.capturedAmount &&
    referenceIds.length === 2 &&
    JSON.stringify(referenceIds) ===
      JSON.stringify([...result.originalEntryIds].sort());
  return {
    label: matching
      ? `Existing payment returned · total still ${formatMoney(result.capture.capturedAmount, result.capture.currency)}`
      : returned
        ? "Capture and ledger requests returned; identity match unverified"
        : receipt.status === "not_attempted"
          ? "Not attempted"
          : receipt.status === "unknown"
            ? "Outcome unknown"
            : receipt.status === "failed"
              ? "Delivery stopped / needs inspection"
              : "Receipt needs inspection",
    tone: matching ? "verified" : returned ? "returned" : "uncertain",
    detail: matching
      ? "The same payment identity and original two ledger entries were returned. This is not an additional payment amount."
      : result
        ? `Capture returned ${result.capture?.status || "an unknown status"}: ${formatMoney(result.capture?.capturedAmount, result.capture?.currency)}. Ledger returned ${result.ledgerOutcome || "unknown"}; entry count ${result.entryCountBefore ?? "unknown"} → ${result.entryCountAfter ?? "unknown"}.`
        : receipt.status === "not_attempted"
          ? "The batch stopped before sending this delivery."
          : "No confirmed capture + posting result was received for this delivery.",
    reason: receipt.reason || null,
  };
}

export function policyPresentation(intent, preset = false) {
  const verdict = intent.policyVerdict;
  if (verdict?.decision === "needs_approval" && intent.durableLedgerEventId)
    return {
      label: preset ? "Simulation authorized" : "Approval received",
      explanation: preset
        ? "Starting this preset authorized its simulated payment. The test handled the approval required by policy before execution."
        : "Policy required a human decision. Approval released this payment for execution.",
    };
  if (verdict?.decision === "needs_approval" && intent.status === "rejected")
    return {
      label: "Reviewer stopped payment",
      explanation:
        "Policy required a human decision. The reviewer rejected the proposal before execution.",
    };
  return {
    label:
      verdict?.decision === "needs_approval"
        ? "Approval required"
        : verdict?.decision === "reject"
          ? "Blocked"
          : verdict?.decision === "allow"
            ? "Allowed"
            : "Not evaluated",
    explanation:
      verdict?.decision === "allow"
        ? "Policy allows this proposal."
        : explanations[verdict?.reason] ||
          "No policy verdict is available yet.",
  };
}

function capturedEvidence(evidence) {
  const snapshot =
    evidence?.payment?.availability === "known"
      ? evidence.payment.snapshot
      : null;
  const proof = evidence?.ledger?.proof,
    entries = evidence?.ledger?.entries || [];
  if (
    snapshot?.status !== "captured" ||
    !Number.isSafeInteger(snapshot.capturedAmount) ||
    snapshot.capturedAmount <= 0 ||
    !proof ||
    proof.paymentId !== snapshot.id ||
    proof.currency !== snapshot.currency ||
    proof.capturedAmount !== snapshot.capturedAmount ||
    entries.length !== 2 ||
    new Set(entries.map((entry) => entry.id)).size !== 2 ||
    !summarizeLedger(entries).balanced ||
    !entries.every(
      (entry) =>
        entry.paymentId === snapshot.id &&
        entry.amount.currency === snapshot.currency &&
        entry.amount.amount === snapshot.capturedAmount,
    )
  )
    return null;
  return { snapshot, entries };
}
export function duplicateBaseline(intent, evidence) {
  const captured = capturedEvidence(evidence);
  if (intent?.status !== "completed" || !evidence?.resendAvailable || !captured)
    return null;
  return {
    intentId: intent.id,
    paymentId: captured.snapshot.id,
    currency: captured.snapshot.currency,
    capturedAmount: captured.snapshot.capturedAmount,
    entryIds: captured.entries.map((entry) => entry.id).sort(),
  };
}

export function recoveredOperations(attempts) {
  return attempts
    .filter(
      (failed) =>
        failed.phase === "workflow" &&
        failed.outcome === "failed" &&
        failed.runId &&
        failed.idempotencyKey &&
        attempts.some(
          (returned) =>
            returned.phase === "workflow" &&
            returned.outcome === "succeeded" &&
            returned.runId === failed.runId &&
            returned.step === failed.step &&
            returned.idempotencyKey === failed.idempotencyKey &&
            Date.parse(returned.startedAt) > Date.parse(failed.startedAt),
        ),
    )
    .map((attempt) => attempt.step);
}
export function sourceDisplayText(source, challenge, mode) {
  return mode === "mock" &&
    challenge === "inflated_amount" &&
    source === "Pay the vendor $500.00 for the invoice. sim.amount.inflated"
    ? "Pay the vendor $500.00 for the invoice."
    : source;
}
export function testAssessment(challenge, intent, evidence) {
  if (!challenge || !intent)
    return {
      label: "Test outcome not known yet",
      detail: "Waiting for the actual backend result.",
      tone: "warn",
    };
  if (
    challenge === "inflated_amount" &&
    intent.status === "rejected" &&
    intent.policyVerdict?.reason === "amount_not_grounded" &&
    intent.policyVerdict.decision === "reject" &&
    !intent.durableLedgerEventId &&
    !evidence?.ledger?.proof
  )
    return {
      label: "The amount guard worked",
      detail:
        "The actual policy stopped the unsupported increase before execution.",
      tone: "good",
    };
  const snapshot =
    evidence?.payment?.availability === "known"
      ? evidence.payment.snapshot
      : null;
  if (
    challenge === "permanent_decline" &&
    intent.status === "failed" &&
    snapshot?.status === "failed" &&
    snapshot.capturedAmount === 0 &&
    !evidence?.ledger?.proof &&
    !(evidence?.ledger?.entries || []).length
  )
    return {
      label: "The expected refusal was observed",
      detail:
        "The payment service refused the payment and confirms zero captured. This is the intended outcome of this test.",
      tone: "good",
    };
  if (
    challenge === "temporary_failure" &&
    intent.status === "completed" &&
    capturedEvidence(evidence) !== null
  ) {
    const recovered = evidence?.journal?.available
      ? recoveredOperations(evidence.journal.attempts)
      : [];
    return recovered.includes("authorize") && recovered.includes("capture")
      ? {
          label: "The payment recovered and completed once",
          detail:
            "Both authorization and capture have a recorded error followed by a returned operation with the same run and idempotency key.",
          tone: "good",
        }
      : {
          label: "Payment completed; recovery evidence is incomplete",
          detail:
            "A completed payment does not by itself prove that both planned failures and retries were recorded.",
          tone: "warn",
        };
  }
  return {
    label: "Compare the expected test with the actual result",
    detail:
      intent.policyVerdict?.decision === "reject"
        ? explanations[intent.policyVerdict.reason] ||
          "A different policy stop prevented this test from reaching its expected path."
        : "This test has not yet established its expected outcome. Inspect the current state or check again.",
    tone: "warn",
  };
}

export function paymentPresentation(
  intent,
  evidence,
  batch,
  challenge,
  baseline,
) {
  const snapshot =
    evidence?.payment?.availability === "known"
      ? evidence.payment.snapshot
      : null;
  const receiptProof = evidence?.ledger?.proof;
  const entryIds = (evidence?.ledger?.entries || []).map((e) => e.id).sort();
  const verifiedBatch =
    baseline &&
    baseline.intentId === intent?.id &&
    baseline.paymentId === snapshot?.id &&
    baseline.capturedAmount === snapshot?.capturedAmount &&
    baseline.currency === snapshot?.currency &&
    JSON.stringify(baseline.entryIds) === JSON.stringify(entryIds) &&
    batch?.invariantVerified === true &&
    Array.isArray(batch.receipts) &&
    batch.receipts.length === 10 &&
    snapshot?.status === "captured" &&
    receiptProof &&
    receiptProof.paymentId === snapshot.id &&
    receiptProof.capturedAmount === snapshot.capturedAmount &&
    receiptProof.currency === snapshot.currency &&
    entryIds.length === 2 &&
    batch.receipts.every(
      (r) =>
        r.status === "fulfilled" &&
        r.result?.unchangedEntries === true &&
        r.result?.ledgerOutcome === "already_posted" &&
        r.result?.capture?.id === snapshot.id &&
        r.result?.entryCountBefore === 2 &&
        r.result?.entryCountAfter === 2 &&
        JSON.stringify([...(r.result?.originalEntryIds || [])].sort()) ===
          JSON.stringify(entryIds) &&
        JSON.stringify([...(r.result?.returnedEntryIds || [])].sort()) ===
          JSON.stringify(entryIds),
    );
  const paid = snapshot
    ? formatMoney(snapshot.capturedAmount, snapshot.currency)
    : "Unknown";
  if (!intent)
    return {
      paid: "—",
      state: "No payment result yet",
      verdict: "Choose a failure to test.",
      detail: "No experiment has run yet.",
      tone: "",
    };
  if (!intent.durableLedgerEventId && intent.status === "needs_clarification")
    return {
      paid: "Not started",
      state: "Waiting for your answer",
      verdict: "Please clarify the request.",
      detail:
        intent.proposal?.question ||
        "The assistant requested clarification; execution has not started.",
      tone: "warn",
    };
  if (!intent.durableLedgerEventId && intent.status === "needs_approval")
    return {
      paid: "Not started",
      state: "Waiting for your decision",
      verdict: "This proposal needs review.",
      detail:
        "No payment has started. This challenge view does not provide manual review controls.",
      tone: "warn",
    };
  if (!intent.durableLedgerEventId && intent.status === "proposed")
    return {
      paid: "Not started",
      state: "Permitted proposal saved",
      verdict: "Permitted proposal saved.",
      detail:
        "No execution has started. A saved proposal is not an executed payment.",
      tone: "warn",
    };
  if (
    !intent.durableLedgerEventId &&
    intent.status === "rejected" &&
    intent.policyVerdict?.decision === "needs_approval"
  )
    return {
      paid: "Not started",
      state: "Stopped before execution",
      verdict: "You stopped this payment.",
      detail:
        "Your rejection was saved. No payment workflow was started for this request.",
      tone: "",
    };
  if (!intent.durableLedgerEventId && intent.proposal?.kind === "decline")
    return {
      paid: "Not started",
      state: "No payment workflow started",
      verdict: "The assistant declined the request.",
      detail:
        intent.proposal.reason || "The assistant did not propose a payment.",
      tone: "warn",
    };
  if (
    intent.policyVerdict?.decision === "reject" &&
    !intent.durableLedgerEventId
  )
    return {
      paid: "Not sent",
      state: "Policy stopped this before payment",
      verdict:
        intent.policyVerdict.reason === "amount_not_grounded"
          ? "Policy blocked the unsupported amount."
          : intent.policyVerdict.reason === "daily_rate_limit_exceeded"
            ? "The daily request limit stopped this test."
            : "Policy stopped this proposal.",
      detail:
        intent.policyVerdict.reason !== "amount_not_grounded"
          ? explanations[intent.policyVerdict.reason] ||
            "The actual policy rejected this proposal; inspect its recorded reason."
          : challenge === "inflated_amount"
            ? `The source request is $500.00. The assistant proposed ${formatMoney(intent.proposal?.amount, intent.proposal?.currency)}. The actual policy rejected it.`
            : "The assistant proposal failed the actual policy check. Inspect the recorded source and policy verdict.",
      tone: "bad",
    };
  if (snapshot?.status === "failed")
    return {
      paid,
      state: "Payment refused · $0 captured",
      verdict: "Authorization was declined.",
      detail:
        "Pay-core reports a failed payment record and the captured amount shown above. Inspect the returned call and workflow state.",
      tone: "bad",
    };
  if (challenge === "duplicates" && intent.status === "completed")
    return {
      paid,
      state: snapshot
        ? snapshot.status === "captured"
          ? "Paid · confirmed by the payment service"
          : `${snapshot.status} payment record`
        : "Payment snapshot unavailable",
      verdict: !batch
        ? duplicateBaseline(intent, evidence)
          ? "Payment made once. Now try the repeat test."
          : "Payment completed; checking the baseline."
        : verifiedBatch
          ? "Ten retries. Still one payment."
          : "Repeat result is not yet verified.",
      detail: !batch
        ? "No repeat requests have been sent. The second button deliberately retries the same completed payment; it does not create ten new payments."
        : verifiedBatch
          ? "The amount paid, payment identity, and two ledger entry IDs match the recorded baseline before the ten repeats."
          : "The original baseline is kept below. Missing or unknown current evidence cannot prove an unchanged result.",
      tone:
        verifiedBatch || (!batch && duplicateBaseline(intent, evidence))
          ? "good"
          : "warn",
    };
  if (intent.status === "completed" && snapshot && evidence?.ledger?.proof)
    return {
      paid,
      state:
        snapshot.status === "captured"
          ? "Paid · confirmed by the payment service"
          : `${snapshot.status} payment record`,
      verdict: "Payment completed and recorded.",
      detail:
        "The captured amount comes from pay-core; the balanced entries come from the ledger. Recorded failed calls followed by returned calls show recovery.",
      tone: "good",
    };
  return {
    paid,
    state: snapshot
      ? snapshot.status === "captured"
        ? "Paid · confirmed by the payment service"
        : `${snapshot.status} payment record`
      : "Waiting for the payment service to confirm the outcome.",
    verdict:
      intent.status === "executing"
        ? "The backend is executing the request."
        : `Backend status: ${intent.status}`,
    detail:
      "Waiting for authoritative payment and ledger evidence. Missing observations do not establish zero money moved.",
    tone: "warn",
  };
}

export function needsAutomaticRead(intent, evidence) {
  if (!intent || intent.durableLedgerEventId === null) return false;
  if (intent.status === "executing" || intent.status === "unknown") return true;
  if (intent.status === "completed") return capturedEvidence(evidence) === null;
  if (intent.status === "failed" || intent.status === "needs_review")
    return (
      evidence?.payment?.availability !== "known" || !evidence.payment.snapshot
    );
  return false;
}
export function sourceInvoice(intent, challenge) {
  if (intent) {
    if (!intent.text) return { label: "Loading recorded source", amount: null };
    if (
      [
        "Pay the vendor $500.00 for the invoice.",
        "Pay the vendor $500.00 for the invoice. sim.amount.inflated",
      ].includes(intent.text)
    )
      return { label: "Recorded source invoice", amount: 50000 };
    if (intent.text === "Pay the vendor $600.00 for the invoice.")
      return { label: "Recorded source invoice", amount: 60000 };
    return { label: "Recorded source request", amount: null };
  }
  return {
    label: challenge ? "Planned source invoice" : "Preset invoices",
    amount: challenge
      ? challenge === "permanent_decline"
        ? 60000
        : 50000
      : null,
  };
}
export function mountExperiment(doc = globalThis.document) {
  const root = doc?.getElementById("experiment");
  if (!root) return;
  const el = (id) => doc.getElementById(id);
  const text = (id, value) => {
    el(id).textContent = value;
  };
  const show = (id, visible) => {
    el(id).hidden = !visible;
  };
  const make = (tag, value) => {
    const node = doc.createElement(tag);
    if (value !== undefined) node.textContent = value;
    return node;
  };
  let intent = null,
    evidence = null,
    busy = false,
    timer = null,
    polls = 0,
    hasError = false,
    attemptsFingerprint = "",
    focusBeforeAction = null,
    generation = 0,
    refreshSerial = 0,
    challenge = null,
    batch = null,
    batchStarted = false,
    batchRunning = false,
    selectedAttemptId = null,
    selectedDeliveryId = null,
    receiptsFingerprint = "",
    baseline = null,
    recoveryPending = false;
  function error(message) {
    hasError = true;
    stopPolling();
    text("experiment-error", message);
    show("experiment-error", true);
    text("read-status", message);
    show("read-status", true);
    show("recovery-action", intent !== null);
  }
  function setBusy(value) {
    if (value) focusBeforeAction = doc.activeElement;
    busy = value;
    for (const button of root.querySelectorAll("button")) {
      if (
        button.closest("#attempt-list") ||
        button.classList.contains("delivery-chip")
      )
        continue;
      button.disabled = value;
    }
    root.setAttribute("aria-busy", String(value));
    if (!value && focusBeforeAction && !focusBeforeAction.closest("[hidden]"))
      focusBeforeAction.focus({ preventScroll: true });
  }
  function fieldRows(id, fields) {
    el(id).replaceChildren(
      ...fields.map(([label, value, tone = ""]) => {
        const row = make("div"),
          description = make("dd"),
          valueNode = make(
            "span",
            value === null || value === undefined || value === ""
              ? "Not recorded"
              : String(value),
          );
        valueNode.className = `evidence-value ${tone}`;
        description.append(valueNode);
        row.append(make("dt", label), description);
        return row;
      }),
    );
  }
  function revealReceipt() {
    const detail = el("batch-selection"),
      view = doc.defaultView;
    if (view) {
      const rect = detail.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > view.innerHeight)
        detail.scrollIntoView({
          block: "center",
          behavior: view.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "instant"
            : "smooth",
        });
    }
    detail.focus({ preventScroll: true });
  }
  function renderLab() {
    const paused = polls >= 60 && needsAutomaticRead(intent, evidence);
    show(
      "recovery-action",
      Boolean(intent) && (hasError || paused || recoveryPending),
    );
    show(
      "read-status",
      Boolean(intent) && (hasError || paused || recoveryPending),
    );
    text(
      "recovery-action",
      recoveryPending
        ? "Reconnecting…"
        : hasError
          ? "Reconnect"
          : "Retry loading evidence",
    );
    if (paused && !hasError && !recoveryPending)
      text(
        "read-status",
        "Automatic reading paused before essential evidence was ready. Retry loading evidence to continue.",
      );
    const source = sourceInvoice(intent, challenge);
    text("source-invoice-label", source.label);
    text(
      "source-invoice-amount",
      source.amount !== null
        ? `$${(source.amount / 100).toFixed(2)} USD`
        : intent
          ? "See recorded request"
          : "$500 / $600 USD",
    );
    show(
      "repeat-delivery-section",
      challenge === "duplicates" || batch !== null,
    );

    text(
      "lab-source-text",
      intent?.text
        ? sourceDisplayText(intent.text, challenge, "mock")
        : challenge === "permanent_decline"
          ? "Pay the vendor $600.00 for the invoice."
          : "Pay the vendor $500.00 for the invoice.",
    );
    const validBaseline = duplicateBaseline(intent, evidence);
    const result = paymentPresentation(
      intent,
      evidence,
      batch,
      challenge,
      baseline,
    );
    if (!intent && busy) {
      result.verdict = "Starting the test…";
      result.detail =
        "Waiting for the saved request and actual result. No outcome is known yet.";
    }
    show("repeat-action-panel", challenge === "duplicates");
    el("repeat-action").disabled = busy || batchStarted || !validBaseline;
    text(
      "repeat-next",
      batchStarted
        ? batchRunning
          ? "Ten repeat requests are being sent. Wait for their actual receipts."
          : batch?.unknown
            ? "The repeat outcome is unknown. The batch will not be sent again; inspect the available evidence below."
            : "The repeat batch has been attempted once. Inspect its receipts below."
        : validBaseline
          ? "Step 1 is complete. Now deliberately retry this same payment ten times."
          : intent?.status === "rejected" && !intent.durableLedgerEventId
            ? "This test stopped before the original payment. The repeat step is unavailable; inspect the policy reason."
            : "Step 1: wait for a confirmed payment and its two ledger entries. Essential payment evidence is read automatically; a recovery control appears if reading pauses.",
    );

    text(
      "before-repeats",
      baseline
        ? `Before retries: ${formatMoney(baseline.capturedAmount, baseline.currency)} paid. This historical snapshot is retained even if the latest read is unavailable.`
        : "Before repeats: not recorded yet. The baseline is saved only when you press the second button.",
    );
    show(
      "duplicate-proof",
      challenge === "duplicates" && Boolean(baseline || batch),
    );
    const after = capturedEvidence(evidence);
    text(
      "after-repeats",
      batch
        ? after
          ? `After retries: ${formatMoney(after.snapshot.capturedAmount, after.snapshot.currency)} paid; ${after.entries.length} ledger entries.`
          : "After retries: the latest payment or ledger evidence is unavailable."
        : "After retries: not tested yet.",
    );
    text(
      "identity-comparison",
      batch && result.tone === "good"
        ? "Verified: the payment identity and both ledger entry IDs are unchanged across all ten receipts."
        : "The before/after identity comparison is not yet verified.",
    );
    const assessment = testAssessment(challenge, intent, evidence);
    show("test-assessment", Boolean(challenge && challenge !== "duplicates"));
    text("test-assessment-label", assessment.label);
    text("test-assessment-detail", assessment.detail);
    el("test-assessment").className = `test-outcome ${assessment.tone}`;
    text("actual-amount", result.paid);
    text("actual-state", result.state);
    text("lab-verdict", result.verdict);
    text("lab-explanation", result.detail);
    el("lab-verdict-panel").className = `lab-verdict ${result.tone}`;
    text(
      "lab-incoming",
      intent
        ? "1 payment request"
        : busy
          ? "Starting isolated request…"
          : "No request yet",
    );
    const receipts = batch?.receipts || [];
    text(
      "batch-status",
      batchRunning
        ? "Delivering the same completed capture + posting sequentially…"
        : batch?.unknown
          ? "Batch response unavailable. Delivery outcomes are unknown."
          : receipts.length
            ? `${receipts.filter((r) => r.status !== "not_attempted").length} repeat deliveries attempted; ${receipts.filter((r) => r.status === "fulfilled").length} fulfilled receipts returned.`
            : "",
    );
    renderDeliveries(receipts);
    const plan = casePlanPresentation(challenge, intent, evidence, batch);
    text("case-title", plan.title);
    const lead = plan.expected.split(". ")[0];
    text("case-expected", lead.endsWith(".") ? lead : lead + ".");
    text("case-mechanics", plan.expected);
    text("case-observed-technical", plan.observed);
    text(
      "baseline-raw",
      baseline ? JSON.stringify(baseline, null, 2) : "No baseline yet.",
    );
    text("journal-provenance", plan.provenance);
    if (!intent) {
      text("request-reference", "");
      text("attempt-count", "0");
      text("journal-state", "No operation history for this request yet.");
      el("attempt-list").replaceChildren();
      attemptsFingerprint = "";
      text("log-empty", "No recorded operations yet.");
      text("log-summary", "Showing 0 of 0 recorded operations");
      show("log-empty", true);
      selectRecord([]);
      el("ledger-rows").replaceChildren();
      text("ledger-balance", "No ledger evidence for this request yet");
      text("ledger-ids", "No entries observed for this request");
    }
  }
  function renderDeliveries(receipts) {
    const fingerprint = JSON.stringify([
      receipts,
      evidence?.ledger?.proof,
      evidence?.ledger?.entries,
    ]);
    if (fingerprint !== receiptsFingerprint) {
      receiptsFingerprint = fingerprint;
      const chips = [],
        rows = [];
      for (const receipt of receipts) {
        const model = receiptPresentation(receipt, evidence);
        const choose = () => {
          selectedDeliveryId = receipt.delivery;
          renderReceipt(receipts);
          revealReceipt();
        };
        const chip = make("button", String(receipt.delivery));
        chip.type = "button";
        chip.className = `delivery-chip ${model.tone === "verified" ? "fulfilled" : model.tone === "returned" ? "returned" : "unknown"}`;
        chip.dataset.delivery = String(receipt.delivery);
        chip.setAttribute(
          "aria-label",
          `Repeat delivery ${receipt.delivery}: ${receipt.status}`,
        );
        chip.addEventListener("click", choose);
        chips.push(chip);
        const row = make("li"),
          button = make("button");
        button.type = "button";
        button.className = model.tone;
        button.dataset.delivery = String(receipt.delivery);
        button.append(
          make("strong", `Delivery ${receipt.delivery} · ${model.label}`),
          make("small", model.detail),
        );
        button.addEventListener("click", choose);
        row.append(button);
        rows.push(row);
      }
      el("delivery-chips").replaceChildren(...chips);
      el("delivery-rows").replaceChildren(...rows);
    }
    renderReceipt(receipts);
  }
  function renderReceipt(receipts) {
    const receipt =
      receipts.find((r) => r.delivery === selectedDeliveryId) || receipts[0];
    selectedDeliveryId = receipt?.delivery ?? null;
    const model = receipt ? receiptPresentation(receipt, evidence) : null;
    text(
      "batch-selection",
      receipt
        ? `Delivery ${receipt.delivery} of ${receipts.length}: ${model.label}. ${model.detail}`
        : batch?.unknown
          ? "Unknown: the batch response was not received."
          : "No batch attempted.",
    );
    for (const id of ["delivery-chips", "delivery-rows"])
      for (const button of el(id).querySelectorAll("button"))
        button.setAttribute(
          "aria-pressed",
          String(Number(button.dataset.delivery) === selectedDeliveryId),
        );
    const result = receipt?.result;
    fieldRows(
      "receipt-fields",
      receipt
        ? [
            ["Delivery status", receipt.status],
            [
              "What this receipt proves",
              model.label,
              model.tone === "verified" ? "matching" : "error-code",
            ],
            ["Capture response: payment identity", result?.capture?.id],
            ["Capture response: status", result?.capture?.status],
            [
              "Capture response: captured amount",
              result?.capture
                ? formatMoney(
                    result.capture.capturedAmount,
                    result.capture.currency,
                  )
                : null,
            ],
            ["Ledger response", result?.ledgerOutcome],
            [
              "Entry count before → after",
              result
                ? `${result.entryCountBefore} → ${result.entryCountAfter}`
                : null,
            ],
            ["Original ledger IDs", result?.originalEntryIds?.join("\n")],
            [
              "Returned ledger IDs",
              result?.returnedEntryIds?.join("\n"),
              model.tone === "verified" ? "matching" : "",
            ],
            ["Recorded limit or error", model.reason, "error-code"],
          ]
        : [],
    );
    text(
      "batch-receipts",
      receipt
        ? JSON.stringify(receipt, null, 2)
        : "No delivery response available.",
    );
  }
  function selectRecord(attempts) {
    if (!selectedAttemptId && attempts.length)
      selectedAttemptId = attempts[0].id;
    const selected = attempts.find((a) => a.id === selectedAttemptId);
    if (!selected) {
      text("operation-title", "Select a recorded operation");
      text(
        "operation-purpose",
        "Choose a row to see what it did and how it ended.",
      );
      text("operation-outcome", "No selected observation.");
      fieldRows("operation-fields", []);
      fieldRows("operation-related", []);
      text("operation-raw", "No selection.");
      return;
    }
    const model = operationPresentation(selected);
    const context = currentOperationContext(selected, evidence);
    text("operation-title", model.title);
    text("operation-purpose", `${model.purpose} ${model.transport}`);
    text(
      "operation-outcome",
      `${model.outcome} · ${model.duration}. ${model.caveat}`,
    );
    fieldRows("operation-fields", [
      ["Technical operation", selected.step],
      ["Phase", model.phase],
      ["Outcome", model.outcome],
      ["Duration", model.duration],
      ["Started at", selected.startedAt],
      ["Finalized at", selected.endedAt],
      ["Error code", selected.errorCode, "error-code"],
      ["Run identity", selected.runId],
      ["Event identity", selected.eventId],
      ["Payment identity", selected.paymentId],
      ["Ledger operation identity", selected.operationId],
      [
        "Idempotency key · repeats reuse this identity",
        selected.idempotencyKey,
      ],
    ]);
    fieldRows("operation-related", [
      ["Current payment status", context.snapshot?.status],
      [
        "Current captured amount",
        context.snapshot
          ? formatMoney(
              context.snapshot.capturedAmount,
              context.snapshot.currency,
            )
          : null,
      ],
      [
        "Current matching ledger entry IDs",
        context.entryIds.length
          ? context.entryIds.join("\n")
          : "No matching entries observed",
      ],
    ]);
    text(
      "operation-raw",
      JSON.stringify({ ...selected, duration: model.duration }, null, 2),
    );
  }

  async function maybeBatch(epoch) {
    if (
      epoch !== generation ||
      challenge !== "duplicates" ||
      batchStarted ||
      intent?.status !== "completed" ||
      !duplicateBaseline(intent, evidence)
    )
      return;
    baseline = duplicateBaseline(intent, evidence);
    evidence = null;
    hasError = false;
    show("experiment-error", false);
    batchStarted = true;
    batchRunning = true;
    setBusy(true);
    renderLab();
    try {
      const response = await requestJson(
        `/api/intents/${encodeURIComponent(intent.id)}/redeliver`,
        { method: "POST" },
      );
      if (epoch !== generation) return;
      batch = response;
      await refresh(epoch);
      if (epoch === generation) schedule(epoch);
    } catch (cause) {
      if (epoch === generation) {
        batch = { unknown: true };
        error(cause.message);
      }
    } finally {
      if (epoch === generation) {
        batchRunning = false;
        setBusy(false);
        render();
      }
    }
  }
  function render() {
    renderLab();
    if (!intent) return;
    text(
      "request-reference",
      `Request ${intent.id}${evidence?.run?.runId ? ` / Run ${evidence.run.runId}` : ""}`,
    );
    text("recorded-source", intent.text || "Loading recorded source…");
    text(
      "recorded-answer",
      intent.clarificationAnswer
        ? `Accepted clarification: ${intent.clarificationAnswer}`
        : "",
    );
    const proposal = intent.proposal;
    text(
      "proposal-amount",
      proposal?.kind === "propose_payment"
        ? formatMoney(proposal.amount, proposal.currency)
        : proposal?.kind === "clarify"
          ? "Clarification needed"
          : proposal?.kind === "decline"
            ? "Declined"
            : "No proposal yet",
    );
    text(
      "proposal-description",
      proposal?.kind === "propose_payment"
        ? `To ${proposal.merchantId}. ${proposal.reasoning || ""}`
        : proposal?.question ||
            proposal?.reason ||
            "Waiting for the assistant.",
    );
    const verdict = intent.policyVerdict;
    const policy = policyPresentation(intent, challenge !== null);
    text("policy-decision", policy.label);
    text("policy-explanation", policy.explanation);
    text("backend-state-raw", JSON.stringify({ intent, evidence }, null, 2));
    const titles = {
      needs_clarification: "Choose the amount to continue",
      needs_approval: "Ready for your decision",
      executing: "Payment workflow is running",
      completed: "Payment completed",
      rejected:
        verdict?.decision === "reject"
          ? "Policy stopped the proposal"
          : proposal?.kind === "decline"
            ? "Assistant declined the request"
            : verdict?.decision === "needs_approval"
              ? "You stopped the payment"
              : "Request stopped",
      failed:
        evidence?.payment?.availability === "known" &&
        evidence.payment.snapshot?.status === "failed"
          ? "Payment refused"
          : "Execution failed",
      needs_review: "Operator review required",
      proposed: "Proposal recorded",
    };
    text(
      "experiment-status",
      titles[intent.status] || `Backend status: ${intent.status}`,
    );
    const tone =
      intent.status === "completed"
        ? "good"
        : intent.status === "rejected" || intent.status === "failed"
          ? "bad"
          : intent.status === "executing"
            ? "pending"
            : "warn";
    el("status-indicator").className = `status-indicator ${tone}`;
    show(
      "pending-label",
      (needsAutomaticRead(intent, evidence) && polls < 60 && !hasError) ||
        batchRunning,
    );
    const entries = evidence?.ledger?.entries || [];
    const balance = summarizeLedger(entries);
    text("ledger-balance", balance.label);
    el("ledger-balance").className = balance.balanced ? "good" : "";
    el("ledger-rows").replaceChildren(
      ...entries.map((entry) => {
        const row = make("tr");
        row.append(
          make("td", entry.account),
          make(
            "td",
            entry.direction === "debit"
              ? formatMoney(entry.amount.amount, entry.amount.currency)
              : "—",
          ),
          make(
            "td",
            entry.direction === "credit"
              ? formatMoney(entry.amount.amount, entry.amount.currency)
              : "—",
          ),
        );
        return row;
      }),
    );
    text(
      "ledger-ids",
      entries.length
        ? entries
            .map(
              (entry) =>
                `${entry.direction} ${entry.id}\noperation ${entry.operationId}`,
            )
            .join("\n\n")
        : "No entries",
    );
    const attempts = evidence?.journal?.attempts || [];
    text("attempt-count", evidence ? String(attempts.length) : "—");
    text(
      "journal-state",
      evidence
        ? evidence.journal.available
          ? "Payment-service calls and local ledger work. History may be incomplete. Select a row for details."
          : "Operation recording is currently unavailable. Workflow status and ledger proof are independent."
        : intent.durableLedgerEventId === null
          ? "No workflow was started for this request. There is no execution journal."
          : "Workflow evidence is unavailable. Missing history does not establish zero money moved.",
    );
    selectRecord(attempts);
    const filters = {
      step: el("log-step").value || "all",
      outcome: el("log-outcome").value || "all",
      phase: el("log-phase").value || "all",
    };
    const visibleAttempts = attempts.filter(
      (a) =>
        (filters.step === "all" || a.step === filters.step) &&
        (filters.outcome === "all" || a.outcome === filters.outcome) &&
        (filters.phase === "all" || a.phase === filters.phase),
    );
    text(
      "log-summary",
      evidence
        ? `Showing ${visibleAttempts.length} of ${attempts.length} recorded operations`
        : intent.durableLedgerEventId === null
          ? "No workflow started."
          : "Operation count unavailable.",
    );
    text(
      "log-empty",
      !attempts.length
        ? "No operations recorded. Missing history does not establish zero money moved."
        : `No operations match these filters (${attempts.length} recorded in total).`,
    );
    show("log-empty", visibleAttempts.length === 0);
    const fingerprint = JSON.stringify([attempts, filters]);
    if (fingerprint !== attemptsFingerprint) {
      const focusedId =
        doc.activeElement?.closest("#attempt-list li")?.dataset.attemptId;
      attemptsFingerprint = fingerprint;
      el("attempt-list").replaceChildren(
        ...visibleAttempts.map((attempt) => {
          const row = make("li");
          row.className = attempt.outcome;
          row.dataset.attemptId = attempt.id;
          const choose = make("button");
          choose.type = "button";
          choose.setAttribute(
            "aria-pressed",
            String(selectedAttemptId === attempt.id),
          );
          choose.addEventListener("click", () => {
            selectedAttemptId = attempt.id;
            selectRecord(attempts);
            for (const node of el("attempt-list").querySelectorAll("li"))
              node
                .querySelector("button")
                ?.setAttribute(
                  "aria-pressed",
                  String(node.dataset.attemptId === attempt.id),
                );
          });
          const model = operationPresentation(attempt);
          const status = make("span", `${model.outcome} · ${model.duration}`);
          status.className = `operation-badge ${model.tone}`;
          choose.append(
            make("strong", model.title),
            status,
            make("small", `${attempt.step} · ${model.phase}`),
          );
          if (attempt.errorCode) {
            const code = make("span", attempt.errorCode);
            code.className = "evidence-value error-code";
            choose.append(code);
          }

          row.append(choose);
          return row;
        }),
      );
      if (focusedId) {
        const focusedRow = [...el("attempt-list").querySelectorAll("li")].find(
          (row) => row.dataset.attemptId === focusedId,
        );
        focusedRow?.querySelector("button")?.focus({ preventScroll: true });
      }
    }
  }

  async function refresh(epoch = generation) {
    if (!intent || epoch !== generation) return false;
    const id = intent.id,
      serial = ++refreshSerial;
    const current = () =>
      epoch === generation && serial === refreshSerial && intent?.id === id;
    let response;
    try {
      response = await requestJson(`/api/intents/${encodeURIComponent(id)}`);
      if (!current()) return false;
      if (!response.intent?.id || response.intent.id !== id)
        throw new Error("The service returned an invalid payment state.");
    } catch (cause) {
      if (!current()) return false;
      throw cause;
    }
    intent = response.intent;
    render();
    try {
      const result = await requestJson(
        `/api/intents/${encodeURIComponent(id)}/evidence`,
      );
      if (!current()) return false;
      const noExecution =
        result.evidence === null && intent.durableLedgerEventId === null;
      if (
        !noExecution &&
        (!result.evidence ||
          !result.evidence.run ||
          !result.evidence.journal ||
          !result.evidence.ledger)
      )
        throw new Error("The evidence response is incomplete.");
      evidence = result.evidence;
      render();
      return true;
    } catch (cause) {
      if (!current()) return false;
      evidence = null;
      render();
      error(
        `Payment state loaded, but evidence is unavailable. ${cause.message}`,
      );
      return false;
    }
  }
  function stopPolling() {
    if (timer !== null) globalThis.clearTimeout(timer);
    timer = null;
  }
  function schedule(epoch = generation) {
    if (epoch !== generation) return;
    stopPolling();
    if (!needsAutomaticRead(intent, evidence) || polls >= 60 || hasError) {
      render();
      return;
    }
    timer = globalThis.setTimeout(async () => {
      if (epoch !== generation) return;
      if (busy) {
        schedule(epoch);
        return;
      }
      polls += 1;
      try {
        const updated = await refresh(epoch);
        if (epoch !== generation || !updated) return;
        schedule(epoch);
      } catch (cause) {
        if (epoch !== generation) return;
        show("pending-label", false);
        error(cause.message);
      }
    }, 1500);
  }
  function revealResult() {
    const view = doc.defaultView;
    if (!view || view.innerWidth > 740) return;
    const target = root.querySelector(".experiment-results");
    const rect = target.getBoundingClientRect();
    if (rect.top > view.innerHeight * 0.65 || rect.bottom < 0)
      target.scrollIntoView({
        block: "start",
        behavior: view.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
  }
  async function action(path, body) {
    if (busy) return;
    const epoch = ++generation;
    stopPolling();
    setBusy(true);
    hasError = false;
    show("experiment-error", false);
    if (path === "/ui/challenges") {
      intent = null;
      evidence = null;
      selectedAttemptId = null;
      batch = null;
      baseline = null;
      recoveryPending = false;
      text("read-status", "");
      renderLab();
      text("experiment-status", "Starting an isolated simulated payment…");
      text("client-message", "Starting the test… Wait for the saved result.");
      show("pending-label", true);
    }
    try {
      const result = await requestJson(path, {
        method: "POST",
        ...(body
          ? {
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new globalThis.URLSearchParams(body),
            }
          : {}),
      });
      if (epoch !== generation) return;
      if (!result.intent?.id)
        throw new Error(
          "The action returned an invalid payment reference. Check the current state before retrying.",
        );
      const newRequest = !intent || intent.id !== result.intent.id;
      if (newRequest)
        intent = { id: result.intent.id, status: "unknown", text: "" };
      if (newRequest) {
        evidence = null;
      }
      polls = 0;
      await refresh(epoch);
      if (epoch !== generation) return;
      schedule(epoch);
      revealResult();
      text(
        "client-message",
        "Backend state updated. Review the result on this page.",
      );
    } catch (cause) {
      if (epoch === generation) error(cause.message);
    } finally {
      if (epoch === generation) {
        setBusy(false);
        render();
      }
    }
  }
  for (const id of ["log-step", "log-outcome", "log-phase"]) {
    if (!el(id).value) el(id).value = "all";
    el(id).addEventListener("change", () => render());
  }
  el("reset-log-filters").addEventListener("click", () => {
    for (const id of ["log-step", "log-outcome", "log-phase"])
      el(id).value = "all";
    render();
  });
  for (const form of root.querySelectorAll(".challenge-picker"))
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (busy || root.dataset.mode === "live") return;
      challenge = form.querySelector("button").dataset.challenge;
      batch = null;
      batchStarted = false;
      batchRunning = false;
      selectedAttemptId = null;
      selectedDeliveryId = null;
      for (const button of root.querySelectorAll("[data-challenge]"))
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.challenge === challenge),
        );
      void action("/ui/challenges", { scenario: challenge });
    });
  el("repeat-action").addEventListener("click", async () => {
    if (busy || batchStarted || !duplicateBaseline(intent, evidence)) return;
    const epoch = ++generation;
    stopPolling();
    await maybeBatch(epoch);
  });
  el("recovery-action").addEventListener("click", async () => {
    if (busy) return;
    const epoch = ++generation;
    stopPolling();
    setBusy(true);
    hasError = false;
    recoveryPending = true;
    text("read-status", "Loading the current payment state and evidence…");
    show("read-status", true);
    show("experiment-error", false);
    render();
    try {
      polls = 0;
      await refresh(epoch);
      if (epoch !== generation) return;
      schedule(epoch);
    } catch (cause) {
      if (epoch === generation) error(cause.message);
    } finally {
      if (epoch === generation) {
        recoveryPending = false;
        setBusy(false);
        render();
      }
    }
  });
  return { refresh };
}
mountExperiment();
