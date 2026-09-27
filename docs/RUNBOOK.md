# REGEN — Operator Runbook

> Practical guide for setting up, running, and troubleshooting the REGEN pipeline.

---

## Prerequisites

### Required software

| Tool | Version | Purpose |
|---|---|---|
| Node.js | ≥ 18 | Runtime for all agents and scripts |
| npm | ≥ 9 | Dependency management |
| TypeScript | ≥ 5.3 | Build toolchain (installed via devDependencies) |
| ts-node | ≥ 10.9 | Direct TypeScript execution |
| Git | any recent | Source control |

### Current Member A dependencies (not yet met)

The following are required for **runtime execution** but are currently pending Member A's implementation:

| Dependency | Why needed | Status |
|---|---|---|
| `demo_service/src/services/cart.ts` implemented | VerificationAgent can only apply a patch to a real source file | **BLOCKED** |
| `demo_service/tests/unit/cart.test.ts` implemented | Baseline test pass/fail requires a real test | **BLOCKED** |
| `jest` installed as devDependency | `npm run test:demo` requires Jest | **BLOCKED** |
| `memory/seed_memory.json` populated | Immune memory fast path | **BLOCKED** |
| `memory/store.ts` implemented | Immune memory lookup | **BLOCKED** |
| `dashboard/server.js` implemented | Real-time SSE visualisation | **BLOCKED** |

`npm run build` passes today. Runtime execution is **partially blocked** pending Member A.

---

## Setup

### 1. Clone and install

```bash
git clone <repo-url>
cd regen
npm install
```

### 2. Copy environment file

```bash
cp .env.example .env
```

Then edit `.env` and fill in any real values. The defaults in `.env.example` are safe for local development.

### 3. Build the project

```bash
npm run build
```

This runs `tsc --noEmit` and must complete with zero errors. Test files are excluded from the tsc compilation (configured in `tsconfig.json`).

---

## Environment Variables (`.env.example`)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Dashboard server port |
| `DEMO_SERVICE_PORT` | `3001` | Demo service HTTP port |
| `NODE_ENV` | `development` | Node environment |
| `IMMUNE_SIMILARITY_THRESHOLD` | `0.85` | Minimum cosine similarity for immune memory match |
| `IMMUNE_STORE_PATH` | `./memory/seed_memory.json` | Path to the memory store |
| `TREATMENT_MIN_CONFIDENCE` | `0.80` | Minimum confidence score to proceed to auto-verification |
| `PIPELINE_TIMEOUT_MS` | `90000` | Maximum pipeline wall time in milliseconds |
| `SLACK_WEBHOOK_URL` | mock value | Slack integration endpoint (mock in demo) |
| `GITHUB_REPO` | mock value | GitHub repository for PR generation |
| `IBM_BOB_API_KEY` | placeholder | IBM Bob IDE API credential — **never commit a real value** |

> ⚠️ **Never commit a real `IBM_BOB_API_KEY` or any credential to git.**
> `.env` is gitignored. `.bobignore` prevents Bob IDE session logging of credential patterns.

---

## Available Scripts (`package.json`)

All commands run from the repository root.

| Command | Purpose | Currently runnable |
|---|---|---|
| `npm run build` | TypeScript type-check (`tsc --noEmit`) | ✅ Yes |
| `npm run start:demo` | Start the demo checkout service | ❌ Blocked — Member A stub |
| `npm run start:dashboard` | Start the dashboard SSE server | ❌ Blocked — Member A stub |
| `npm run test:demo` | Run Jest tests for the demo service | ❌ Blocked — jest not installed, service stub |
| `npm run seed:incident` | Run the traffic-generator shell script | ❌ Blocked — Member A stub |
| `npm run run:pipeline` | Execute the full orchestrator pipeline | ⚠️ Partial — agents compile and run but Verification is blocked |

---

## Running the Pipeline

### When Member A's demo service is operational

```bash
# 1. Start the demo service (Member A's responsibility)
npm run start:demo

# 2. (Optional) Start the dashboard to watch pipeline stages
npm run start:dashboard

# 3. Seed the incident — sends test traffic that triggers the seeded 500 error
npm run seed:incident

# 4. Run the full REGEN pipeline against the incident
npm run run:pipeline
```

### What happens when the pipeline runs

1. **MEMORY_LOOKUP** — Orchestrator queries `memory/store.ts` for a matching past fix.
   - If `seed_memory.json` matches the incident signature: instant `IMMUNE_RECOVERED`.
   - Otherwise: proceeds to cold-path agents.

2. **TRIAGING** — `TriageAgent` analyses the `IncidentPayload`.
   - Classifies `errorSignature` against known patterns.
   - Falls back to stack-trace frame analysis if no direct match.
   - Returns `rootCauseFile`, `suspectFunction`, `lineRange`, `blastRadiusScore`.

3. **DIAGNOSING** — `DiagnosticAgent` produces the regression test.
   - Writes `demo_service/tests/regression/reproduce_incident.test.ts` to disk.
   - Returns `regressionTestPath`, `regressionTestCode`, `reproductionCommand`.

4. **TREATING** — `TreatmentAgent` generates the patch.
   - Reads `rootCauseFile` source.
   - Locates `Math.trunc(` in the diagnosed line range.
   - Emits unified diff (`Math.trunc` → `Math.round`).
   - Computes `confidenceScore` from blast radius, test specificity, historical success.
   - **Does NOT write to disk.**

5. **VERIFYING** — `VerificationAgent` applies the patch and runs tests.
   - Checks Member A readiness (cart.ts must be substantive, jest must be installed).
   - Parses target from diff `+++ b/` header.
   - Applies patch in-process, writes to disk.
   - Runs `npm run test:demo`.
   - Accepts (patch stays) if both regression and baseline tests pass.
   - Rolls back (restores original) if either test category fails.

6. **SCRIBING** — `ScribeAgent` generates incident documentation.
   - Always runs regardless of verification outcome.
   - Writes postmortem to `docs/postmortems/<incidentId>.md`.
   - Returns PR title/body and Slack notification text.

7. **RESOLVED** (or **FAILED** if any agent errored).

---

## Incident Workflow State Machine

```
IDLE
  └─ MEMORY_LOOKUP
       ├─ match → IMMUNE_RECOVERED
       └─ no match → TRIAGING
                      └─ DIAGNOSING
                           └─ TREATING
                                └─ VERIFYING
                                     ├─ pass → SCRIBING → RESOLVED
                                     └─ fail → SCRIBING → FAILED
```

On any unrecoverable agent failure, the orchestrator transitions to `FAILED` and records the error in `PipelineState.history`.

---

## Verification Behaviour

### Successful verification

Conditions: regression test PASS + all baseline tests PASS.

Result:
- `VerificationResult.patchApplied = true`
- `VerificationResult.regressionTestPassed = true`
- `VerificationResult.baselineUnitTestsPassed = true`
- Patch file remains on disk.

### Failed verification

Conditions: regression test FAIL or any baseline test FAIL.

Result:
- VerificationAgent restores the original file content (`fs.writeFileSync(original)`).
- `VerificationResult.patchApplied = false`
- ScribeAgent still runs and documents the failure.
- Pipeline transitions to `FAILED`.

### Blocked verification (current state)

Conditions: `cart.ts` is a stub OR `jest` is not installed.

Result:
- No patch is applied to disk.
- `VerificationResult.summary` contains `BLOCKED BY MEMBER A DEMO SERVICE`.
- `VerificationResult.patchApplied = false`
- `VerificationResult.totalTests = 0`

---

## Troubleshooting

### `npm run build` fails with TypeScript errors

```
error TS2306: File '...cart.ts' is not a module
```

**Cause**: The regression test file imports from `cart.ts`, which is a stub.

**Resolution**: This was addressed by adding `"**/*.test.ts"` to the `exclude` array in `tsconfig.json`. If this error reappears, verify `tsconfig.json` still contains the exclusion.

---

### `npm run test:demo` fails with "jest: command not found"

**Cause**: `jest` is not listed in `devDependencies` in the root `package.json` (it is a Member A dependency).

**Resolution**: Member A must add `jest`, `ts-jest`, and `@types/jest` to `devDependencies` and run `npm install`.

> Do NOT install jest yourself — this is Member A's responsibility per the project plan.

---

### Pipeline reaches VERIFYING but immediately returns BLOCKED

**Cause**: `VerificationAgent.checkMemberAReadiness()` detects that `demo_service/src/services/cart.ts` has fewer than 3 non-blank, non-comment lines.

**Resolution**: Member A must implement the cart service. Do not modify `demo_service/src/` yourself.

---

### TreatmentAgent returns `confidenceScore: 0.10`

**Cause**: `cart.ts` is a stub — Treatment detects this and caps confidence. The diff produced has `@@ -?? @@` placeholder line numbers and cannot be applied.

**Resolution**: Same as above — requires Member A's cart service implementation.

---

### Regression test imports fail at runtime

**Cause**: `demo_service/tests/regression/reproduce_incident.test.ts` imports from `../../src/services/cart` which is a stub module (exports nothing).

**Resolution**: Member A implements `cart.ts` with the correct exports (`convertVoucherDiscount`, `applyVoucherAndCalculateTotals`, `EXCHANGE_RATES`, `CartItem`, `VoucherCode`). The regression test is already correctly authored by Member B and will run once these exports exist.

---

### `memory/seed_memory.json` shows `historicalSuccessScore: 0.50`

**Cause**: The memory store is a stub. TreatmentAgent falls back to the conservative neutral score.

**Resolution**: Member A implements and populates `memory/seed_memory.json` with valid JSON entries. TreatmentAgent automatically detects valid JSON and queries it.

---

### Postmortem not written to disk

**Cause**: `docs/postmortems/` directory does not exist or is not writable.

**Resolution**: This is non-fatal — ScribeAgent catches the write error and still returns the `postmortemMarkdown` string in the result. The directory is created with `fs.mkdirSync(dir, { recursive: true })`. Verify filesystem permissions if needed.

---

## Bob Sessions Evidence

IBM Bob IDE session screenshots are stored in:

```
bob_sessions/member_a/   — Member A sessions (pending)
bob_sessions/member_b/   — Member B sessions (pending)
```

Expected evidence files per the project plan:

| File | Description | Status |
|---|---|---|
| `member_a/01_cart_bug_diagnosis.png` | Cart bug analysis + seed_incident.sh generation | Pending |
| `member_a/02_immune_memory_engine.png` | Immune memory store implementation | Pending |
| `member_b/01_triage_diagnostic_agents.png` | Triage & Diagnostic agent generation | Pending |
| `member_b/02_treatment_agent_patch.png` | Treatment agent + confidence scorer | Pending |
| `member_b/03_verification_scribe_agents.png` | Verification & Scribe agent generation | Pending |

> Screenshots must show the full IBM Bob IDE window (header bar + chat + editor + terminal).
> See `docs/TEAM_EXECUTION_GUIDE.md` for screenshot standards.
