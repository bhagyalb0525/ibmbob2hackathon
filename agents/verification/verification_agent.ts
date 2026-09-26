/**
 * Verification Agent — applies the Treatment patch, runs the test suite,
 * and determines whether the fix is safe to accept or must be rolled back.
 *
 * Phase 4 responsibility:
 *   TreatmentResult → apply patch → run tests → accept / rollback → VerificationResult
 *
 * This is the FIRST phase that is allowed to write the Treatment patch to disk.
 * It is also responsible for rollback if the tests fail.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import {
  IncidentPayload,
  TriageResult,
  DiagnosticResult,
  TreatmentResult,
  VerificationResult,
} from '@shared/types';
import { AGENT_NAMES, RELATIVE_PATHS, THRESHOLDS } from '@shared/constants';

// ---------------------------------------------------------------------------
// Repo-root resolver
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
// Patch parser — extract the target file path from a unified diff header
// ---------------------------------------------------------------------------

/**
 * Parses the target file path from a unified diff string.
 * Expects a line of the form:  +++ b/path/to/file.ts
 * Returns null if the header is not found or malformed.
 */
function parseTargetFromDiff(gitDiff: string): string | null {
  for (const line of gitDiff.split('\n')) {
    // Standard unified diff target line
    const match = line.match(/^\+\+\+\s+b\/(.+)$/);
    if (match) return match[1].trim();
    // Fallback: line starts with +++ but no b/ prefix
    const fallback = line.match(/^\+\+\+\s+(.+)$/);
    if (fallback) {
      const candidate = fallback[1].trim();
      if (!candidate.startsWith('---')) return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Source availability check
// ---------------------------------------------------------------------------

/**
 * Returns true when the file exists and has substantive (non-stub) content.
 * A stub is defined as a file with ≤ 3 non-blank, non-comment lines.
 */
function isSourceOperational(absPath: string): boolean {
  if (!fs.existsSync(absPath)) return false;
  const lines = fs.readFileSync(absPath, 'utf8').split('\n');
  const meaningful = lines.filter(l => {
    const t = l.trim();
    return t.length > 0 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  });
  return meaningful.length >= 3;
}

// ---------------------------------------------------------------------------
// Patch applier — in-process line-level application of a unified diff
// ---------------------------------------------------------------------------

interface ApplyResult {
  success: boolean;
  originalContent: string;
  patchedContent: string;
  error?: string;
}

/**
 * Applies a unified diff to the file at `absPath`.
 *
 * Strategy: parse hunk headers and – / + lines; apply each substitution.
 * Supports single-hunk diffs with context lines (the Treatment Agent always
 * produces exactly one hunk with 3 context lines).
 *
 * Returns the original content for rollback purposes.
 */
function applyUnifiedDiff(absPath: string, gitDiff: string): ApplyResult {
  const originalContent = fs.readFileSync(absPath, 'utf8');
  const originalLines   = originalContent.split('\n');

  // Collect all hunks from the diff
  const hunkHeaderRegex = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/;
  const diffLines = gitDiff.split('\n');

  // Find hunk starts
  const hunkStarts: number[] = [];
  for (let i = 0; i < diffLines.length; i++) {
    if (hunkHeaderRegex.test(diffLines[i])) hunkStarts.push(i);
  }

  if (hunkStarts.length === 0) {
    return {
      success: false,
      originalContent,
      patchedContent: originalContent,
      error: 'No hunk headers found in diff — diff may be a stub description only.',
    };
  }

  // Build new file line-by-line
  let resultLines: string[] = [...originalLines];

  // Apply hunks in reverse order (so line numbers stay valid)
  for (let hi = hunkStarts.length - 1; hi >= 0; hi--) {
    const hunkIdx  = hunkStarts[hi];
    const headerM  = diffLines[hunkIdx].match(hunkHeaderRegex)!;
    const oldStart = parseInt(headerM[1], 10) - 1; // 0-indexed
    const oldCount = parseInt(headerM[2], 10);

    // Collect the hunk body lines
    const nextHunk = hunkStarts[hi + 1] ?? diffLines.length;
    const bodyLines = diffLines.slice(hunkIdx + 1, nextHunk);

    // Extract removed and added lines
    const removedLines: string[]  = [];
    const addedLines: string[]    = [];
    const contextLines: string[]  = [];

    for (const bl of bodyLines) {
      if (bl.startsWith('-')) {
        removedLines.push(bl.slice(1));
      } else if (bl.startsWith('+')) {
        addedLines.push(bl.slice(1));
      } else if (bl.startsWith(' ')) {
        contextLines.push(bl.slice(1));
      }
      // Lines starting with '\' (no newline at end of file) are ignored
    }

    // Verify context lines match before applying
    // Build the expected old block (context + removed)
    const oldBlock: string[] = [];
    for (const bl of bodyLines) {
      if (bl.startsWith('-')) oldBlock.push(bl.slice(1));
      else if (bl.startsWith(' ')) oldBlock.push(bl.slice(1));
    }

    // Verify the old block matches the file content
    const fileSlice = resultLines.slice(oldStart, oldStart + oldBlock.length);
    const sliceStr  = fileSlice.join('\n');
    const oldStr    = oldBlock.join('\n');

    if (sliceStr !== oldStr) {
      return {
        success: false,
        originalContent,
        patchedContent: originalContent,
        error:
          `Patch hunk does not match file content at line ${oldStart + 1}.\n` +
          `Expected:\n${oldStr}\n\nFound:\n${sliceStr}`,
      };
    }

    // Build the new block (context + added)
    const newBlock: string[] = [];
    for (const bl of bodyLines) {
      if (bl.startsWith('+')) newBlock.push(bl.slice(1));
      else if (bl.startsWith(' ')) newBlock.push(bl.slice(1));
    }

    resultLines = [
      ...resultLines.slice(0, oldStart),
      ...newBlock,
      ...resultLines.slice(oldStart + oldBlock.length),
    ];
  }

  const patchedContent = resultLines.join('\n');
  return { success: true, originalContent, patchedContent };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

interface TestRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  regressionPassed: boolean;
  baselinePassed: boolean;
}

/**
 * Runs the project's `test:demo` script (jest) synchronously.
 * Parses Jest summary output to extract test counts.
 *
 * Returns a structured result; never throws.
 */
function runTests(repoRoot: string): TestRunResult {
  let stdout = '';
  let stderr = '';
  let exitCode = 1;

  try {
    const result = child_process.spawnSync(
      'npm',
      ['run', 'test:demo'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: THRESHOLDS.PIPELINE_TIMEOUT_MS,
        shell: true,
      }
    );
    stdout   = result.stdout ?? '';
    stderr   = result.stderr ?? '';
    exitCode = result.status ?? 1;
  } catch (err: unknown) {
    stderr   = err instanceof Error ? err.message : String(err);
    exitCode = 1;
  }

  const combined = stdout + '\n' + stderr;

  // Parse Jest summary lines, e.g.:
  //   "Tests: 3 failed, 7 passed, 10 total"
  //   "Tests: 10 passed, 10 total"
  const summaryMatch = combined.match(/Tests:\s*(.*?)(\n|$)/);
  let totalTests  = 0;
  let passedTests = 0;
  let failedTests = 0;

  if (summaryMatch) {
    const summary = summaryMatch[1];
    const failM   = summary.match(/(\d+)\s+failed/);
    const passM   = summary.match(/(\d+)\s+passed/);
    const totM    = summary.match(/(\d+)\s+total/);
    if (failM) failedTests  = parseInt(failM[1], 10);
    if (passM) passedTests  = parseInt(passM[1], 10);
    if (totM)  totalTests   = parseInt(totM[1],  10);
  }

  // Determine whether the regression test file specifically passed
  // Jest outputs "PASS path/to/file" or "FAIL path/to/file" per suite
  const regressionFile = RELATIVE_PATHS.REGRESSION_TEST_DIR + '/reproduce_incident.test.ts';
  const regressionPassed =
    exitCode === 0 ||
    new RegExp(`PASS\\s+.*${regressionFile.replace(/[/\\]/g, '[/\\\\]')}`).test(combined);

  const regressionFailed =
    new RegExp(`FAIL\\s+.*${regressionFile.replace(/[/\\]/g, '[/\\\\]')}`).test(combined);

  const baselineFailed =
    combined.includes('FAIL demo_service/tests/unit/') ||
    combined.includes('FAIL demo_service\\tests\\unit\\');

  return {
    exitCode,
    stdout,
    stderr,
    totalTests,
    passedTests,
    failedTests,
    regressionPassed: regressionPassed && !regressionFailed,
    baselinePassed:   exitCode === 0 && !baselineFailed,
  };
}

// ---------------------------------------------------------------------------
// Member A readiness check
// ---------------------------------------------------------------------------

/**
 * Returns a brief diagnostic string when the demo service is not yet operational,
 * or null when it appears ready to use.
 *
 * Checks:
 *  1. cart.ts must be substantive (not a stub)
 *  2. jest must be resolvable (node_modules/.bin/jest or package.json has jest dep)
 */
function checkMemberAReadiness(repoRoot: string): string | null {
  const cartPath = path.join(repoRoot, RELATIVE_PATHS.DEMO_CART_SERVICE);
  if (!isSourceOperational(cartPath)) {
    return (
      `demo_service/src/services/cart.ts is a stub — Member A has not yet ` +
      `implemented the cart service. ` +
      `VerificationAgent cannot apply or test the Treatment patch until ` +
      `the demo service is operational.`
    );
  }

  const jestBin = path.join(repoRoot, 'node_modules', '.bin', 'jest');
  const jestBinCmd = path.join(repoRoot, 'node_modules', '.bin', 'jest.cmd');
  const hasJest = fs.existsSync(jestBin) || fs.existsSync(jestBinCmd);
  if (!hasJest) {
    return (
      `Jest is not installed (node_modules/.bin/jest not found). ` +
      `The test runner required by \`npm run test:demo\` is unavailable. ` +
      `Member A must install jest as a devDependency before verification can run.`
    );
  }

  return null; // ready
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class VerificationAgent {
  /**
   * Main entry point.
   *
   * @param treatment   - the TreatmentResult produced by Phase 3
   * @param incident    - original incident (optional, for richer output)
   * @param triage      - triage result (optional, for richer output)
   * @param diagnostic  - diagnostic result (optional, for richer output)
   */
  public async run(
    treatment: TreatmentResult,
    incident?: IncidentPayload,
    triage?: TriageResult,
    diagnostic?: DiagnosticResult
  ): Promise<VerificationResult> {
    const startedAt = new Date().toISOString();
    const repoRoot  = resolveRepoRoot();

    // ------------------------------------------------------------------
    // 1. Validate treatment input
    // ------------------------------------------------------------------
    if (!treatment || treatment.status === 'failed') {
      return this.blockedResult(
        startedAt,
        'Treatment phase failed or was not completed — cannot proceed with verification.',
        false
      );
    }

    // ------------------------------------------------------------------
    // 2. Check Member A readiness
    // ------------------------------------------------------------------
    const memberABlocker = checkMemberAReadiness(repoRoot);
    if (memberABlocker) {
      return this.blockedResult(startedAt, memberABlocker, false);
    }

    // ------------------------------------------------------------------
    // 3. Validate the diff has a real hunk (not a stub canonical diff)
    // ------------------------------------------------------------------
    const targetRelPath = parseTargetFromDiff(treatment.gitDiff);
    if (!targetRelPath) {
      return this.blockedResult(
        startedAt,
        `Cannot parse target file from Treatment diff. Diff may be a ` +
        `stub canonical description rather than an applicable unified diff.`,
        false
      );
    }

    const targetAbsPath = path.join(repoRoot, targetRelPath);
    if (!fs.existsSync(targetAbsPath)) {
      return this.blockedResult(
        startedAt,
        `Target file \`${targetRelPath}\` does not exist — patch cannot be applied.`,
        false
      );
    }

    // Reject stub canonical diffs (they contain '??' line numbers)
    if (treatment.gitDiff.includes('@@ -?? ')) {
      return this.blockedResult(
        startedAt,
        `Treatment diff is a canonical stub description (contains @@ -?? placeholders) ` +
        `rather than a real unified diff. This occurs when cart.ts was a stub during ` +
        `Treatment phase. Cannot apply. BLOCKED BY MEMBER A DEMO SERVICE`,
        false
      );
    }

    // ------------------------------------------------------------------
    // 4. Apply the patch
    // ------------------------------------------------------------------
    const applyResult = applyUnifiedDiff(targetAbsPath, treatment.gitDiff);

    if (!applyResult.success) {
      return this.blockedResult(
        startedAt,
        `Patch application failed: ${applyResult.error}`,
        false
      );
    }

    // Write the patched content
    fs.writeFileSync(targetAbsPath, applyResult.patchedContent, 'utf8');

    let patchApplied = true;
    let testRun: TestRunResult | null = null;
    let rollbackPerformed = false;

    // ------------------------------------------------------------------
    // 5. Run tests
    // ------------------------------------------------------------------
    try {
      testRun = runTests(repoRoot);
    } catch (err: unknown) {
      // Unexpected runner failure — rollback
      fs.writeFileSync(targetAbsPath, applyResult.originalContent, 'utf8');
      patchApplied       = false;
      rollbackPerformed  = true;

      return this.failedResult(
        startedAt,
        `Test runner threw an unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        false,
        `Patch rolled back due to test runner failure.`
      );
    }

    // ------------------------------------------------------------------
    // 6. Accept or rollback
    // ------------------------------------------------------------------
    const verificationPassed = testRun.regressionPassed && testRun.baselinePassed;

    if (!verificationPassed) {
      // Rollback
      fs.writeFileSync(targetAbsPath, applyResult.originalContent, 'utf8');
      patchApplied      = false;
      rollbackPerformed = true;
    }

    // ------------------------------------------------------------------
    // 7. Build result
    // ------------------------------------------------------------------
    const completedAt = new Date().toISOString();
    const durationMs  = new Date(completedAt).getTime() - new Date(startedAt).getTime();

    const suiteOutput =
      `Exit code: ${testRun.exitCode}\n` +
      (testRun.stdout.trim() ? `STDOUT:\n${testRun.stdout.trim()}\n` : '') +
      (testRun.stderr.trim() ? `STDERR:\n${testRun.stderr.trim()}\n` : '') +
      (rollbackPerformed ? '\n[VerificationAgent] Patch rolled back — tests did not pass.' : '') +
      (!rollbackPerformed && verificationPassed ? '\n[VerificationAgent] Patch accepted — all tests passed.' : '');

    return {
      agentName:               AGENT_NAMES.VERIFICATION,
      status:                  verificationPassed ? 'success' : 'failed',
      startedAt,
      completedAt,
      durationMs,
      summary:
        verificationPassed
          ? `Verification passed: regression + baseline tests passed. Patch accepted for ${targetRelPath}.`
          : `Verification failed: one or more tests did not pass. Patch rolled back.`,
      totalTests:              testRun.totalTests,
      passedTests:             testRun.passedTests,
      failedTests:             testRun.failedTests,
      regressionTestPassed:    testRun.regressionPassed,
      baselineUnitTestsPassed: testRun.baselinePassed,
      suiteOutput,
      patchApplied,
    };
  }

  // ------------------------------------------------------------------
  // Helpers for blocked / failed early exits
  // ------------------------------------------------------------------

  private blockedResult(
    startedAt: string,
    reason: string,
    patchApplied: boolean
  ): VerificationResult {
    const completedAt = new Date().toISOString();
    const durationMs  = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    return {
      agentName:               AGENT_NAMES.VERIFICATION,
      status:                  'failed',
      startedAt,
      completedAt,
      durationMs,
      summary:                 `BLOCKED BY MEMBER A DEMO SERVICE: ${reason}`,
      totalTests:              0,
      passedTests:             0,
      failedTests:             0,
      regressionTestPassed:    false,
      baselineUnitTestsPassed: false,
      suiteOutput:             `BLOCKED: ${reason}`,
      patchApplied,
      error:                   reason,
    };
  }

  private failedResult(
    startedAt: string,
    reason: string,
    patchApplied: boolean,
    suiteOutput: string
  ): VerificationResult {
    const completedAt = new Date().toISOString();
    const durationMs  = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    return {
      agentName:               AGENT_NAMES.VERIFICATION,
      status:                  'failed',
      startedAt,
      completedAt,
      durationMs,
      summary:                 reason,
      totalTests:              0,
      passedTests:             0,
      failedTests:             0,
      regressionTestPassed:    false,
      baselineUnitTestsPassed: false,
      suiteOutput,
      patchApplied,
      error:                   reason,
    };
  }
}
