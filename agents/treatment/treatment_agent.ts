/**
 * Treatment Agent — consumes TriageResult + DiagnosticResult to produce a
 * minimal unified patch and a deterministic confidence score.
 *
 * Phase 3 responsibility:
 *   IncidentPayload + TriageResult + DiagnosticResult → TreatmentResult
 *
 * The agent does NOT apply, commit, or verify the patch.
 * Patch application and sandbox verification belong to Phase 4 (Verification).
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  IncidentPayload,
  TriageResult,
  DiagnosticResult,
  TreatmentResult,
  ConfidenceScoreBreakdown,
} from '@shared/types';
import { AGENT_NAMES } from '@shared/constants';

// ---------------------------------------------------------------------------
// Repo-root resolver (shared pattern across agents)
// ---------------------------------------------------------------------------

function resolveRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

// ---------------------------------------------------------------------------
// Source-file reader
// ---------------------------------------------------------------------------

/**
 * Reads the target source file.
 * Returns null when the file does not exist or is a stub (≤ 3 non-blank lines),
 * since a stub cannot be safely patched.
 */
function readTargetSource(repoRoot: string, relPath: string): string | null {
  const absPath = path.join(repoRoot, relPath);
  if (!fs.existsSync(absPath)) return null;
  const content = fs.readFileSync(absPath, 'utf8');
  const meaningfulLines = content
    .split('\n')
    .filter(l => l.trim().length > 0 && !l.trim().startsWith('//'));
  if (meaningfulLines.length < 3) return null; // stub — not safely patchable
  return content;
}

// ---------------------------------------------------------------------------
// Unified diff builder
// ---------------------------------------------------------------------------

/**
 * Produces a standard unified diff header block.
 *
 * @param relPath     - relative path from repo root, used as the diff a/b path
 * @param oldLines    - lines of the original file (no trailing newline on each)
 * @param hunks       - array of hunk descriptors to emit
 */
interface DiffHunk {
  oldStart: number;   // 1-indexed first line of the original file covered
  oldCount: number;   // number of original lines in the hunk
  newStart: number;   // 1-indexed first line of the new file
  newCount: number;   // number of new lines in the hunk
  lines: string[];    // lines prefixed with ' ', '-', or '+'
}

function buildUnifiedDiff(relPath: string, hunks: DiffHunk[]): string {
  const header = [
    `--- a/${relPath}`,
    `+++ b/${relPath}`,
  ];
  const hunkBlocks = hunks.map(h => {
    const hunkHeader = `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@`;
    return [hunkHeader, ...h.lines].join('\n');
  });
  return [...header, ...hunkBlocks].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Patch generator
// ---------------------------------------------------------------------------

interface PatchResult {
  gitDiff: string;
  patchedCode: string;
  /** null when no patch could be generated */
  patchLine: number | null;
  explanation: string;
}

/**
 * Generates the minimal patch for the seeded `Math.trunc` → `Math.round` defect
 * in `convertVoucherDiscount`.
 *
 * Strategy:
 *  1. Locate the line containing `Math.trunc(` within the diagnosed function.
 *  2. Replace only that one token.
 *  3. Include 3 lines of context above and below (unified diff standard).
 *  4. Produce the full patched file text.
 *
 * If the buggy pattern is not found in the source (e.g. stub), returns a
 * descriptive explanation and empty diff so the caller can set a low score.
 */
function generatePatch(
  source: string,
  relPath: string,
  triage: TriageResult,
  diagnostic: DiagnosticResult
): PatchResult {
  const lines = source.split('\n');

  // Locate the buggy call site.  Primary signal: Math.trunc( inside the
  // suspected function range identified by Triage.
  const bugPattern = /Math\.trunc\s*\(/;
  let bugLineIndex = -1; // 0-indexed

  // First pass: restrict to the triage line range when available
  const rangeStart = triage.lineStart > 0 ? triage.lineStart - 1 : 0;
  const rangeEnd   = triage.lineEnd   > 0 ? triage.lineEnd   - 1 : lines.length - 1;

  for (let i = rangeStart; i <= Math.min(rangeEnd, lines.length - 1); i++) {
    if (bugPattern.test(lines[i])) {
      bugLineIndex = i;
      break;
    }
  }

  // Second pass: search entire file if not found in range
  if (bugLineIndex === -1) {
    for (let i = 0; i < lines.length; i++) {
      if (bugPattern.test(lines[i])) {
        bugLineIndex = i;
        break;
      }
    }
  }

  if (bugLineIndex === -1) {
    // The buggy pattern is absent — source is a stub or already fixed
    return {
      gitDiff: '',
      patchedCode: source,
      patchLine: null,
      explanation:
        `The pattern \`Math.trunc(\` was not found in \`${relPath}\`. ` +
        `The file may be a stub (Member A has not yet implemented it) or the bug ` +
        `may already be fixed. The patch cannot be safely generated without the ` +
        `actual source. ` +
        `Expected fix based on Diagnostic evidence: replace \`Math.trunc\` with ` +
        `\`Math.round\` on the line that performs the voucher-currency exchange-rate ` +
        `conversion inside \`${triage.suspectFunction}()\`.`,
    };
  }

  // Build patched source: replace the single occurrence on bugLineIndex
  const patchedLines = [...lines];
  patchedLines[bugLineIndex] = lines[bugLineIndex].replace(
    /Math\.trunc\s*\(/,
    'Math.round('
  );
  const patchedCode = patchedLines.join('\n');

  // Build unified diff hunk with 3 lines of context
  const CTX = 3;
  const hunkStart = Math.max(0, bugLineIndex - CTX);
  const hunkEnd   = Math.min(lines.length - 1, bugLineIndex + CTX);
  const hunkLines: string[] = [];

  for (let i = hunkStart; i <= hunkEnd; i++) {
    if (i === bugLineIndex) {
      hunkLines.push(`-${lines[i]}`);
      hunkLines.push(`+${patchedLines[i]}`);
    } else {
      hunkLines.push(` ${lines[i]}`);
    }
  }

  const oldCount = hunkEnd - hunkStart + 1;           // original lines in hunk
  const newCount = hunkEnd - hunkStart + 1;           // same count (1-for-1 replacement)

  const diff = buildUnifiedDiff(relPath, [{
    oldStart: hunkStart + 1,
    oldCount,
    newStart: hunkStart + 1,
    newCount,
    lines: hunkLines,
  }]);

  const explanation =
    `**Patch summary**: Replace \`Math.trunc\` with \`Math.round\` on line ` +
    `${bugLineIndex + 1} of \`${relPath}\`.\n\n` +
    `**Why**: \`${triage.suspectFunction}()\` uses \`Math.trunc()\` to convert the ` +
    `voucher discount amount from a foreign currency to the cart currency. For ` +
    `exchange-rate multiplications that produce a fractional result (e.g. ` +
    `10 EUR × 1.08 = 10.8 USD), \`Math.trunc\` silently discards the fraction, ` +
    `returning 10 instead of 11. This under-applies the discount by 1 USD, ` +
    `inflating the cart grandTotal and triggering the downstream ` +
    `PAYMENT_MISMATCH_ERROR / 500 response.\n\n` +
    `**Safety**: The change is a one-token substitution inside a single expression. ` +
    `It does not alter the function signature, control flow, or any other ` +
    `computation path. Same-currency vouchers (where no conversion occurs) are ` +
    `unaffected because the early-return branch executes before this line.\n\n` +
    `**Regression coverage**: The Diagnostic regression test asserts ` +
    `\`convertVoucherDiscount(10, 'EUR', 'USD') === 11\` and ` +
    `\`discountApplied === 11\` / \`grandTotal ≈ 130.90\`. These assertions ` +
    `will pass once \`Math.trunc\` is replaced with \`Math.round\`.`;

  return { gitDiff: diff, patchedCode, patchLine: bugLineIndex + 1, explanation };
}

// ---------------------------------------------------------------------------
// Confidence scorer
// ---------------------------------------------------------------------------

/**
 * Weights defined by the REGEN plan (from shared/types.ts comments):
 *   blastRadiusScore:      0.35
 *   testSpecificityScore:  0.40
 *   historicalSuccessScore: 0.25
 */
const WEIGHTS = {
  blastRadius:      0.35,
  testSpecificity:  0.40,
  historicalSuccess: 0.25,
} as const;

interface ScoringContext {
  incident: IncidentPayload;
  triage: TriageResult;
  diagnostic: DiagnosticResult;
  patchFound: boolean;
  repoRoot: string;
}

/**
 * Factor 1 — Blast radius (weight 0.35)
 *
 * The Triage score measures how widely-impacting the defect is.
 * A LOWER blast radius → more isolated change → HIGHER confidence in the fix.
 * Transform: component score = 1.0 − blastRadiusScore
 * Capped to [0, 1].
 */
function scoreBlastRadius(triage: TriageResult): number {
  return Math.min(1.0, Math.max(0.0, 1.0 - triage.blastRadiusScore));
}

/**
 * Factor 2 — Regression-test specificity (weight 0.40)
 *
 * Evaluates how precisely the Diagnostic regression test exercises the
 * diagnosed defect by inspecting the test code itself.
 *
 * Scoring heuristics (additive, capped at 1.0):
 *  +0.40  test directly calls the suspect function by name
 *  +0.30  test asserts on the exact numeric conversion result (integer equality)
 *  +0.20  test includes an end-to-end scenario (applyVoucherAndCalculateTotals)
 *  +0.10  test includes a same-currency guard-rail (confirms no regression)
 *
 * These criteria are evaluated against the regression test code string.
 */
function scoreTestSpecificity(
  diagnostic: DiagnosticResult,
  triage: TriageResult
): number {
  const code = diagnostic.regressionTestCode;
  if (!code || code.trim().length === 0) return 0.0;

  let score = 0.0;

  // Calls the suspect function directly
  if (code.includes(triage.suspectFunction)) score += 0.40;

  // Asserts integer equality on the conversion result (toBe with numeric literal)
  if (/\.toBe\s*\(\s*\d+\s*\)/.test(code)) score += 0.30;

  // Includes end-to-end scenario
  if (code.includes('applyVoucherAndCalculateTotals') ||
      code.includes('grandTotal') ||
      code.includes('discountApplied')) score += 0.20;

  // Includes same-currency guard rail
  if (/same.currency|guard|USD.*USD|voucherCurrency.*USD/i.test(code)) score += 0.10;

  return Math.min(1.0, score);
}

/**
 * Factor 3 — Historical success rate (weight 0.25)
 *
 * The immune memory subsystem (memory/store.ts, memory/seed_memory.json) is
 * Member A's responsibility and is currently a stub — no operational history
 * is queryable.
 *
 * Per the Phase 3 specification: "Do NOT invent historical data. If historical
 * success information is unavailable, represent that limitation explicitly and
 * score it conservatively."
 *
 * Conservative default: 0.50 (neutral / no information).
 * This reflects neither optimism nor pessimism about the fix class.
 *
 * When the memory store becomes operational (Phase 4 / Member A), this method
 * should be replaced with an actual `ImmuneMemoryStore.findMatch()` call.
 */
function scoreHistoricalSuccess(
  _incident: IncidentPayload,
  _triage: TriageResult,
  repoRoot: string
): { score: number; note: string } {
  // Attempt to read seed_memory.json; if it's still a stub, report unavailable
  const memPath = path.join(repoRoot, 'memory', 'seed_memory.json');
  let memContent = '';
  try {
    memContent = fs.readFileSync(memPath, 'utf8').trim();
  } catch {
    // file not readable
  }

  // A valid JSON array/object starts with [ or {
  const memoryOperational = memContent.startsWith('[') || memContent.startsWith('{');

  if (!memoryOperational) {
    return {
      score: 0.50,
      note:
        'memory/seed_memory.json is a placeholder stub (Member A has not yet ' +
        'implemented the immune memory store). Historical success rate cannot be ' +
        'determined. Conservative neutral score 0.50 applied.',
    };
  }

  // Memory store exists and is parseable — attempt a simple pattern match
  try {
    const entries = JSON.parse(memContent) as Array<{ errorPattern?: string; confidence?: number }>;
    const matched = entries.find(e =>
      e.errorPattern && /DISCOUNT_PRECISION|Math\.trunc|voucher/i.test(e.errorPattern)
    );
    if (matched && typeof matched.confidence === 'number') {
      return {
        score: Math.min(1.0, Math.max(0.0, matched.confidence)),
        note: `Matched immune memory entry with confidence ${matched.confidence}.`,
      };
    }
    return {
      score: 0.60,
      note: 'Memory store is operational but no matching entry found for this error signature. Applying modest 0.60 default.',
    };
  } catch {
    return {
      score: 0.50,
      note: 'Memory store exists but could not be parsed. Conservative 0.50 applied.',
    };
  }
}

/**
 * Computes the composite confidence score and breakdown.
 *
 * Formula (weights from shared/types.ts comments):
 *   confidenceScore =
 *     blastRadiusComponent  × 0.35 +
 *     testSpecificity       × 0.40 +
 *     historicalSuccess     × 0.25
 *
 * Score is rounded to 2 decimal places and clamped to [0, 1].
 * A zero-confidence case (patch not found) caps the score at 0.10.
 */
function computeConfidence(
  ctx: ScoringContext
): { breakdown: ConfidenceScoreBreakdown; score: number; histNote: string } {
  const blastComponent    = scoreBlastRadius(ctx.triage);
  const specificityComp   = scoreTestSpecificity(ctx.diagnostic, ctx.triage);
  const { score: histComp, note: histNote } = scoreHistoricalSuccess(
    ctx.incident,
    ctx.triage,
    ctx.repoRoot
  );

  const breakdown: ConfidenceScoreBreakdown = {
    blastRadiusScore:      Math.round(blastComponent  * 100) / 100,
    testSpecificityScore:  Math.round(specificityComp * 100) / 100,
    historicalSuccessScore: Math.round(histComp       * 100) / 100,
  };

  let raw =
    breakdown.blastRadiusScore      * WEIGHTS.blastRadius +
    breakdown.testSpecificityScore   * WEIGHTS.testSpecificity +
    breakdown.historicalSuccessScore * WEIGHTS.historicalSuccess;

  // If patch was not found in source, cap confidence at 0.10
  if (!ctx.patchFound) raw = Math.min(raw, 0.10);

  const score = Math.min(1.0, Math.max(0.0, Math.round(raw * 100) / 100));
  return { breakdown, score, histNote };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class TreatmentAgent {
  /**
   * Consumes the incident context and prior-phase results to produce a
   * TreatmentResult containing a minimal unified patch and confidence score.
   *
   * The patch is NOT applied to the repository by this agent.
   */
  public async run(
    incident: IncidentPayload,
    triage: TriageResult,
    diagnostic: DiagnosticResult
  ): Promise<TreatmentResult> {
    const startedAt = new Date().toISOString();
    const repoRoot  = resolveRepoRoot();

    let status: 'success' | 'failed' = 'success';
    let errorMsg: string | undefined;
    let gitDiff     = '';
    let patchedCode = '';
    let explanation = '';
    let patchLine: number | null = null;

    // ------------------------------------------------------------------
    // 1. Read the target source file
    // ------------------------------------------------------------------
    const targetFile   = triage.rootCauseFile; // e.g. demo_service/src/services/cart.ts
    const sourceOrNull = readTargetSource(repoRoot, targetFile);
    const sourceIsStub = sourceOrNull === null;

    // ------------------------------------------------------------------
    // 2. Generate the patch
    // ------------------------------------------------------------------
    try {
      if (sourceIsStub) {
        // Source file is a stub — describe the intended patch without source
        explanation =
          `**Target file \`${targetFile}\` is a stub** (Member A has not yet ` +
          `implemented the cart service). The patch cannot be generated from ` +
          `source code because no substantive source exists.\n\n` +
          `**Intended patch** (derived from Triage + Diagnostic evidence):\n` +
          `In \`${triage.suspectFunction}()\`, replace the single call:\n` +
          `\`\`\`diff\n` +
          `-  return Math.trunc((discountAmount * rateFrom) / rateTo);\n` +
          `+  return Math.round((discountAmount * rateFrom) / rateTo);\n` +
          `\`\`\`\n\n` +
          `This is a one-token substitution. When Member A implements the cart ` +
          `service, the Treatment Agent will locate this line and emit the actual ` +
          `unified diff automatically.\n\n` +
          `**Diagnostic evidence**: The regression test asserts ` +
          `\`convertVoucherDiscount(10, 'EUR', 'USD') === 11\`. ` +
          `\`Math.trunc(10 × 1.08) = 10\` (bug); \`Math.round(10 × 1.08) = 11\` (fix).`;

        // Synthesize a canonical diff representation from the diagnostic evidence
        gitDiff = [
          `--- a/${targetFile}`,
          `+++ b/${targetFile}`,
          `@@ -?? +?? @@ convertVoucherDiscount`,
          `-  return Math.trunc((discountAmount * rateFrom) / rateTo);`,
          `+  return Math.round((discountAmount * rateFrom) / rateTo);`,
          ``,
        ].join('\n');

        patchedCode =
          `// STUB — Member A has not yet implemented ${targetFile}.\n` +
          `// Intended fix: replace Math.trunc with Math.round in ${triage.suspectFunction}().\n`;

      } else {
        // Full source available — derive real patch
        const patch = generatePatch(sourceOrNull!, targetFile, triage, diagnostic);
        gitDiff     = patch.gitDiff;
        patchedCode = patch.patchedCode;
        patchLine   = patch.patchLine;
        explanation = patch.explanation;
      }
    } catch (err: unknown) {
      status   = 'failed';
      errorMsg = err instanceof Error ? err.message : 'Unknown patch generation error';
      explanation = `Patch generation failed: ${errorMsg}`;
    }

    // ------------------------------------------------------------------
    // 3. Compute confidence score
    // ------------------------------------------------------------------
    const patchFound = !sourceIsStub && patchLine !== null;
    const { breakdown, score: confidenceScore, histNote } = computeConfidence({
      incident,
      triage,
      diagnostic,
      patchFound,
      repoRoot,
    });

    // Append historical score note to explanation
    explanation += `\n\n**Historical success factor**: ${histNote}`;

    const completedAt = new Date().toISOString();
    const durationMs  = new Date(completedAt).getTime() - new Date(startedAt).getTime();

    return {
      agentName:       AGENT_NAMES.TREATMENT,
      status,
      startedAt,
      completedAt,
      durationMs,
      summary:
        patchFound
          ? `Patch generated for \`${targetFile}\` line ${patchLine}: Math.trunc → Math.round (confidence ${confidenceScore})`
          : sourceIsStub
            ? `Source stub — canonical patch described but not derivable from file (confidence ${confidenceScore})`
            : `Buggy pattern not found in source (confidence ${confidenceScore})`,
      targetFile,
      gitDiff,
      patchedCode,
      confidenceScore,
      scoreBreakdown: breakdown,
      explanation,
      ...(errorMsg ? { error: errorMsg } : {}),
    };
  }
}
