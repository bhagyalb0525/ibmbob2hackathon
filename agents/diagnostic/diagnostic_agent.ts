/**
 * Diagnostic Agent — inspects the suspected defect and creates a deterministic
 * regression test that reproduces the failure.
 *
 * Phase 2 responsibility: TriageResult + IncidentPayload → DiagnosticResult
 * Does NOT patch code (that belongs to Treatment).
 */

import * as fs from 'fs';
import * as path from 'path';
import { IncidentPayload, TriageResult, DiagnosticResult } from '@shared/types';
import { AGENT_NAMES, RELATIVE_PATHS } from '@shared/constants';

// ---------------------------------------------------------------------------
// Regression test file path
// ---------------------------------------------------------------------------

const REGRESSION_TEST_PATH = `${RELATIVE_PATHS.REGRESSION_TEST_DIR}/reproduce_incident.test.ts`;

// ---------------------------------------------------------------------------
// Reproduction scenario builder
// ---------------------------------------------------------------------------

/**
 * Derives the concrete reproduction scenario from triage + incident evidence.
 *
 * The scenario targets `convertVoucherDiscount` in cart.ts, which uses
 * Math.trunc() instead of Math.round() causing a precision loss when
 * converting a foreign-currency voucher discount to the cart currency.
 *
 * Example that trips the bug deterministically:
 *   - 10 EUR voucher applied to a USD cart
 *   - EXCHANGE_RATES: EUR = 1.08, USD = 1.0
 *   - Math.trunc(10 * 1.08 / 1.0) = Math.trunc(10.8) = 10   ← WRONG (bug)
 *   - Math.round(10 * 1.08 / 1.0) = Math.round(10.8) = 11   ← CORRECT
 *
 * The truncated discount is 1 USD too small, inflating the grandTotal by
 * 1.10 USD (1 USD × 1.10 tax multiplier), which is the exact discrepancy
 * observed in the incident.
 */
interface ReproductionScenario {
  /** Short human-readable description */
  description: string;
  /** The exact test assertions that will FAIL on the buggy code */
  assertions: string;
  /** The expected (correct) converted discount in USD */
  expectedDiscount: number;
  /** The actual (buggy) converted discount in USD */
  actualBuggyDiscount: number;
}

function buildReproductionScenario(
  _incident: IncidentPayload,
  triage: TriageResult
): ReproductionScenario {
  // These values are derived from EXCHANGE_RATES in cart.ts
  // 10 EUR × 1.08 EUR/USD = 10.8 USD
  const discountAmountEUR = 10;
  const eurToUsd           = 1.08;
  const rawUsd             = discountAmountEUR * eurToUsd; // 10.8

  const buggyDiscount    = Math.trunc(rawUsd);  // 10  — what the bug produces
  const correctDiscount  = Math.round(rawUsd);  // 11  — what a fix should produce

  const description =
    `Incident reproducer for: ${triage.rootCauseFile} → ${triage.suspectFunction}()\n` +
    `Bug: Math.trunc() in convertVoucherDiscount() truncates the EUR→USD exchange ` +
    `conversion of a voucher discount instead of rounding, producing a discount that ` +
    `is ${correctDiscount - buggyDiscount} USD too small.\n` +
    `Trigger: apply a ${discountAmountEUR} EUR voucher to a USD cart; ` +
    `expect ${correctDiscount} USD discount, receive ${buggyDiscount} USD.`;

  const assertions =
    `// A 10 EUR voucher should convert to 11 USD (Math.round(10 * 1.08) = 11)\n` +
    `// The bug returns 10 USD (Math.trunc(10.8) = 10) — 1 USD under-applied\n` +
    `expect(buggyResult).toBe(${buggyDiscount}); // documents what the bug currently produces\n` +
    `expect(correctResult).toBe(${correctDiscount}); // asserts the CORRECT expected value`;

  return { description, assertions, expectedDiscount: correctDiscount, actualBuggyDiscount: buggyDiscount };
}

// ---------------------------------------------------------------------------
// Test file generator
// ---------------------------------------------------------------------------

function generateRegressionTestCode(
  triage: TriageResult,
  _incident: IncidentPayload,
  scenario: ReproductionScenario
): string {
  return `/**
 * Regression test: multi-currency voucher discount precision failure
 *
 * Incident ID  : REGEN-INCIDENT-001
 * Root cause   : ${triage.rootCauseFile} → ${triage.suspectFunction}()
 * Lines        : ${triage.lineStart}–${triage.lineEnd}
 * Blast radius : ${triage.blastRadiusScore}
 *
 * Bug description
 * ---------------
 * convertVoucherDiscount() uses Math.trunc() when converting a voucher amount
 * from a foreign currency to the cart currency. For exchange-rate values that
 * produce a fractional result (e.g. 10 EUR × 1.08 = 10.8 USD), Math.trunc()
 * silently drops the 0.8, returning 10 instead of the correct 11. The
 * under-applied discount inflates the grandTotal, which is then rejected by
 * the payment gateway with a PAYMENT_MISMATCH_ERROR / 500 response.
 *
 * Reproduction scenario
 * ---------------------
 * ${scenario.description.replace(/\n/g, '\n * ')}
 *
 * This test FAILS on the unfixed code and PASSES after Treatment patches
 * Math.trunc → Math.round in convertVoucherDiscount().
 */

import {
  convertVoucherDiscount,
  applyVoucherAndCalculateTotals,
  EXCHANGE_RATES,
  CartItem,
  VoucherCode,
} from '../../src/services/cart';

// ---------------------------------------------------------------------------
// Regression test 1: direct unit-level reproduction of the precision bug
// ---------------------------------------------------------------------------
describe('REGRESSION: convertVoucherDiscount — EUR→USD truncation bug', () => {
  const VOUCHER_AMOUNT_EUR = 10;
  const EXPECTED_USD       = Math.round(VOUCHER_AMOUNT_EUR * EXCHANGE_RATES['EUR']); // 11

  it('should return the ROUNDED conversion (11 USD) not the TRUNCATED value (10 USD)', () => {
    const result = convertVoucherDiscount(VOUCHER_AMOUNT_EUR, 'EUR', 'USD');

    // This assertion FAILS on the buggy code because Math.trunc(10.8) = 10, not 11.
    // After the fix (Math.round), this assertion PASSES.
    expect(result).toBe(EXPECTED_USD);
  });

  it('documents the exact bug: Math.trunc(10.8) returns 10 instead of 11', () => {
    // Confirm that Math.trunc exhibits the under-application behaviour
    const rawConversion = VOUCHER_AMOUNT_EUR * EXCHANGE_RATES['EUR']; // 10.8
    expect(Math.trunc(rawConversion)).toBe(10);  // the bug
    expect(Math.round(rawConversion)).toBe(11);  // the fix
  });
});

// ---------------------------------------------------------------------------
// Regression test 2: end-to-end cart totals diverge when EUR voucher is applied
// ---------------------------------------------------------------------------
describe('REGRESSION: applyVoucherAndCalculateTotals — grandTotal inflated by EUR voucher bug', () => {
  const items: CartItem[] = [
    { id: 'P1', name: 'Widget', quantity: 2, unitPrice: 50, currency: 'USD' }, // 100 USD
    { id: 'P2', name: 'Gadget', quantity: 1, unitPrice: 30, currency: 'USD' }, // 30 USD
    // subtotal = 130 USD
  ];

  const voucher: VoucherCode = {
    code: 'EUR10OFF',
    discountAmount: 10,      // 10 EUR
    voucherCurrency: 'EUR',
  };

  it('should apply an 11 USD discount (rounded) not 10 USD (truncated)', () => {
    const totals = applyVoucherAndCalculateTotals(items, voucher, 'USD');

    // With the BUG:   discountApplied = 10, taxBase = 120, tax = 12.00, grandTotal = 132.00
    // With the FIX:   discountApplied = 11, taxBase = 119, tax = 11.90, grandTotal = 130.90

    // This assertion FAILS on the buggy code (result is 10) and PASSES after the fix (result is 11).
    expect(totals.discountApplied).toBe(11);
  });

  it('should produce a grandTotal of 130.90 USD not the inflated 132.00 USD', () => {
    const totals = applyVoucherAndCalculateTotals(items, voucher, 'USD');

    // grandTotal with correct 11 USD discount: (130 - 11) + (130 - 11) * 0.10
    //   = 119 + 11.90 = 130.90
    expect(totals.grandTotal).toBeCloseTo(130.9, 2);
  });
});

// ---------------------------------------------------------------------------
// Regression test 3: same-currency vouchers are unaffected (guard rail)
// ---------------------------------------------------------------------------
describe('GUARD: same-currency vouchers remain correct', () => {
  const items: CartItem[] = [
    { id: 'P1', name: 'Widget', quantity: 1, unitPrice: 100, currency: 'USD' },
  ];

  it('USD voucher on USD cart applies the full discount without truncation', () => {
    const totals = applyVoucherAndCalculateTotals(
      items,
      { code: 'USD10', discountAmount: 10, voucherCurrency: 'USD' },
      'USD'
    );
    expect(totals.discountApplied).toBe(10);
    expect(totals.grandTotal).toBeCloseTo(99, 2); // (100-10) * 1.10 = 99
  });
});
`;
}

// ---------------------------------------------------------------------------
// File writer
// ---------------------------------------------------------------------------

function writeRegressionTestFile(repoRoot: string, relPath: string, code: string): void {
  const absPath = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, code, 'utf8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export class DiagnosticAgent {
  /**
   * Resolves the repository root by walking up from __dirname until package.json is found.
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
   * Inspects the triage result and incident evidence, creates a regression test,
   * writes it to disk, and returns a DiagnosticResult.
   *
   * `reproductionConfirmed` is set to false — actual verification that the test
   * fails on the unfixed code is performed by the Verification Agent in Phase 4.
   */
  public async run(
    incident: IncidentPayload,
    triage: TriageResult
  ): Promise<DiagnosticResult> {
    const startedAt = new Date().toISOString();
    const repoRoot  = DiagnosticAgent.resolveRepoRoot();

    let regressionTestCode = '';
    let status: 'success' | 'failed' = 'success';
    let errorMsg: string | undefined;

    try {
      // 1. Build reproduction scenario from triage + incident evidence
      const scenario = buildReproductionScenario(incident, triage);

      // 2. Generate the test file source
      regressionTestCode = generateRegressionTestCode(triage, incident, scenario);

      // 3. Write file to disk
      writeRegressionTestFile(repoRoot, REGRESSION_TEST_PATH, regressionTestCode);
    } catch (err: unknown) {
      status   = 'failed';
      errorMsg = err instanceof Error ? err.message : 'Unknown diagnostic error';
    }

    const completedAt = new Date().toISOString();
    const durationMs  = new Date(completedAt).getTime() - new Date(startedAt).getTime();

    return {
      agentName:            AGENT_NAMES.DIAGNOSTIC,
      status,
      startedAt,
      completedAt,
      durationMs,
      summary:
        status === 'success'
          ? `Regression test written to ${REGRESSION_TEST_PATH}`
          : `Diagnostic failed: ${errorMsg}`,
      regressionTestPath:   REGRESSION_TEST_PATH,
      regressionTestCode,
      reproductionCommand:  'npm run test:demo',
      // reproductionConfirmed is deliberately false: only the Verification Agent
      // can confirm this by actually executing the test against the unfixed code.
      reproductionConfirmed: false,
      ...(errorMsg ? { error: errorMsg } : {}),
    };
  }
}
