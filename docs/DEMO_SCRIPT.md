# REGEN — 3-Minute Judge Demo Script

> **Duration**: approximately 3 minutes  
> **Audience**: IBM Bob 2.0 Hackathon judges  
> **Goal**: demonstrate the REGEN autonomous incident-response pipeline  
>
> Steps marked **[BLOCKED — MEMBER A DEMO SERVICE]** cannot currently execute
> because the demo service source files are pending Member A's implementation.
> Present those steps using code walkthroughs and the existing agent source.

---

## Stage 1 — Introduction (0:00–0:25)

**Script**:

> "Production incidents usually mean: wake up at 2 AM, hunt through logs, write a patch, hope it works, then spend an hour on the postmortem.
>
> REGEN automates the entire sequence — from raw alert to tested patch to incident report — in a single deterministic pipeline powered by five IBM Bob agents."

**Show**: Repository root. Point to `agents/`, `shared/types.ts`, `shared/constants.ts`.

> "Every agent communicates through frozen TypeScript contracts in `shared/types.ts`. No ad-hoc messaging, no magic strings."

---

## Stage 2 — The Seeded Incident (0:25–0:45)

**Script**:

> "Our target is a checkout microservice with a deliberately seeded defect.
> The cart's `convertVoucherDiscount()` function uses `Math.trunc()` instead of `Math.round()`
> when converting foreign-currency voucher discounts. For a 10 EUR voucher on a USD cart:
>
> `Math.trunc(10 × 1.08) = 10` — one dollar short.
>
> That 1 USD under-application inflates the grand total, the payment gateway rejects it,
> and 20% of checkout requests return HTTP 500."

**Show**: Open `demo_service/tests/regression/reproduce_incident.test.ts`.

> "Member B has already written the regression test in Phase 2 — you can see it directly asserts that `convertVoucherDiscount(10, 'EUR', 'USD')` must return `11`, not `10`."

**Note on current state**:

> [BLOCKED — MEMBER A DEMO SERVICE]
> The demo service itself (`demo_service/src/`) is a pending Member A deliverable.
> We cannot seed live HTTP 500 traffic today, but the regression test and the entire agent pipeline are fully implemented and compilable.

---

## Stage 3 — The Orchestrator (0:45–1:00)

**Script**:

> "When an `IncidentPayload` arrives, the Orchestrator drives a deterministic state machine."

**Show**: `agents/orchestrator.ts` — `runPipeline()` method.

> "The stages are typed constants: `MEMORY_LOOKUP → TRIAGING → DIAGNOSING → TREATING → VERIFYING → SCRIBING → RESOLVED`.
> Every transition is recorded in `PipelineState.history`.
>
> If the incident signature matches a past verified fix in immune memory, the pipeline short-circuits to `IMMUNE_RECOVERED` — no agents needed, under 2 seconds."

---

## Stage 4 — Triage Agent (1:00–1:20)

**Script**:

> "Triage receives the `IncidentPayload` and locates the root cause."

**Show**: `agents/triage/triage_agent.ts` — `ERROR_SIGNATURE_MAP` and `calculateBlastRadius()`.

> "It classifies `errorSignature` against known patterns. `DISCOUNT_PRECISION_ERROR` maps directly to `demo_service/src/services/cart.ts → convertVoucherDiscount()`.
>
> Blast radius is a weighted composite: severity contributes 35%, error rate 25%, affected users 20%, endpoint centrality 15%.
>
> For a HIGH-severity checkout failure at 20% error rate, affecting 20% of users: `blastRadiusScore = 0.75`.
> The output `TriageResult` contains the exact file, function, line range, and a markdown explanation."

---

## Stage 5 — Diagnostic Agent (1:20–1:35)

**Script**:

> "Diagnostic takes the triage findings and produces a deterministic failing test."

**Show**: `agents/diagnostic/diagnostic_agent.ts` — `buildReproductionScenario()`, then `demo_service/tests/regression/reproduce_incident.test.ts`.

> "The agent derives the reproduction: 10 EUR × 1.08 = 10.8 USD. `Math.trunc = 10`, `Math.round = 11`. It generates three test suites:
>
> - Direct unit test on `convertVoucherDiscount` — asserts the correct rounded value.
> - End-to-end test on `applyVoucherAndCalculateTotals` — asserts `grandTotal ≈ 130.90` not the inflated `132.00`.
> - Guard-rail test for same-currency vouchers — confirms no regression in the happy path.
>
> The test is already on disk. It will fail on the unfixed code and pass after Treatment patches it."

---

## Stage 6 — Treatment Agent + Confidence Scorer (1:35–1:55)

**Script**:

> "Treatment generates the minimal patch without touching any file."

**Show**: `agents/treatment/treatment_agent.ts` — `generatePatch()` and `computeConfidence()`.

> "The agent scans for `Math.trunc(` in the diagnosed line range and performs a one-token substitution.
> The output is a standard unified diff:"

**Show** (read aloud):

```diff
--- a/demo_service/src/services/cart.ts
+++ b/demo_service/src/services/cart.ts
@@ -75,7 +75,7 @@
   // BUG: Math.trunc truncates instead of rounding
-  return Math.trunc((discountAmount * rateFrom) / rateTo);
+  return Math.round((discountAmount * rateFrom) / rateTo);
```

> "Confidence is calculated from three factors:
> - Blast radius (weight 0.35): `1.0 - 0.75 = 0.25`
> - Test specificity (weight 0.40): the test calls the exact function, asserts integer equality, covers end-to-end, includes guard rail → `1.00`
> - Historical success (weight 0.25): `0.50` conservative — immune memory store is a pending Member A dependency
>
> Composite: `0.25×0.35 + 1.0×0.40 + 0.50×0.25 = 0.61`
>
> Once Member A implements the memory store with verified past fixes, that 0.25 factor rises, pushing confidence above the 0.80 auto-verification threshold."

---

## Stage 7 — Verification Agent (1:55–2:20)

**Script**:

> "Verification is the only agent that writes to disk."

**Show**: `agents/verification/verification_agent.ts` — `applyUnifiedDiff()` and the rollback logic.

> "It parses the target file from the diff's `+++ b/` header, verifies that context lines match before touching anything, then writes the patched content.
>
> It runs `npm run test:demo`. If both the regression test and the baseline unit tests pass, the patch is accepted. If either fails, the original content is restored byte-for-byte — the rollback is a single `fs.writeFileSync(originalContent)` call. No git operations needed.
>
> Today Verification reports `BLOCKED BY MEMBER A DEMO SERVICE` because `cart.ts` is a pending stub.
> The logic is fully implemented — it will execute correctly once Member A delivers the service."

**Current output** (read from code):

```
VerificationResult {
  status: 'failed',
  summary: 'BLOCKED BY MEMBER A DEMO SERVICE: cart.ts is a stub...',
  patchApplied: false,
  regressionTestPassed: false,
  totalTests: 0
}
```

---

## Stage 8 — Scribe Agent (2:20–2:35)

**Script**:

> "Scribe always runs, regardless of verification outcome, and documents exactly what happened."

**Show**: `agents/scribe/scribe_agent.ts` — `buildPostmortem()` and the `isResolved` / `isBlocked` branching.

> "It produces four outputs from the actual pipeline data:
>
> - An 8-section postmortem markdown saved to `docs/postmortems/`.
> - A conventional-commits PR title: `fix(pending)(cart): replace Math.trunc with Math.round in convertVoucherDiscount()`.
> - A structured PR body with the diff embedded.
> - A Slack notification: `⏳ PENDING (blocked on demo service)`.
>
> Critically — it never fabricates. If `patchApplied === false`, the postmortem says unresolved. The status icon changes from ✅ to ⏳ or ❌ based on actual `VerificationResult` fields."

---

## Stage 9 — Immune Memory Concept (2:35–2:50)

**Script**:

> "Once this incident is verified and resolved, REGEN's immune memory stores the signature and the verified patch.
>
> When the same error signature appears again — same checkout service, same currency precision failure — the orchestrator matches it with cosine similarity ≥ 0.85 and transitions directly to `IMMUNE_RECOVERED`, bypassing all five agents.
>
> The second occurrence resolves through the warm path rather than the cold agent pipeline. The infrastructure for this is in the shared contracts — `ImmuneMemoryEntry` with `signature`, `verifiedDiff`, `hitCount`, and `embeddings` — pending Member A's memory engine implementation."

---

## Stage 10 — Close (2:50–3:00)

**Script**:

> "REGEN demonstrates a complete autonomous incident-response loop:
>
> Raw alert → evidence-based triage → deterministic regression test → minimal patch → safe verification with rollback → honest incident documentation.
>
> Every step is typed, testable, and designed to fail safely rather than produce false confidence. The TypeScript build passes today with five implemented agents, frozen shared contracts, and a regression test that will confirm the fix the moment Member A's cart service goes live."

**Show**: `npm run build` passing cleanly.

---

## What Can Be Demonstrated Live Today

| Demo step | Status |
|---|---|
| Walk through `shared/types.ts` contracts | ✅ Fully demonstrable |
| Walk through `agents/orchestrator.ts` state machine | ✅ Fully demonstrable |
| Show `TriageAgent` error-signature classification | ✅ Fully demonstrable |
| Show `DiagnosticAgent` regression test generation | ✅ Fully demonstrable |
| Show `reproduce_incident.test.ts` on disk | ✅ Fully demonstrable |
| Show `TreatmentAgent` patch generation logic | ✅ Fully demonstrable |
| Show unified diff construction and confidence formula | ✅ Fully demonstrable |
| Show `VerificationAgent` patch/rollback logic | ✅ Fully demonstrable (code walkthrough) |
| Show `ScribeAgent` honest documentation logic | ✅ Fully demonstrable (code walkthrough) |
| Show `npm run build` passing | ✅ Fully demonstrable |
| Run `npm run seed:incident` → live 500 errors | ❌ BLOCKED — Member A demo service |
| Run `npm run test:demo` → regression test fails on unfixed code | ❌ BLOCKED — Member A demo service + jest |
| Full pipeline execution with patch accepted | ❌ BLOCKED — Member A demo service |
| Immune memory warm path recovery | ❌ BLOCKED — Member A memory engine |
| Real-time dashboard visualisation | ❌ BLOCKED — Member A dashboard |
