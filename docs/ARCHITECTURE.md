# REGEN — Architecture Reference

> **REGEN** is an autonomous incident-response pipeline built for the IBM Bob 2.0 Hackathon.
> It accepts a structured incident payload and automatically triages, diagnoses, treats,
> verifies, and documents production failures with minimal human involvement.

---

## 1. System Purpose

Traditional incident response requires an on-call engineer to:

1. Read error alerts and locate the offending code.
2. Write a reproduction test.
3. Author a patch and assess its safety.
4. Run the test suite and decide whether to deploy.
5. Write a postmortem and PR description.

REGEN replaces steps 1–5 with a deterministic five-agent pipeline that runs
automatically from a single `IncidentPayload`. It also maintains an **Immune Memory**
of previously verified fixes, allowing recurring incidents to bypass the full pipeline
and recover in under two seconds.

---

## 2. High-Level Pipeline Flow

```
IncidentPayload
       │
       ▼
  Orchestrator ──── constructs PipelineState, drives stage transitions
       │
       ▼
 Memory Check ──── queries immune memory for matching past fix
       │
       ├── MATCH ──► IMMUNE_RECOVERED  (fast path, skips all agents)
       │
       └── NO MATCH
              │
              ▼
         TriageAgent ──── rootCauseFile, lineRange, blastRadiusScore
              │
              ▼
       DiagnosticAgent ──── regression test written to disk
              │
              ▼
       TreatmentAgent ──── unified diff + confidence score (patch NOT applied here)
              │
              ▼
     VerificationAgent ──── apply patch → run tests → accept OR rollback
              │
              ├── FAIL ──► patch rolled back, patchApplied = false
              │
              └── PASS ──► patch stays on disk, patchApplied = true
                     │
                     ▼
             ScribeAgent ──── postmortem, PR description, Slack summary
                     │
                     ▼
               RESOLVED
```

### Stage constants (`shared/constants.ts`)

| Constant | Value | Meaning |
|---|---|---|
| `IDLE` | `'IDLE'` | Pipeline not yet started |
| `MEMORY_LOOKUP` | `'MEMORY_LOOKUP'` | Querying immune memory |
| `TRIAGING` | `'TRIAGING'` | TriageAgent running |
| `DIAGNOSING` | `'DIAGNOSING'` | DiagnosticAgent running |
| `TREATING` | `'TREATING'` | TreatmentAgent running |
| `VERIFYING` | `'VERIFYING'` | VerificationAgent running |
| `SCRIBING` | `'SCRIBING'` | ScribeAgent running |
| `RESOLVED` | `'RESOLVED'` | Pipeline completed successfully |
| `IMMUNE_RECOVERED` | `'IMMUNE_RECOVERED'` | Resolved via fast path |
| `FAILED` | `'FAILED'` | Unrecoverable pipeline error |

---

## 3. Shared Contracts (`shared/types.ts`, `shared/constants.ts`)

All inter-agent communication uses frozen TypeScript interfaces.
**Do not modify these without alignment between both team members.**

### `IncidentPayload`

The trigger for the entire pipeline. Contains:

| Field | Type | Purpose |
|---|---|---|
| `incidentId` | `string` | Unique incident identifier |
| `timestamp` | `string` | ISO-8601 detection time |
| `serviceName` | `string` | Owning service name |
| `environment` | `'production' \| 'staging' \| 'demo'` | Deployment tier |
| `severity` | `IncidentSeverity` | `LOW/MEDIUM/HIGH/CRITICAL` |
| `endpoint` | `string` | Failing HTTP endpoint |
| `httpStatus` | `number` | HTTP response code |
| `errorSignature` | `string` | Normalised error hash for memory lookup |
| `errorMessage` | `string` | Human-readable error text |
| `stackTrace` | `string` | Node.js-format stack trace |
| `culpritPayload` | `Record<string, unknown>?` | Triggering request body |
| `recentCommits` | `Array<{hash, author, message, timestamp}>?` | Git history |
| `metrics` | `IncidentMetrics` | Error rate, affected users, latency |

### `BaseAgentResult` (extended by all agents)

| Field | Type | Purpose |
|---|---|---|
| `agentName` | `AgentName` | Identifies the agent |
| `status` | `'idle' \| 'running' \| 'success' \| 'failed' \| 'skipped'` | Execution outcome |
| `startedAt` | `string` | ISO-8601 start time |
| `completedAt` | `string` | ISO-8601 end time |
| `durationMs` | `number` | Wall-clock duration |
| `summary` | `string` | One-line human-readable result |
| `error` | `string?` | Error message if `status === 'failed'` |

### `TriageResult`

Extends `BaseAgentResult`. Adds:
`rootCauseFile`, `suspectFunction`, `lineStart`, `lineEnd`, `blastRadiusScore` (0–1), `culpritCommit?`, `explanation`

### `DiagnosticResult`

Extends `BaseAgentResult`. Adds:
`regressionTestPath`, `regressionTestCode`, `reproductionCommand`, `reproductionConfirmed`

### `TreatmentResult`

Extends `BaseAgentResult`. Adds:
`targetFile`, `gitDiff`, `patchedCode`, `confidenceScore` (0–1), `scoreBreakdown`, `explanation`

`scoreBreakdown` (`ConfidenceScoreBreakdown`) contains three sub-scores with declared weights:

| Sub-score | Weight | Source |
|---|---|---|
| `blastRadiusScore` | 0.35 | From TriageResult (inverted: lower blast = higher confidence) |
| `testSpecificityScore` | 0.40 | Heuristic evaluation of regression test coverage |
| `historicalSuccessScore` | 0.25 | Immune memory lookup (0.50 conservative when memory unavailable) |

### `VerificationResult`

Extends `BaseAgentResult`. Adds:
`totalTests`, `passedTests`, `failedTests`, `regressionTestPassed`, `baselineUnitTestsPassed`, `suiteOutput`, `patchApplied`

### `ScribeResult`

Extends `BaseAgentResult`. Adds:
`postmortemMarkdown`, `prTitle`, `prBody`, `slackNotificationText`, `postmortemFilePath?`

### `PipelineState`

The single mutable state object owned by the Orchestrator throughout a run:

```typescript
{
  incidentId: string;
  stage: PipelineStage;
  activeAgent?: AgentName;
  startTime: string;
  lastUpdated: string;
  isImmuneMatch: boolean;
  memoryLatencyMs?: number;
  totalDurationMs?: number;
  incident?: IncidentPayload;
  results: {
    triage?: TriageResult;
    diagnostic?: DiagnosticResult;
    treatment?: TreatmentResult;
    verification?: VerificationResult;
    scribe?: ScribeResult;
  };
  history: PipelineHistoryStep[];
}
```

### `ImmuneMemoryEntry`

Represents a stored, verified fix in the immune memory store:

| Field | Purpose |
|---|---|
| `signature` | Normalised error signature (vector key) |
| `verifiedDiff` | The tested and approved patch diff |
| `confidence` | Confidence at time of storage |
| `hitCount` | Number of times this fix has been reused |
| `embeddings?` | Float vector for cosine-similarity matching |

### Key thresholds (`shared/constants.ts`)

| Constant | Value | Meaning |
|---|---|---|
| `IMMUNE_SIMILARITY_THRESHOLD` | `0.85` | Minimum cosine similarity for immune memory match |
| `TREATMENT_MIN_CONFIDENCE` | `0.80` | Minimum confidence to proceed to auto-verification |
| `PIPELINE_TIMEOUT_MS` | `90000` | Maximum pipeline wall time (90 s) |

---

## 4. Agent Responsibilities

### 4.1 `TriageAgent` (`agents/triage/triage_agent.ts`)

**Input**: `IncidentPayload`

**Processing**:
1. Classifies `errorSignature` / `errorMessage` against known patterns (`DISCOUNT_PRECISION_ERROR`, `PAYMENT_MISMATCH_ERROR`, `CART_CALCULATION_ERROR`).
2. Falls back to parsing the `stackTrace` for the highest-priority application frame.
3. Reads the target source file to determine exact function line ranges via brace-depth counting.
4. Calculates `blastRadiusScore` as a weighted sum of severity (0.35), error rate (0.25), affected users (0.20), and endpoint centrality (0.15).

**Output**: `TriageResult` — `rootCauseFile`, `suspectFunction`, `lineStart`, `lineEnd`, `blastRadiusScore`, `explanation`

**Pipeline role**: First analysis stage. Provides location evidence used by all subsequent agents.

---

### 4.2 `DiagnosticAgent` (`agents/diagnostic/diagnostic_agent.ts`)

**Input**: `IncidentPayload` + `TriageResult`

**Processing**:
1. Derives a concrete reproduction scenario from the triage evidence (e.g. 10 EUR voucher → USD cart, `Math.trunc(10.8) = 10` vs correct `Math.round(10.8) = 11`).
2. Generates the full TypeScript Jest regression test source.
3. Writes the file to `demo_service/tests/regression/reproduce_incident.test.ts`.
4. Sets `reproductionConfirmed: false` — actual execution confirmation belongs to VerificationAgent.

**Output**: `DiagnosticResult` — `regressionTestPath`, `regressionTestCode`, `reproductionCommand`, `reproductionConfirmed`

**Pipeline role**: Evidence amplification. Produces the test that proves the defect and later proves the fix.

---

### 4.3 `TreatmentAgent` (`agents/treatment/treatment_agent.ts`)

**Input**: `IncidentPayload` + `TriageResult` + `DiagnosticResult`

**Processing**:
1. Reads the actual source file at `triage.rootCauseFile` from disk.
2. Locates `Math.trunc(` within the diagnosed line range.
3. Performs a one-token replacement: `Math.trunc(` → `Math.round(`.
4. Builds a standard 7-line unified diff with 3 lines of context using the `@@ -N,M +N,M @@` format.
5. Computes a deterministic `confidenceScore` from three factors (blast radius, test specificity, historical success).
6. **Does NOT write the patch to disk.** Returns the diff as a string.

**Stub behaviour**: When `cart.ts` is a stub, emits a canonical diff description with `@@ -?? @@` placeholder line numbers and caps `confidenceScore` at 0.10.

**Output**: `TreatmentResult` — `targetFile`, `gitDiff`, `patchedCode`, `confidenceScore`, `scoreBreakdown`, `explanation`

**Pipeline role**: Patch synthesis. Purely functional — no side effects on the file system.

---

### 4.4 `VerificationAgent` (`agents/verification/verification_agent.ts`)

**Input**: `TreatmentResult` (+ optional `IncidentPayload`, `TriageResult`, `DiagnosticResult`)

**Processing**:
1. Checks Member A readiness: `cart.ts` must be substantive and `jest` must be installed.
2. Parses the target file from `TreatmentResult.gitDiff` (`+++ b/path` header).
3. Rejects stub canonical diffs (`@@ -?? @@`).
4. Applies the unified diff in-process: verifies context lines match, builds new line array.
5. Writes patched content to disk.
6. Runs `npm run test:demo` via `child_process.spawnSync`.
7. Parses Jest output for `Tests: N failed, M passed, K total` and `PASS/FAIL <file>` lines.
8. **Accepts** if both regression test and baseline tests pass → patch stays on disk.
9. **Rolls back** (restores original content via `fs.writeFileSync`) if either test category fails.

**Output**: `VerificationResult` — all fields from actual test execution, never fabricated

**Pipeline role**: Gatekeeper. The only agent that writes a patch to disk and the only one that can trigger rollback.

---

### 4.5 `ScribeAgent` (`agents/scribe/scribe_agent.ts`)

**Input**: `IncidentPayload` + `TriageResult` + `DiagnosticResult` + `TreatmentResult` + `VerificationResult`

**Processing**:
1. Builds an 8-section postmortem markdown document from actual pipeline data.
2. Generates a conventional-commits-style PR title.
3. Generates a structured PR body (problem / root cause / reproduction / treatment / verification).
4. Generates a concise Slack notification.
5. Writes postmortem to `docs/postmortems/<incidentId>.md` (best-effort, non-fatal).
6. Accurately reflects the verification outcome — does not claim resolution unless `patchApplied && regressionTestPassed`.

**Output**: `ScribeResult` — `postmortemMarkdown`, `prTitle`, `prBody`, `slackNotificationText`, `postmortemFilePath`

**Pipeline role**: Incident closure documentation. Always produces output regardless of pipeline outcome.

---

## 5. Immune Memory Subsystem (`memory/`)

### Design

The immune memory engine is designed to provide a **fast path** for recurring incidents. When an incoming incident's `errorSignature` matches a stored `ImmuneMemoryEntry` with cosine similarity ≥ `IMMUNE_SIMILARITY_THRESHOLD` (0.85), the orchestrator skips the full agent pipeline and applies the stored verified patch directly.

### Files

| File | Purpose | Status |
|---|---|---|
| `memory/store.ts` | Vector database adapter — similarity search + persistence | **Stub — Member A dependency** |
| `memory/embeddings.ts` | Embedding generator for error logs and stack traces | **Stub — Member A dependency** |
| `memory/cache.ts` | Fast in-memory LRU/Map cache for immediate fingerprint hits | **Stub — Member A dependency** |
| `memory/seed_memory.json` | Pre-seeded historical incidents and verified patches | **Stub — Member A dependency** |

### Current implementation status

> ⚠️ **BLOCKED — MEMBER A DEPENDENCY**
>
> The entire immune memory subsystem is a Member A responsibility. All four files are currently single-line comment stubs. The orchestrator's `runMemoryCheck()` returns `false` unconditionally (placeholder). No immune memory functionality is operational until Member A implements these files.

### Impact on confidence scoring

When `memory/seed_memory.json` cannot be parsed as JSON, `TreatmentAgent` applies a conservative `historicalSuccessScore` of **0.50** and explicitly notes the limitation in the explanation.

---

## 6. Demo Service (`demo_service/`)

### Purpose

`demo_service/` is a Node.js/Express checkout microservice containing a deliberately seeded defect in its cart discount logic. It exists to provide a realistic incident target for the REGEN pipeline.

### Seeded defect

The defect is a precision bug in `demo_service/src/services/cart.ts` inside `convertVoucherDiscount()`:

```typescript
// BUG — should be Math.round, not Math.trunc
return Math.trunc((discountAmount * rateFrom) / rateTo);
```

For exchange rates that produce fractional results (e.g. 10 EUR × 1.08 = 10.8 USD), `Math.trunc` returns `10` instead of the correct `11`. The under-applied discount inflates `grandTotal`, which the payment gateway rejects with a `PAYMENT_MISMATCH_ERROR` / HTTP 500.

### Files

| File | Purpose | Status |
|---|---|---|
| `demo_service/src/services/cart.ts` | Cart totals, voucher discount, currency conversion | **Stub — Member A dependency** |
| `demo_service/src/services/payment.ts` | Mock payment gateway charge authorization | **Stub — Member A dependency** |
| `demo_service/src/routes/checkout.ts` | Checkout API endpoint | **Stub — Member A dependency** |
| `demo_service/src/utils/logger.ts` | Structured JSON logger | **Stub — Member A dependency** |
| `demo_service/src/app.ts` | Express app bootstrap | **Stub — Member A dependency** |
| `demo_service/tests/unit/cart.test.ts` | Baseline unit tests (happy path) | **Stub — Member A dependency** |
| `demo_service/tests/regression/reproduce_incident.test.ts` | Failing regression test | **Implemented by Member B (Phase 2)** |
| `demo_service/seed_incident.sh` | Traffic generator / curl script | **Stub — Member A dependency** |

> ⚠️ **BLOCKED — MEMBER A DEPENDENCY**
>
> All `demo_service/src/` files and the baseline unit test are currently placeholder stubs.
> The full runtime path (seed incident → service 500 → pipeline → patch → tests pass) is blocked
> until Member A implements these files.

---

## 7. Verification and Rollback

```
VerificationAgent.run(treatment)
        │
        ├── checkMemberAReadiness()
        │     ├── cart.ts is a stub? → BLOCKED BY MEMBER A
        │     └── jest not installed? → BLOCKED BY MEMBER A
        │
        ├── parseTargetFromDiff(gitDiff)
        │     └── no +++ b/ header? → error, no patch applied
        │
        ├── gitDiff contains '@@ -?? '? → BLOCKED (stub canonical diff)
        │
        ├── applyUnifiedDiff(targetPath, gitDiff)
        │     └── context mismatch? → error, no patch applied
        │
        ├── fs.writeFileSync(targetPath, patchedContent)   ← patch on disk
        │
        ├── runTests()  →  npm run test:demo
        │
        ├── regressionPassed && baselinePassed?
        │     ├── YES → patchApplied = true, return VerificationResult(success)
        │     └── NO  → fs.writeFileSync(targetPath, originalContent)  ← ROLLBACK
        │               patchApplied = false, return VerificationResult(failed)
        │
        └── (ScribeAgent always runs regardless of verification outcome)
```

The rollback is performed by restoring `originalContent` (the pre-patch file bytes read before the `writeFileSync` call) to disk. No git operations are required.

---

## 8. Scribe Outputs

| Output | Purpose | File |
|---|---|---|
| `postmortemMarkdown` | 8-section incident postmortem including timeline, root cause, patch, test results | Written to `docs/postmortems/<incidentId>.md` |
| `prTitle` | Conventional-commits PR title (`fix(cart): replace Math.trunc...`) | Used in PR creation |
| `prBody` | Full PR description — problem, root cause, reproduction, treatment diff, verification results | Used in PR creation |
| `slackNotificationText` | Concise operational summary with status icon (✅/⏳/❌) | Posted to Slack webhook |

The Scribe explicitly marks unresolved or blocked outcomes. It never claims "resolved" when `patchApplied === false`.

---

## 9. Dashboard (`dashboard/`)

The dashboard is a Member A deliverable providing a real-time browser UI that visualises pipeline stage transitions via Server-Sent Events (SSE).

| File | Purpose | Status |
|---|---|---|
| `dashboard/server.js` | SSE broker relaying orchestrator stage updates | **Stub — Member A dependency** |
| `dashboard/index.html` | Browser UI entry point | Member A deliverable |
| `dashboard/src/` | Dashboard frontend source | Member A deliverable |

> ⚠️ The Orchestrator's `emitStateUpdate()` method is currently a `console.log` placeholder. Full SSE emission to the dashboard requires Member A's server.js implementation.

---

## 10. Security and Safety Boundaries

The following safeguards are implemented in the actual codebase:

1. **No git operations** — The VerificationAgent applies and rolls back patches via direct `fs.readFileSync` / `fs.writeFileSync`. It never calls `git apply`, `git commit`, or `git reset`.
2. **Patch verification before application** — Context lines from the unified diff are matched against the actual file content before any write occurs. A mismatch returns an error without touching the file.
3. **Rollback on any test failure** — The original file content is always preserved in memory before patching. Any failure (test failure, runner error, exception) triggers restoration.
4. **No credential exposure** — `.env` is gitignored. `.bobignore` prevents Bob IDE from logging credential patterns. `IBM_BOB_API_KEY` and all secret fields are excluded from session logs.
5. **Scribe honesty constraint** — The ScribeAgent has explicit branching logic to distinguish resolved / blocked / failed outcomes. It does not claim deployment or test success unless `VerificationResult.patchApplied === true`.
6. **Conservative confidence scoring** — When immune memory is unavailable, the TreatmentAgent uses a neutral 0.50 for `historicalSuccessScore` rather than inflating confidence.
7. **Stub detection** — Both TreatmentAgent and VerificationAgent detect stub source files (≤3 non-blank, non-comment lines) and fail safely rather than applying malformed patches.

---

## 11. Repository Structure

```
regen/
├── shared/
│   ├── types.ts          ← frozen shared interfaces
│   └── constants.ts      ← frozen shared constants
│
├── agents/
│   ├── orchestrator.ts   ← pipeline state machine (Phase 1)
│   ├── triage/           ← TriageAgent (Phase 2)
│   ├── diagnostic/       ← DiagnosticAgent (Phase 2)
│   ├── treatment/        ← TreatmentAgent (Phase 3)
│   ├── verification/     ← VerificationAgent (Phase 4)
│   ├── scribe/           ← ScribeAgent (Phase 4)
│   └── prompts/          ← system prompts for each agent
│
├── demo_service/         ← Member A: seeded checkout microservice
│   ├── src/              ← STUB — pending Member A
│   └── tests/
│       ├── unit/         ← STUB — pending Member A
│       └── regression/   ← reproduce_incident.test.ts (Member B, Phase 2)
│
├── memory/               ← Member A: immune memory engine (all stubs)
├── dashboard/            ← Member A: real-time browser UI (stubs)
│
├── docs/
│   ├── ARCHITECTURE.md           ← this document
│   ├── RUNBOOK.md                ← operator guide
│   ├── DEMO_SCRIPT.md            ← judge-facing demo
│   ├── POSTMORTEM_TEMPLATE.md    ← Scribe template
│   └── postmortems/              ← auto-generated postmortems
│
├── bob_sessions/         ← IBM Bob IDE screenshot evidence
├── package.json
└── tsconfig.json
```
