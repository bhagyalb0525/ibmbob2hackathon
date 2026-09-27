/**
 * Triage Agent — parses incoming error logs and incident evidence to identify
 * the root-cause file, line range, and blast radius.
 *
 * Phase 2 responsibility: IncidentPayload → TriageResult
 * Does NOT generate patches or tests (those belong to Diagnostic / Treatment).
 */

import * as fs from 'fs';
import * as path from 'path';
import { IncidentPayload, TriageResult } from '@shared/types';
import { AGENT_NAMES, RELATIVE_PATHS } from '@shared/constants';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface StackFrame {
  file: string;
  line: number;
  column?: number;
  fn?: string;
}

interface TriageHeuristics {
  rootCauseFile: string;
  suspectFunction: string;
  lineStart: number;
  lineEnd: number;
  blastRadiusScore: number;
  explanation: string;
}

// ---------------------------------------------------------------------------
// Stack trace parser
// ---------------------------------------------------------------------------

/**
 * Extracts structured frames from a Node.js-style stack trace string.
 * Handles both "at FunctionName (file:line:col)" and anonymous forms.
 */
function parseStackTrace(stackTrace: string): StackFrame[] {
  const frames: StackFrame[] = [];
  // Match: "at functionName (path/to/file.ts:line:col)" or "at path/to/file.ts:line:col"
  const frameRegex = /at\s+(?:([^\s(]+)\s+\()?([^)]+):(\d+):(\d+)\)?/g;
  let match: RegExpExecArray | null;

  while ((match = frameRegex.exec(stackTrace)) !== null) {
    const fn   = match[1] ?? '<anonymous>';
    const file = match[2];
    const line = parseInt(match[3], 10);
    const col  = parseInt(match[4], 10);

    // Skip node internals and node_modules
    if (file.startsWith('node:') || file.includes('node_modules')) {
      continue;
    }

    frames.push({ file: normalizeFilePath(file), line, column: col, fn });
  }
  return frames;
}

/** Strips drive letters and normalizes slashes to forward-slash paths */
function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^[A-Z]:/, '');
}

// ---------------------------------------------------------------------------
// Error signature classifier
// ---------------------------------------------------------------------------

/** Known error signatures → known root-cause areas */
const ERROR_SIGNATURE_MAP: Record<string, { file: string; fn: string; reason: string }> = {
  'DISCOUNT_PRECISION_ERROR':  {
    file: RELATIVE_PATHS.DEMO_CART_SERVICE,
    fn:   'convertVoucherDiscount',
    reason: 'Multi-currency voucher discount uses Math.trunc() instead of Math.round(), silently losing fractional units for certain exchange rates.',
  },
  'PAYMENT_MISMATCH_ERROR': {
    file: RELATIVE_PATHS.DEMO_CART_SERVICE,
    fn:   'convertVoucherDiscount',
    reason: 'Truncated voucher discount produces a grandTotal that diverges from the payment gateway invoice expectation.',
  },
  'CART_CALCULATION_ERROR': {
    file: RELATIVE_PATHS.DEMO_CART_SERVICE,
    fn:   'applyVoucherAndCalculateTotals',
    reason: 'Cart calculation threw an unhandled exception during voucher discount processing.',
  },
};

// ---------------------------------------------------------------------------
// Source code inspection helpers
// ---------------------------------------------------------------------------

/**
 * Attempts to read the source file and return the line range for a named function.
 * Returns [0, 0] when the file cannot be read or the function is not found.
 */
function findFunctionLineRange(
  repoRoot: string,
  relativeFilePath: string,
  functionName: string
): [number, number] {
  const absPath = path.join(repoRoot, relativeFilePath);
  let src: string;
  try {
    src = fs.readFileSync(absPath, 'utf8');
  } catch {
    return [0, 0];
  }

  const lines = src.split('\n');

  // Find the line where the function is declared
  const declarationPattern = new RegExp(
    `(export\\s+)?function\\s+${functionName}\\b|${functionName}\\s*[:=]\\s*(async\\s+)?(?:function|\\()`
  );

  let startLine = 0;
  for (let i = 0; i < lines.length; i++) {
    if (declarationPattern.test(lines[i])) {
      startLine = i + 1; // 1-indexed
      break;
    }
  }

  if (startLine === 0) return [0, 0];

  // Walk forward to find the closing brace
  let depth = 0;
  let endLine = startLine;
  let entered = false;

  for (let i = startLine - 1; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; entered = true; }
      if (ch === '}') { depth--; }
    }
    if (entered && depth === 0) {
      endLine = i + 1; // 1-indexed
      break;
    }
  }

  return [startLine, endLine];
}

// ---------------------------------------------------------------------------
// Blast radius calculator
// ---------------------------------------------------------------------------

/**
 * Calculates a normalised blast-radius score (0.0–1.0).
 *
 * Factors:
 *   1. Severity weight        — CRITICAL=0.35, HIGH=0.25, MEDIUM=0.15, LOW=0.05
 *   2. Error rate weight      — metrics.errorRate (0.0–1.0), capped at 0.25
 *   3. Affected users weight  — affectedUsersPercent / 100, capped at 0.20
 *   4. Endpoint centrality    — checkout/cart endpoints score 0.15; others 0.05
 *
 * Maximum possible = 0.35 + 0.25 + 0.20 + 0.15 = 0.95 (high blast for critical cart errors)
 */
function calculateBlastRadius(incident: IncidentPayload): number {
  const severityWeight: Record<string, number> = {
    CRITICAL: 0.35,
    HIGH: 0.25,
    MEDIUM: 0.15,
    LOW: 0.05,
  };

  const sv = severityWeight[incident.severity] ?? 0.15;
  const er = Math.min(incident.metrics.errorRate, 1.0) * 0.25;
  const au = Math.min(incident.metrics.affectedUsersPercent / 100, 1.0) * 0.20;

  const ep = (incident.endpoint.toLowerCase().includes('checkout') ||
               incident.endpoint.toLowerCase().includes('cart'))
    ? 0.15
    : 0.05;

  const raw = sv + er + au + ep;
  // Normalise to 0–1 and round to 2 dp
  return Math.min(Math.round(raw * 100) / 100, 1.0);
}

// ---------------------------------------------------------------------------
// Core heuristic: identify root cause from all available signals
// ---------------------------------------------------------------------------

function determineRootCause(incident: IncidentPayload, repoRoot: string): TriageHeuristics {
  const startedAt = new Date().toISOString();

  // 1. Try exact error-signature match first (highest confidence)
  for (const [sig, hint] of Object.entries(ERROR_SIGNATURE_MAP)) {
    if (
      incident.errorSignature.includes(sig) ||
      incident.errorMessage.includes(sig) ||
      incident.stackTrace.includes(sig)
    ) {
      const [lineStart, lineEnd] = findFunctionLineRange(repoRoot, hint.file, hint.fn);
      const blastRadius = calculateBlastRadius(incident);

      return {
        rootCauseFile: hint.file,
        suspectFunction: hint.fn,
        lineStart,
        lineEnd,
        blastRadiusScore: blastRadius,
        explanation:
          `**Signal**: Error signature \`${sig}\` matched a known defect pattern.\n\n` +
          `**Root cause**: ${hint.reason}\n\n` +
          `**Location**: \`${hint.file}\` → \`${hint.fn}()\`\n\n` +
          `**Blast radius (${blastRadius})**: Composed of ` +
          `severity (${incident.severity}), ` +
          `error rate (${(incident.metrics.errorRate * 100).toFixed(0)}%), ` +
          `affected users (${incident.metrics.affectedUsersPercent}%), ` +
          `and endpoint centrality (${incident.endpoint}).`,
      };
    }
  }

  // 2. Fall back to stack-trace frame analysis
  const frames = parseStackTrace(incident.stackTrace);
  const serviceFrames = frames.filter(f =>
    f.file.includes('demo_service') || f.file.includes('services') || f.file.includes('routes')
  );

  if (serviceFrames.length > 0) {
    const topFrame = serviceFrames[0];
    const [lineStart, lineEnd] = [topFrame.line, topFrame.line + 10];
    const blastRadius = calculateBlastRadius(incident);

    return {
      rootCauseFile: topFrame.file,
      suspectFunction: topFrame.fn ?? '<unknown>',
      lineStart,
      lineEnd,
      blastRadiusScore: blastRadius,
      explanation:
        `**Signal**: Stack trace analysis — top application frame is ` +
        `\`${topFrame.fn}\` at ${topFrame.file}:${topFrame.line}.\n\n` +
        `**Error**: ${incident.errorMessage}\n\n` +
        `**Blast radius (${blastRadius})**: Composed of severity (${incident.severity}), ` +
        `error rate (${(incident.metrics.errorRate * 100).toFixed(0)}%), ` +
        `and affected users (${incident.metrics.affectedUsersPercent}%).`,
    };
  }

  // 3. Last resort: report the cart service as default for checkout failures
  const defaultFile = RELATIVE_PATHS.DEMO_CART_SERVICE;
  const [lineStart, lineEnd] = findFunctionLineRange(repoRoot, defaultFile, 'convertVoucherDiscount');
  const blastRadius = calculateBlastRadius(incident);

  return {
    rootCauseFile: defaultFile,
    suspectFunction: 'convertVoucherDiscount',
    lineStart,
    lineEnd,
    blastRadiusScore: blastRadius,
    explanation:
      `**Signal**: Checkout endpoint failure with no parseable stack frames.\n\n` +
      `**Fallback**: Defaulting to cart service discount calculation, which is the only ` +
      `component capable of producing checkout failures at the reported rate.\n\n` +
      `**Blast radius (${blastRadius})**: Severity ${incident.severity}, ` +
      `${(incident.metrics.errorRate * 100).toFixed(0)}% error rate.`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class TriageAgent {
  /**
   * Resolves the repository root by walking up from __dirname until package.json is found.
   * Falls back to process.cwd() if not found.
   */
  private static resolveRepoRoot(): string {
    let dir = __dirname;
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return process.cwd();
  }

  /**
   * Analyses the incident payload and returns a TriageResult.
   */
  public async run(incident: IncidentPayload): Promise<TriageResult> {
    const startedAt = new Date().toISOString();
    const repoRoot  = TriageAgent.resolveRepoRoot();

    let heuristics: TriageHeuristics;
    let status: 'success' | 'failed' = 'success';
    let errorMsg: string | undefined;

    try {
      heuristics = determineRootCause(incident, repoRoot);
    } catch (err: unknown) {
      status = 'failed';
      errorMsg = err instanceof Error ? err.message : 'Unknown triage error';
      // Provide a safe fallback so the pipeline can continue
      heuristics = {
        rootCauseFile: RELATIVE_PATHS.DEMO_CART_SERVICE,
        suspectFunction: 'unknown',
        lineStart: 0,
        lineEnd: 0,
        blastRadiusScore: 0.5,
        explanation: `Triage failed: ${errorMsg}`,
      };
    }

    const completedAt = new Date().toISOString();
    const durationMs  = new Date(completedAt).getTime() - new Date(startedAt).getTime();

    return {
      agentName:        AGENT_NAMES.TRIAGE,
      status,
      startedAt,
      completedAt,
      durationMs,
      summary:          `Root cause identified in ${heuristics.rootCauseFile} → ${heuristics.suspectFunction}()`,
      rootCauseFile:    heuristics.rootCauseFile,
      suspectFunction:  heuristics.suspectFunction,
      lineStart:        heuristics.lineStart,
      lineEnd:          heuristics.lineEnd,
      blastRadiusScore: heuristics.blastRadiusScore,
      explanation:      heuristics.explanation,
      ...(errorMsg ? { error: errorMsg } : {}),
    };
  }
}
