
# REGEN: Incident Response and Self-Healing Software System

An autonomous, AI-driven incident response platform designed to detect, diagnose, repair, and learn from software failures in real time.

Built for IBM BOB 2.0 Hackathon

<p align="center">
  <img src="https://img.shields.io/badge/IBM-BOB%202.0-Hackathon-blue" alt="IBM BOB 2.0 Hackathon" />
  <img src="https://img.shields.io/badge/TypeScript-60%25-3178C6" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Node.js-Express-339933" alt="Node.js" />
  <img src="https://img.shields.io/badge/Self-Healing-AIOps-ff6b6b" alt="Self-Healing AIOps" />
</p>

## Overview

Modern software systems fail in unpredictable ways. Traditional incident response is still too slow, too manual, and too dependent on human intervention. In production, every minute lost during an outage increases cost, customer frustration, and business risk.

REGEN changes that.

REGEN is an intelligent incident-response and self-healing platform that mimics an immune system for software. It observes failures, classifies incidents, identifies root causes, patches the faulty logic, verifies the fix, and stores the verified resolution as reusable memory for future incidents.

This turns incident response from reactive firefighting into proactive autonomous healing.

---

## Why This Matters

In large-scale systems, incidents are no longer isolated events. They are recurring patterns. A service may fail once due to a compensation bug, a rounding mismatch, a state inconsistency, or a configuration drift — and then fail again in the same way.

The fundamental problem is:
- incidents are detected too late,
- root cause analysis is slow,
- fixes are often manual and fragile,
- and the same failures recur because previous fixes are not learned.

REGEN addresses this with:
- autonomous incident triage,
- root-cause diagnosis,
- safe patch generation,
- verification before deployment,
- and immune memory that learns from every verified fix.

---

## The Core Idea

REGEN creates a closed-loop healing cycle:

1. Detect incident
2. Triage and classify the failure
3. Diagnose the root cause
4. Generate a treatment
5. Apply the patch
6. Verify correctness with tests
7. Record the validated fix in memory
8. Reuse the fix automatically when a similar incident occurs again

This creates a real self-healing operational loop — not just an alerting system.

---

## Key Features

### 1. Autonomous Incident Triage
The system classifies failures based on error signature, stack traces, endpoint context, and service metadata.

### 2. Diagnostic Intelligence
The diagnostic agent narrows the issue to the suspected function, root cause file, and likely failure mode.

### 3. Treatment Engine
It proposes a targeted fix, generates a diff, and prepares the patch for safe application.

### 4. Verification Layer
Every fix is validated through regression checks and test execution before it is accepted.

### 5. Immune Memory
Once a fix is verified, REGEN stores it in an immune memory store. On future incidents with a similar signature, it reuses the proven patch instead of starting from scratch.

### 6. Live Monitoring Dashboard
A real-time dashboard streams pipeline state updates using SSE, visualizing:
- current stage,
- active agent,
- system progress,
- memory match status,
- and incident recovery state.

### 7. Hackathon-Ready Demo
The project includes a realistic demo checkout service that simulates production-like failure patterns, making the system easy to demonstrate and easy to understand.

---

## Architecture

REGEN is built as an agentic workflow with specialized stages.

```text
Incident Detection
        ↓
Memory Lookup / Immune Match
        ↓
Triage Agent
        ↓
Diagnostic Agent
        ↓
Treatment Agent
        ↓
Verification Agent
        ↓
Scribe Agent
        ↓
Resolved / Recovered
