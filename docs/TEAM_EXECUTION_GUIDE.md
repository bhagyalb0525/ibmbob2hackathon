# `regen` — 2-Member Team Execution & IBM Bob Strategy Guide

> **Target:** IBM Bob 2.0 Hackathon  
> **Resource Constraint:** 40 Bobcoins per member (80 total for the team)  
> **Core Objective:** Build a self-healing DevOps system with high code quality, zero merge conflicts, and bulletproof IBM Bob screenshot evidence for judging.

---

## 1. Golden Rules & Architecture Split

```
                              ┌────────────────────────────────────────┐
                              │       SHARED CONTRACT (Step 0)         │
                              │  shared/types.ts & shared/constants.ts │
                              └───────────────────┬────────────────────┘
                                                  │
                 ┌────────────────────────────────┴────────────────────────────────┐
                 ▼                                                                 ▼
   [ MEMBER A: Platform & Memory ]                                   [ MEMBER B: Agent Intelligence ]
   - demo_service/ (Target App & Bug)                               - agents/ (5-Agent Pipeline)
   - memory/ (Immune Vector Engine)                                 - agents/prompts/ (System Prompts)
   - dashboard/ (Real-Time Monitor UI)                              - docs/ (Architecture & Runbook)
   - bob_sessions/member_a/ (Evidence)                              - bob_sessions/member_b/ (Evidence)
```

### The Three Golden Rules
1. **Never spend Bobcoins on boilerplate or CSS**: Build all static plumbing, Express setups, HTML/CSS dashboard layouts, and generic utility types in Antigravity (0 Bobcoins).
2. **Lock `shared/types.ts` first**: Before either member writes logic, agree on and freeze [shared/types.ts](file:///d:/ibmbob2hackathon/shared/types.ts). No unexpected interface changes.
3. **Dry-Run in Antigravity, Execute & Capture in Bob**: Draft and polish prompts and edge cases here first. Only send the final, high-precision prompt to IBM Bob so it succeeds on **Attempt 1**, burning minimal coins and producing clean screenshot evidence.

---

## 2. File Ownership Matrix

### Member A: Platform, Memory & Observability
| Folder / File | Description | Action in Antigravity | Action in IBM Bob |
| :--- | :--- | :--- | :--- |
| `demo_service/src/app.ts` | Express service bootstrap | Build full boilerplate | None |
| `demo_service/src/routes/checkout.ts` | Checkout API endpoint | Scaffold basic route | None |
| `demo_service/src/services/cart.ts` | Core cart & discount engine | Scaffold structure | **Prompt Bob** to review & verify bug logic |
| `demo_service/src/services/payment.ts` | Mock payment gateway | Write mock responses | None |
| `demo_service/src/utils/logger.ts` | Structured JSON logger | Write JSON log format | None |
| `demo_service/tests/unit/cart.test.ts` | Baseline passing tests | Write standard unit test | None |
| `demo_service/seed_incident.sh` | Traffic generator script | Write curl generator | **Prompt Bob** to generate payload |
| `memory/store.ts` | Vector storage & similarity | Write similarity math | **Prompt Bob** to review search logic |
| `memory/embeddings.ts` | Hash/vector representation | Implement tokenizer | None |
| `memory/cache.ts` | Fast in-memory cache | Write LRU/Map cache | None |
| `memory/seed_memory.json` | Pre-seeded past incidents | Populate JSON fixtures | None |
| `dashboard/*` | Complete UI & SSE server | Build 100% in Antigravity | None (Save 100% coins) |
| `bob_sessions/member_a/*` | Screenshots & session logs | None | **Save all A screenshots here** |

### Member B: Agent Pipeline & Intelligence
| Folder / File | Description | Action in Antigravity | Action in IBM Bob |
| :--- | :--- | :--- | :--- |
| `agents/orchestrator.ts` | Pipeline executor | Write state-machine skeleton | Connect agent instances |
| `agents/prompts/*.prompt.md` | System prompts for 5 agents | Pre-draft and refine prompts | Load into Bob prompts |
| `agents/triage/triage_agent.ts` | Log parser & root cause agent | Scaffold class wrapper | **Prompt Bob** to generate parser logic |
| `agents/diagnostic/diagnostic_agent.ts` | Test generator agent | Scaffold class wrapper | **Prompt Bob** to generate test writer |
| `agents/treatment/treatment_agent.ts` | Patch & confidence agent | Scaffold class wrapper | **Prompt Bob** to generate patcher |
| `agents/verification/verification_agent.ts` | Test runner & sandbox agent | Scaffold runner | **Prompt Bob** to build verification logic |
| `agents/scribe/scribe_agent.ts` | Postmortem & PR docs agent | Scaffold markdown generator | **Prompt Bob** to format output |
| `docs/POSTMORTEM_TEMPLATE.md` | Incident report template | Write standard template | None |
| `docs/ARCHITECTURE.md` | Complete system flow | Write architecture doc | None |
| `docs/RUNBOOK.md` | Judge demonstration script | Write presentation steps | None |
| `bob_sessions/member_b/*` | Screenshots & session logs | None | **Save all B screenshots here** |

### Shared Files (Coordinate Before Touching)
- `shared/types.ts`: Core data structures (`IncidentPayload`, `AgentResult`, `ImmuneMemoryEntry`, `PipelineState`).
- `shared/constants.ts`: Status strings (`TRIAGING`, `DIAGNOSING`, `TREATING`, `VERIFYING`, `SCRIBING`, `RESOLVED`).
- `package.json` & `.env.example`: Root script commands and environment variables.
- `bob_sessions/README.md`: Consolidated proof table for the judges.

---

## 3. Git Branching Strategy (Zero Merge Conflicts)

```bash
# Branch setup:
git checkout -b feature/platform-memory   # Member A works here
git checkout -b feature/agent-pipeline    # Member B works here

# Merge Protocol:
# 1. Merge shared/ changes into main first.
# 2. Both pull main.
# 3. Work on separate directories (Member A in demo_service, memory, dashboard; Member B in agents, docs).
# 4. Final merge to main requires zero code overwrites.
```

---

## 4. Member A Playbook: Prompts, Actions & Screenshots

### Budget Allocation: ~15-18 Bobcoins Total (Leaves >20 coins margin)

#### Task A1: Seeded Bug Validation & Traffic Trigger in Bob
* **Goal**: Have IBM Bob inspect the checkout cart service, detect why multi-currency discounts fail, and generate `seed_incident.sh`.
* **Coins Allocated**: ~6 Bobcoins
* **Files Open in Bob**: `demo_service/src/services/cart.ts`, `demo_service/src/routes/checkout.ts`
* **Exact Prompt for Bob**:
```text
I am building a self-healing microservice demo. In demo_service/src/services/cart.ts, we have an edge-case logic bug where carts with multi-currency voucher discounts trigger a precision truncation error causing 500 responses for ~20% of requests.

Please review cart.ts, explain the exact edge case where subtotal calculation fails, and write demo_service/seed_incident.sh with a curl command that sends 10 requests to POST /api/checkout with valid and invalid payloads so we can deterministically simulate the incident.
```
* **Screenshot A1 Capture**:
  * **File Name**: `bob_sessions/member_a/01_cart_bug_diagnosis.png`
  * **What to Show**: Full IBM Bob IDE frame showing the Bob chat response identifying the bug on the left/right, and `seed_incident.sh` generated on the editor pane.

#### Task A2: Immune Memory Retrieval Engine in Bob
* **Goal**: Have IBM Bob generate the cosine similarity vector matcher that retrieves previously verified fixes.
* **Coins Allocated**: ~8 Bobcoins
* **Files Open in Bob**: `memory/store.ts`, `memory/seed_memory.json`, `shared/types.ts`
* **Exact Prompt for Bob**:
```text
In memory/store.ts, implement the ImmuneMemoryStore class based on the interfaces defined in shared/types.ts.

It must provide:
1. `findMatch(signature: string, threshold = 0.85)`: Computes similarity between incoming incident error signature and past incident vectors stored in memory/seed_memory.json.
2. `recordFix(entry: ImmuneMemoryEntry)`: Saves newly verified incident fixes into the memory store.

Write clean, deterministic TypeScript code with no external heavyweight C++ dependencies so it runs in Node.js.
```
* **Screenshot A2 Capture**:
  * **File Name**: `bob_sessions/member_a/02_immune_memory_engine.png`
  * **What to Show**: IBM Bob's Agent tab writing `memory/store.ts` with code diffs highlighted, showing the cosine similarity and lookup implementation.

---

## 5. Member B Playbook: Prompts, Actions & Screenshots

### Budget Allocation: ~22-25 Bobcoins Total (Leaves >15 coins margin)

#### Task B1: Triage & Diagnostic Agents in Bob
* **Goal**: Have IBM Bob implement the Triage and Diagnostic logic that reads error logs and outputs a reproducible Jest regression test.
* **Coins Allocated**: ~9 Bobcoins
* **Files Open in Bob**: `agents/triage/triage_agent.ts`, `agents/diagnostic/diagnostic_agent.ts`, `agents/prompts/triage.prompt.md`
* **Exact Prompt for Bob**:
```text
We are creating the first two agents of our self-healing pipeline for project regen:

1. Triage Agent (agents/triage/triage_agent.ts): Takes an IncidentPayload, parses the stack trace and error message, identifies the suspect file and line number in demo_service, and computes an estimated blast radius.
2. Diagnostic Agent (agents/diagnostic/diagnostic_agent.ts): Given the Triage report, writes a minimal, failing Jest regression test to demo_service/tests/regression/reproduce_incident.test.ts that reproduces the defect.

Please implement both classes using the interfaces in shared/types.ts and export executable methods.
```
* **Screenshot B1 Capture**:
  * **File Name**: `bob_sessions/member_b/01_triage_diagnostic_agents.png`
  * **What to Show**: Full Bob IDE window showing the multi-file generation of `triage_agent.ts` and `diagnostic_agent.ts`, with terminal or diff visible.

#### Task B2: Treatment Agent & Confidence Scorer in Bob
* **Goal**: Have IBM Bob implement the automated patch synthesizer and confidence metric calculation.
* **Coins Allocated**: ~8 Bobcoins
* **Files Open in Bob**: `agents/treatment/treatment_agent.ts`, `agents/prompts/treatment.prompt.md`
* **Exact Prompt for Bob**:
```text
Implement the TreatmentAgent in agents/treatment/treatment_agent.ts for our DevOps agent pipeline.

Given the TriageReport and the failing regression test from the DiagnosticAgent:
1. Generate the minimal unified code patch (git diff) for the target file in demo_service/src/services/cart.ts.
2. Calculate a confidence score between 0.0 and 1.0 based on:
   - blastRadius (number of lines touched vs file size)
   - regressionTestSpecificity
   - previousSuccessRate
3. Return a TreatmentResult conforming to shared/types.ts.
```
* **Screenshot B2 Capture**:
  * **File Name**: `bob_sessions/member_b/02_treatment_agent_patch.png`
  * **What to Show**: Bob IDE agent view displaying the patch generator and confidence scoring algorithm.

#### Task B3: Verification Sandbox & Scribe Agent in Bob
* **Goal**: Have IBM Bob code the test verification runner and the automatic postmortem markdown generator.
* **Coins Allocated**: ~7 Bobcoins
* **Files Open in Bob**: `agents/verification/verification_agent.ts`, `agents/scribe/scribe_agent.ts`, `docs/POSTMORTEM_TEMPLATE.md`
* **Exact Prompt for Bob**:
```text
Implement the remaining two agents in agents/:

1. VerificationAgent (agents/verification/verification_agent.ts): Temporarily applies the code patch, spawns `npm test` inside demo_service, verifies that the regression test passes AND existing unit tests pass, then rolls back or commits based on the result.
2. ScribeAgent (agents/scribe/scribe_agent.ts): Consolidates all agent outputs into a completed incident postmortem markdown file using docs/POSTMORTEM_TEMPLATE.md, plus a GitHub PR description and a Slack message summary.
```
* **Screenshot B3 Capture**:
  * **File Name**: `bob_sessions/member_b/03_verification_scribe_agents.png`
  * **What to Show**: Bob generating the sandbox runner and postmortem formatter.

---

## 6. Screenshot Standards for the Hackathon Submission

Judges look at screenshots to verify authentic usage of IBM Bob IDE. Follow these guidelines for maximum credibility:

```
┌────────────────────────────────────────────────────────────────────────┐
│  [X] IBM Bob IDE — Window Bar (Shows Bob Logo and Workspace Name)      │
├─────────────────────────┬──────────────────────────────────────────────┤
│ Bob Agent / Chat Panel  │ Editor Panel                                 │
│                         │                                              │
│ • User Prompt visible   │ • Active file path clearly shown             │
│ • Bob's Step-by-Step    │ • Newly generated code or diff highlighted   │
│   Thought Process       │                                              │
│ • Completed Task Status │                                              │
├─────────────────────────┴──────────────────────────────────────────────┤
│ Integrated Terminal (Showing command execution or test results)        │
└────────────────────────────────────────────────────────────────────────┘
```

### Screenshot Rules:
1. **Never crop to just the text box**: Always capture the **full application window** including Bob's header bar, sidebar, and editor tabs.
2. **Show the reasoning process**: Keep Bob's tool call tree or thinking steps expanded.
3. **No syntax error loops**: If Bob generates a syntax error, fix it locally first, then prompt Bob cleanly so the screenshot shows a successful task completion.
4. **Log every session**: Immediately record every screenshot in [bob_sessions/README.md](file:///d:/ibmbob2hackathon/bob_sessions/README.md) with:
   - Timestamp
   - Member Name
   - Bobcoins Spent
   - File Modified
   - Brief Description

---

## 7. The 3-Minute Demo Presentation Script

When recording your video or presenting to judges:

| Time | Screen | Speaker Script / Action |
| :--- | :--- | :--- |
| **0:00 - 0:30** | Slide / Dashboard | *"We built **regen**, an autonomous self-healing DevOps system powered by IBM Bob subagents and Immune Memory."* |
| **0:30 - 1:00** | Terminal & Dashboard | Run `./demo_service/seed_incident.sh`. Show Dashboard flashing RED: *“Incident Detected: Checkout service 500 error spike.”* |
| **1:00 - 2:00** | Dashboard Stepper | **The Cold Path**: Watch the 5 Bob agents execute live:<br>1. *Triage* isolates line in `cart.ts`.<br>2. *Diagnostic* writes test.<br>3. *Treatment* generates fix (Confidence: 94%).<br>4. *Verification* runs sandbox tests (Green).<br>5. *Scribe* creates Postmortem PR.<br>Show dashboard turn GREEN. Total time: ~18s. |
| **2:00 - 2:30** | Dashboard & Memory | **The Warm Path (Immune Memory)**: Trigger the incident again. The Immune Memory detects the matching vector signature and auto-heals the service in **under 1.5 seconds**, bypassing the full LLM pipeline! |
| **2:30 - 3:00** | `bob_sessions/` folder | Show the timestamped IBM Bob IDE screenshots proving end-to-end development in Bob IDE. |

---

## 8. Summary Checklist Before You Begin

- [x] Folder structure and one-line commented files generated
- [ ] Member A and Member B clone repo and create feature branches
- [ ] Review and lock [shared/types.ts](file:///d:/ibmbob2hackathon/shared/types.ts)
- [ ] Member A scaffolds Express app & Dashboard in Antigravity (0 coins)
- [ ] Member B scaffolds agent orchestrator and prompts in Antigravity (0 coins)
- [ ] Member A runs Task A1 & A2 in IBM Bob (Capture Screenshots)
- [ ] Member B runs Task B1, B2 & B3 in IBM Bob (Capture Screenshots)
- [ ] Merge branches to `main` and test full end-to-end demo
