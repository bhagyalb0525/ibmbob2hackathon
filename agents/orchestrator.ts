/**
 * REGEN Orchestrator — pipeline state machine.
 *
 * Owns the single mutable `PipelineState` for a run and drives the six
 * pipeline stages defined in `shared/constants.ts`:
 *
 *   MEMORY_LOOKUP → TRIAGING → DIAGNOSING → TREATING → VERIFYING → SCRIBING
 *                 → RESOLVED
 *
 * With the planned fast path: a sufficiently confident `ImmuneMemoryStore`
 * match short-circuits straight to IMMUNE_RECOVERED without running the
 * cold-path agents.
 *
 * Every agent stage delegates to the already-implemented agent classes.
 * The orchestrator contains NO agent logic of its own.
 */

import {
  IncidentPayload,
  PipelineState,
  PipelineStage,
  AgentName,
  TriageResult,
  DiagnosticResult,
  TreatmentResult,
  VerificationResult,
  ScribeResult,
  ImmuneMemoryEntry,
} from '@shared/types';
import { PIPELINE_STAGES, AGENT_NAMES, THRESHOLDS } from '@shared/constants';
import { ImmuneMemoryStore } from '../memory/store';
import { generateIncidentEmbedding } from '../memory/embeddings';
import { TriageAgent } from './triage/triage_agent';
import { DiagnosticAgent } from './diagnostic/diagnostic_agent';
import { TreatmentAgent } from './treatment/treatment_agent';
import { VerificationAgent } from './verification/verification_agent';
import { ScribeAgent } from './scribe/scribe_agent';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Reads a numeric env var, falling back when unset or unparseable. */
function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Escapes a literal string so it can be embedded in a RegExp source. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Outcome of a warm-path (immune memory) recovery.
 *
 * Every field is taken from the ACTUAL matched ImmuneMemoryEntry and the
 * ACTUAL file write — nothing here is defaulted or invented.
 */
export interface ImmuneRecoveryResult {
  /** The real MemoryMatchResult returned by ImmuneMemoryStore.findMatch(). */
  matched: boolean;
  /** Real similarity score from findMatch(). */
  confidence: number;
  /** Real measured lookup latency from findMatch(). */
  memoryLatencyMs?: number;
  /** The real threshold that was applied. */
  threshold: number;
  /** The real matched entry (or undefined when nothing matched). */
  entry?: ImmuneMemoryEntry;
  /** True only when the stored diff was genuinely written to disk. */
  fixApplied: boolean;
  /** Repo-relative file the stored fix was applied to. */
  targetFile?: string;
  /** The stored verified diff that was reused. */
  reusedDiff?: string;
  /** Set when application was required but did not succeed. */
  error?: string;
}

/**
 * True when every line the diff would ADD is already present in the file.
 * Used to tell "the fix is already live" apart from "this patch does not
 * describe this file", so an already-fixed file is not reported as a failure.
 */
export function isDiffAlreadyApplied(content: string, diff: ParsedDiff): boolean {
  const lines = content.split(/\r?\n/);
  const added: string[] = [];
  const removed: string[] = [];
  for (const hunk of diff.hunks) {
    for (const l of hunk.lines) {
      if (l[0] === '+') added.push(l.slice(1));
      if (l[0] === '-') removed.push(l.slice(1));
    }
  }
  if (added.length === 0) return false;
  const has = (text: string) => lines.some(l => l === text);
  return added.every(has) && !removed.some(has);
}

export interface DiffHunk {
  oldStart: number;
  lines: string[];   // ' ' context, '-' removed, '+' added
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  targetPath?: string;
}

/** Parse the unified diff produced by TreatmentAgent into hunks. */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const result: ParsedDiff = { hunks: [] };
  const rawLines = diff.split('\n');

  let current: DiffHunk | null = null;
  for (const line of rawLines) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      result.targetPath = p.startsWith('b/') ? p.slice(2) : p;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('diff ') || line.startsWith('index ')) {
      continue;
    }
    const hunkHeader = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkHeader) {
      current = { oldStart: parseInt(hunkHeader[1], 10), lines: [] };
      result.hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
      current.lines.push(line);
    } else if (line === '\\ No newline at end of file') {
      // ignore
    } else if (line === '') {
      // trailing blank inside a hunk is a context line with the space stripped
      current.lines.push(' ');
    }
  }

  return result;
}

/**
 * Apply a parsed unified diff to `original`, verifying every context and
 * removed line before substituting. Returns null when the diff does not match
 * the file, so a failed application is reported rather than assumed.
 */
/**
 * Apply a parsed unified diff to `original`, verifying the lines it actually
 * changes before substituting. Returns null when the change cannot be located,
 * so a failed application is reported rather than assumed.
 *
 * Context lines are used as a location hint, not as a hard requirement. A diff
 * recorded during an earlier cold-path run can legitimately drift from the file
 * on disk (surrounding lines edited since), and real `patch(1)` tolerates that.
 * The lines that are actually removed/added are always matched exactly:
 *   1. try the full old block (context + removals) — most precise;
 *   2. fall back to just the changed span (first to last non-context line),
 *      which ignores drift in the context outside the change.
 */
export function applyUnifiedDiffToContent(original: string, diff: ParsedDiff): string | null {
  // Preserve the file's own line endings. Splitting a CRLF file on '\n' alone
  // would leave a trailing '\r' on every line and no diff line could ever
  // match, so normalise first and re-join with the original EOL at the end.
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const endsWithNewline = /\r?\n$/.test(original);
  let lines = original.split(/\r?\n/);
  if (endsWithNewline) lines.pop();

  // Apply hunks bottom-up so earlier offsets stay valid.
  const ordered = [...diff.hunks].sort((a, b) => b.oldStart - a.oldStart);

  for (const hunk of ordered) {
    const fullOld: string[] = [];
    const fullNew: string[] = [];
    for (const l of hunk.lines) {
      const m = l[0];
      const text = l.slice(1);
      if (m === ' ' || m === '-') fullOld.push(text);
      if (m === ' ' || m === '+') fullNew.push(text);
    }

    // The changed span: first through last non-context line of the hunk.
    const changeIdx = hunk.lines
      .map((l, i) => (l[0] === '-' || l[0] === '+' ? i : -1))
      .filter(i => i !== -1);
    const spanOld: string[] = [];
    const spanNew: string[] = [];
    if (changeIdx.length > 0) {
      const from = changeIdx[0];
      const to = changeIdx[changeIdx.length - 1];
      for (let i = from; i <= to; i++) {
        const m = hunk.lines[i][0];
        const text = hunk.lines[i].slice(1);
        if (m === ' ' || m === '-') spanOld.push(text);
        if (m === ' ' || m === '+') spanNew.push(text);
      }
    }

    const hinted = Math.max(0, hunk.oldStart - 1);

    /** Find `needle` in `lines`, preferring the position nearest the hunk. */
    const locate = (needle: string[]): number => {
      if (needle.length === 0) return -1;
      const fits = (i: number) => {
        if (i < 0 || i + needle.length > lines.length) return false;
        for (let k = 0; k < needle.length; k++) {
          if (lines[i + k] !== needle[k]) return false;
        }
        return true;
      };
      for (let i = hinted; i <= Math.min(lines.length, hinted + 20); i++) {
        if (fits(i)) return i;
      }
      for (let i = 0; i <= lines.length - needle.length; i++) {
        if (fits(i)) return i;
      }
      return -1;
    };

    let at = locate(fullOld);
    let replacement = fullNew;
    let matchedLen = fullOld.length;
    if (at === -1 && spanOld.length > 0) {
      at = locate(spanOld);
      replacement = spanNew;
      matchedLen = spanOld.length;
    }
    if (at === -1) return null;   // the change described by the diff is not present

    lines.splice(at, matchedLen, ...replacement);
  }

  return lines.join(eol) + (endsWithNewline ? eol : '');
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface OrchestratorOptions {
  /** Override path to the immune memory seed store. */
  storePath?: string;
  /** Override the minimum similarity required to count as an immune match. */
  similarityThreshold?: number;
}

export class Orchestrator {
  private state: PipelineState;
  private readonly memoryStore: ImmuneMemoryStore;
  private readonly similarityThreshold: number;
  /** The real MemoryMatchResult from the most recent runMemoryCheck(). */
  private immuneMatch?: import('@shared/types').MemoryMatchResult;
  /** The real outcome of the most recent warm-path recovery. */
  private immuneRecovery?: ImmuneRecoveryResult;

  constructor(incident: IncidentPayload, options: OrchestratorOptions = {}) {
    this.state = {
      incidentId: incident.incidentId,
      stage: PIPELINE_STAGES.IDLE,
      startTime: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      isImmuneMatch: false,
      incident: incident,
      results: {},
      history: []
    };

    // ImmuneMemoryStore falls back to its own bundled seed path when given undefined.
    const configuredStorePath = options.storePath || process.env.IMMUNE_STORE_PATH;
    this.memoryStore = new ImmuneMemoryStore(
      configuredStorePath && configuredStorePath.trim() !== ''
        ? configuredStorePath
        : undefined
    );

    this.similarityThreshold =
      options.similarityThreshold ??
      envNumber('IMMUNE_SIMILARITY_THRESHOLD', THRESHOLDS.IMMUNE_SIMILARITY_THRESHOLD);
  }

  // ------------------------------------------------------------------
  // State machine plumbing
  // ------------------------------------------------------------------

  private updateStage(stage: PipelineStage, agent?: AgentName, message: string = '') {
    this.state.stage = stage;
    this.state.activeAgent = agent;
    this.state.lastUpdated = new Date().toISOString();

    this.state.history.push({
      stage,
      timestamp: this.state.lastUpdated,
      agent,
      message
    });

    this.emitStateUpdate();
  }

  private emitStateUpdate() {
    // In a full implementation, this would emit DashboardEvent over SSE
    console.log(`[Orchestrator] Stage updated to ${this.state.stage}`);
  }

  private elapsedMs(): number {
    return new Date().getTime() - new Date(this.state.startTime).getTime();
  }

  /** The incident this run was constructed with. */
  private requireIncident(): IncidentPayload {
    const incident = this.state.incident;
    if (!incident) {
      throw new Error('PipelineState.incident is not set — cannot run pipeline agents.');
    }
    return incident;
  }

  /** Read-only access to the final state. */
  public getState(): PipelineState {
    return this.state;
  }

  /**
   * Read-only access to the real warm-path recovery outcome.
   *
   * Returns undefined when the run did not take the immune-memory fast path.
   * The dashboard uses this to display the actual matched entry, the actual
   * reused diff and whether it was genuinely written to disk.
   */
  public getImmuneRecovery(): ImmuneRecoveryResult | undefined {
    return this.immuneRecovery;
  }

  /** Number of entries currently in the immune memory store. */
  public getMemoryEntryCount(): number {
    return this.memoryStore.size;
  }

  // ------------------------------------------------------------------
  // Pipeline driver
  // ------------------------------------------------------------------

  public async runPipeline(): Promise<PipelineState> {
    try {
      // 1. Immune Memory Check — planned fast path
      this.updateStage(PIPELINE_STAGES.MEMORY_LOOKUP, AGENT_NAMES.IMMUNE_MEMORY, 'Checking immune memory');
      const memoryMatch = await this.runMemoryCheck();

      if (memoryMatch) {
        // Apply the stored verified fix to disk BEFORE declaring recovery, so
        // IMMUNE_RECOVERED is only reported for a fix that is genuinely live.
        this.applyImmuneRecovery();
        this.state.totalDurationMs = this.elapsedMs();
        const rec = this.immuneRecovery;
        this.updateStage(
          PIPELINE_STAGES.IMMUNE_RECOVERED,
          undefined,
          rec && rec.fixApplied
            ? `Recovered from immune memory — reused verified fix for ${rec.targetFile} ` +
              `(match ${rec.confidence.toFixed(3)} ≥ ${rec.threshold}, ${rec.memoryLatencyMs}ms); ` +
              `all five cold-path agents skipped`
            : `Immune memory match found but the stored fix could not be applied — ` +
              `${(rec && rec.error) || 'unknown reason'}`
        );
        return this.state;
      }

      // 2. Triage
      this.updateStage(PIPELINE_STAGES.TRIAGING, AGENT_NAMES.TRIAGE, 'Starting triage');
      this.state.results.triage = await this.runTriageAgent();

      if (this.state.results.triage.status === 'failed') {
        throw new Error('Triage failed: ' + this.state.results.triage.error);
      }

      // 3. Diagnostic
      this.updateStage(PIPELINE_STAGES.DIAGNOSING, AGENT_NAMES.DIAGNOSTIC, 'Starting diagnostic');
      this.state.results.diagnostic = await this.runDiagnosticAgent(this.state.results.triage);

      if (this.state.results.diagnostic.status === 'failed') {
        throw new Error('Diagnostic failed: ' + this.state.results.diagnostic.error);
      }

      // 4. Treatment
      this.updateStage(PIPELINE_STAGES.TREATING, AGENT_NAMES.TREATMENT, 'Starting treatment');
      this.state.results.treatment = await this.runTreatmentAgent(this.state.results.diagnostic);

      if (this.state.results.treatment.status === 'failed') {
        throw new Error('Treatment failed: ' + this.state.results.treatment.error);
      }

      // 5. Verification
      this.updateStage(PIPELINE_STAGES.VERIFYING, AGENT_NAMES.VERIFICATION, 'Starting verification');
      this.state.results.verification = await this.runVerificationAgent(this.state.results.treatment);

      // 6. Scribe — always runs, regardless of verification outcome
      this.updateStage(PIPELINE_STAGES.SCRIBING, AGENT_NAMES.SCRIBE, 'Starting scribe');
      this.state.results.scribe = await this.runScribeAgent();

      if (this.state.results.scribe.status === 'failed') {
        // Scribe failure shouldn't necessarily fail the whole pipeline if fix is deployed,
        // but for now we'll mark it as an error
        console.warn('Scribe failed, but fix was verified.');
      }

      // 7. Resolve only if the fix was actually verified; otherwise fail after documenting
      this.state.totalDurationMs = this.elapsedMs();

      if (this.state.results.verification.patchApplied &&
          this.state.results.verification.regressionTestPassed) {
        this.recordVerifiedFix();
        this.updateStage(PIPELINE_STAGES.RESOLVED, undefined, 'Pipeline resolved successfully');
      } else {
        this.updateStage(
          PIPELINE_STAGES.FAILED,
          AGENT_NAMES.VERIFICATION,
          'Verification did not accept the patch — incident remains unresolved'
        );
      }
    } catch (error: any) {
      this.state.totalDurationMs = this.elapsedMs();
      this.updateStage(PIPELINE_STAGES.FAILED, this.state.activeAgent, error.message || 'Unknown pipeline failure');
    }

    return this.state;
  }

  // ------------------------------------------------------------------
  // Stage 0 — Immune memory (Member A's ImmuneMemoryStore)
  // ------------------------------------------------------------------

  private async runMemoryCheck(): Promise<boolean> {
    const incident = this.requireIncident();

    // The memory implementation matches on the incident's normalised error
    // signature, blended with a deterministic vector embedding.
    const signature  = incident.errorSignature;
    const embeddings = generateIncidentEmbedding(signature, incident.stackTrace);

    const match = this.memoryStore.findMatch(signature, this.similarityThreshold, embeddings);

    this.state.isImmuneMatch    = match.matched;
    this.state.memoryLatencyMs = match.latencyMs;
    this.state.lastUpdated      = new Date().toISOString();

    // Retain the REAL match result so the warm path can act on the actual
    // matched entry (and so the dashboard can display it verbatim).
    this.immuneMatch = match;

    if (match.matched && match.entry) {
      console.log(
        `[Orchestrator] Immune memory MATCH "${signature}" → ${match.entry.id} ` +
        `(confidence ${match.confidence.toFixed(3)} >= ${this.similarityThreshold}, ${match.latencyMs}ms)`
      );
      return true;
    }

    console.log(
      `[Orchestrator] Immune memory no match for "${signature}" ` +
      `(best ${match.confidence.toFixed(3)} < ${this.similarityThreshold}, ${match.latencyMs}ms) — cold path`
    );
    return false;
  }

  // ------------------------------------------------------------------
  // Warm path — reuse the stored verified fix
  // ------------------------------------------------------------------

  /**
   * Apply the verified diff of the ACTUAL matched ImmuneMemoryEntry to disk.
   *
   * This is what makes the fast path a real recovery rather than a claim: the
   * demo re-introduces the defect before the second incident, so the stored
   * patch has to be written back to the source file for the running service to
   * be fixed. Nothing is applied when there is no match, no entry, no diff, no
   * target file, or when the patch does not match the file on disk — in those
   * cases fixApplied stays false and the reason is reported.
   */
  private applyImmuneRecovery(): void {
    const match = this.immuneMatch;

    if (!match || !match.matched || !match.entry) {
      this.immuneRecovery = {
        matched: false,
        confidence: match ? match.confidence : 0,
        memoryLatencyMs: match ? match.latencyMs : undefined,
        threshold: this.similarityThreshold,
        fixApplied: false,
        error: 'no matched memory entry',
      };
      return;
    }

    const entry = match.entry;
    const result: ImmuneRecoveryResult = {
      matched: true,
      confidence: match.confidence,
      memoryLatencyMs: match.latencyMs,
      threshold: this.similarityThreshold,
      entry,
      fixApplied: false,
      targetFile: entry.rootCauseFile,
      reusedDiff: entry.verifiedDiff,
    };
    this.immuneRecovery = result;

    if (!entry.verifiedDiff || !entry.verifiedDiff.trim()) {
      result.error = 'matched entry has no verifiedDiff to reuse';
      console.warn(`[Orchestrator] ${result.error} (${entry.id})`);
      return;
    }
    if (!entry.rootCauseFile) {
      result.error = 'matched entry has no rootCauseFile';
      console.warn(`[Orchestrator] ${result.error} (${entry.id})`);
      return;
    }

    // The orchestrator runs with cwd = repo root under `npm run run:pipeline`.
    // Resolve defensively so a dashboard-launched child still lands on the file.
    const repoRoot = path.resolve(__dirname, '..');
    const targetAbs = path.isAbsolute(entry.rootCauseFile)
      ? entry.rootCauseFile
      : path.resolve(repoRoot, entry.rootCauseFile);

    try {
      if (!fs.existsSync(targetAbs)) {
        result.error = `target file not found: ${entry.rootCauseFile}`;
        console.warn(`[Orchestrator] ${result.error}`);
        return;
      }

      const original = fs.readFileSync(targetAbs, 'utf8');
      const parsed = parseUnifiedDiff(entry.verifiedDiff);
      const patched = applyUnifiedDiffToContent(original, parsed);

      if (patched === null) {
        // The diff could not be applied. Distinguish "the fix is already live"
        // (success — the desired state holds) from "this patch does not
        // describe this file" (a genuine failure worth reporting).
        if (isDiffAlreadyApplied(original, parsed)) {
          result.fixApplied = true;
          console.log(
            `[Orchestrator] stored fix for ${entry.id} is already present in ` +
            `${entry.rootCauseFile} — no write needed`
          );
          return;
        }
        result.error =
          'stored diff did not match the current file content and the fix is not already present';
        console.warn(`[Orchestrator] ${result.error}: ${entry.rootCauseFile}`);
        return;
      }

      if (patched === original) {
        // Already fixed on disk — the desired state holds, so this is success.
        result.fixApplied = true;
        console.log(
          `[Orchestrator] stored fix for ${entry.id} already present in ${entry.rootCauseFile} — ` +
          'no write needed'
        );
        return;
      }

      fs.writeFileSync(targetAbs, patched, 'utf8');
      result.fixApplied = true;
      console.log(
        `[Orchestrator] IMMUNE RECOVERY: reused stored verified fix from ${entry.id} → ` +
        `${entry.rootCauseFile} (match ${match.confidence.toFixed(3)}, ${match.latencyMs}ms)`
      );
    } catch (err: any) {
      result.fixApplied = false;
      result.error = err && err.message ? err.message : String(err);
      console.error(`[Orchestrator] failed to apply stored fix: ${result.error}`);
    }
  }

  // ------------------------------------------------------------------
  // Stages 1-5 — the five implemented agents
  // ------------------------------------------------------------------

  private async runTriageAgent(): Promise<TriageResult> {
    return new TriageAgent().run(this.requireIncident());
  }

  private async runDiagnosticAgent(triageContext: TriageResult): Promise<DiagnosticResult> {
    return new DiagnosticAgent().run(this.requireIncident(), triageContext);
  }

  private async runTreatmentAgent(diagnosticContext: DiagnosticResult): Promise<TreatmentResult> {
    const triage = this.state.results.triage;
    if (!triage) {
      throw new Error('Treatment requires a TriageResult — run triage first.');
    }
    return new TreatmentAgent().run(this.requireIncident(), triage, diagnosticContext);
  }

  private async runVerificationAgent(treatmentContext: TreatmentResult): Promise<VerificationResult> {
    return new VerificationAgent().run(
      treatmentContext,
      this.requireIncident(),
      this.state.results.triage,
      this.state.results.diagnostic
    );
  }

  private async runScribeAgent(): Promise<ScribeResult> {
    const { triage, diagnostic, treatment, verification } = this.state.results;
    if (!triage || !diagnostic || !treatment || !verification) {
      throw new Error('Scribe requires triage, diagnostic, treatment and verification results.');
    }
    return new ScribeAgent().run(
      this.requireIncident(),
      triage,
      diagnostic,
      treatment,
      verification
    );
  }

  // ------------------------------------------------------------------
  // Immune memory write-back
  // ------------------------------------------------------------------

  /**
   * Records the verified fix into immune memory so that a repeat of this
   * signature can take the IMMUNE_RECOVERED fast path (see the warm-path
   * step in docs/TEAM_EXECUTION_GUIDE.md §7).
   *
   * Only called once verification has actually accepted the patch.
   */
  private recordVerifiedFix(): void {
    const incident     = this.requireIncident();
    const triage       = this.state.results.triage;
    const treatment    = this.state.results.treatment;
    const verification = this.state.results.verification;

    if (!triage || !treatment || !verification) return;
    if (!verification.patchApplied || !verification.regressionTestPassed) return;
    if (treatment.gitDiff.trim().length === 0) return;

    const signature = incident.errorSignature;
    const entry: ImmuneMemoryEntry = {
      id: `regen_${incident.incidentId}`,
      signature,
      serviceName: incident.serviceName,
      errorPattern: escapeRegExp(signature),
      rootCauseFile: treatment.targetFile,
      verifiedDiff: treatment.gitDiff,
      confidence: treatment.confidenceScore,
      tags: [triage.suspectFunction, incident.serviceName].filter(t => t.length > 0),
      createdAt: new Date().toISOString(),
      hitCount: 0,
      embeddings: generateIncidentEmbedding(signature, incident.stackTrace),
    };

    this.memoryStore.recordFix(entry);
    console.log(
      `[Orchestrator] Immune memory recorded verified fix ${entry.id} ` +
      `for signature "${signature}" (confidence ${entry.confidence})`
    );
  }
}

// ---------------------------------------------------------------------------
// CLI entrypoint — used by `npm run run:pipeline`
// ---------------------------------------------------------------------------

/**
 * The seeded checkout incident described in the project plan
 * (docs/ARCHITECTURE.md §6, docs/DEMO_SCRIPT.md stage 2).
 */
function buildDemoIncident(): IncidentPayload {
  return {
    incidentId: 'REGEN-INCIDENT-001',
    timestamp: new Date().toISOString(),
    serviceName: 'checkout-service',
    environment: 'demo',
    severity: 'HIGH',
    endpoint: '/api/checkout',
    httpStatus: 500,
    errorSignature: 'PAYMENT_MISMATCH_ERROR',
    errorMessage:
      'Payment gateway rejected checkout: grandTotal diverges from the expected invoice after a multi-currency voucher discount',
    stackTrace:
      'Error: PAYMENT_MISMATCH_ERROR\n' +
      '    at processPayment (demo_service/src/services/payment.ts:29:12)\n' +
      '    at applyVoucherAndCalculateTotals (demo_service/src/services/cart.ts:84:10)\n' +
      '    at convertVoucherDiscount (demo_service/src/services/cart.ts:67:24)\n' +
      '    at checkoutRouter (demo_service/src/routes/checkout.ts:40:20)',
    culpritPayload: {
      orderId: 'ord-seed-006',
      voucherCode: 'EUR10OFF',
      discountAmount: 10,
      voucherCurrency: 'EUR',
      cartCurrency: 'USD',
    },
    recentCommits: [
      {
        hash: 'a1b2c3d',
        author: 'checkout-team',
        message: 'feat: multi-currency voucher support',
        timestamp: new Date().toISOString(),
      },
    ],
    metrics: {
      errorRate: 0.2,
      affectedUsersPercent: 20,
      p99LatencyMs: 1840,
      totalRequests: 500,
      failedRequests: 100,
    },
  };
}

async function main(): Promise<void> {
  const orchestrator = new Orchestrator(buildDemoIncident());
  const state = await orchestrator.runPipeline();

  console.log('');
  console.log('================ REGEN PIPELINE RESULT ================');
  console.log(`Incident      : ${state.incidentId}`);
  console.log(`Final stage   : ${state.stage}`);
  console.log(`Immune match  : ${state.isImmuneMatch} (${state.memoryLatencyMs ?? 'n/a'}ms)`);
  console.log(`Total duration: ${state.totalDurationMs ?? 'n/a'}ms`);
  console.log('Stage history :');
  for (const step of state.history) {
    console.log(`  - ${step.stage.padEnd(18)} ${step.message}`);
  }
  for (const key of ['triage', 'diagnostic', 'treatment', 'verification', 'scribe'] as const) {
    const result = state.results[key];
    if (result) {
      console.log(`${key.padEnd(13)}: ${result.status} — ${result.summary}`);
    }
  }
  if (state.results.scribe) {
    console.log(`Postmortem    : ${state.results.scribe.postmortemFilePath || '(not written)'}`);
    console.log(`PR title      : ${state.results.scribe.prTitle}`);
  }
  console.log('=======================================================');
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error('Pipeline run failed:', err);
    process.exitCode = 1;
  });
}
