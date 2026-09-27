// Visual horizontal stepper rendering real-time execution states across all pipeline stages

const PIPELINE_STEPS = [
  { key: 'MEMORY_LOOKUP',  label: 'Memory\nLookup',  icon: '🧠', agent: 'immune_memory' },
  { key: 'TRIAGING',       label: 'Triage',          icon: '🔍', agent: 'triage' },
  { key: 'DIAGNOSING',     label: 'Diagnose',        icon: '🩺', agent: 'diagnostic' },
  { key: 'TREATING',       label: 'Treat',           icon: '🔧', agent: 'treatment' },
  { key: 'VERIFYING',      label: 'Verify',          icon: '✅', agent: 'verification' },
  { key: 'SCRIBING',       label: 'Scribe',          icon: '📝', agent: 'scribe' },
  { key: 'RESOLVED',       label: 'Resolved',        icon: '✔', agent: null },
];

const IMMUNE_STEPS = [
  { key: 'MEMORY_LOOKUP',    label: 'Memory\nLookup',    icon: '🧠', agent: 'immune_memory' },
  { key: 'IMMUNE_RECOVERED', label: 'Immune\nRecovered', icon: '⚡', agent: null },
];

const STAGE_ORDER = PIPELINE_STEPS.map(s => s.key);

/** Returns the step list relevant to the current run. */
function getSteps(state) {
  if (state.isImmuneMatch) return IMMUNE_STEPS;
  // If stage is IMMUNE_RECOVERED but no isImmuneMatch flag, show immune steps anyway
  if (state.stage === 'IMMUNE_RECOVERED') return IMMUNE_STEPS;
  return PIPELINE_STEPS;
}

/**
 * Determine visual state for each step:
 * - 'done'    – completed before the active stage
 * - 'active'  – currently executing
 * - 'pending' – not yet reached
 * - 'skipped' – immune path shortcut
 */
function classifyStep(step, state, steps) {
  const activeIdx  = steps.findIndex(s => s.key === state.stage);
  const stepIdx    = steps.findIndex(s => s.key === step.key);
  const finalStage = state.stage === 'RESOLVED' || state.stage === 'IMMUNE_RECOVERED' || state.stage === 'FAILED';

  // A run that has genuinely reached RESOLVED is finished, not still running.
  // Classifying the terminal step as 'active' (accent + infinite pulse) left the
  // Resolved node rendering as blue/in-progress after the backend had already
  // completed, so the stepper never turned green. 'done' is the existing
  // completed style (green dot, green label) — no new state is introduced.
  // Only RESOLVED is changed here; the warm-path IMMUNE_RECOVERED step keeps its
  // current appearance, and FAILED is untouched.
  if (state.stage === step.key) return state.stage === 'RESOLVED' ? 'done' : 'active';
  if (finalStage && stepIdx <= activeIdx) return 'done';
  if (stepIdx < activeIdx) return 'done';
  return 'pending';
}

/**
 * HTML-escape a value for safe interpolation.
 *
 * Every component is its own ES module, so module scope is NOT shared: the
 * copies in main.js and IncidentDetail.js are invisible here. Without a local
 * definition, renderStageLog() threw `ReferenceError: escHtml is not defined`
 * on the first event that produced a stage-log line, which aborted
 * renderPipelineTracker() before `container.innerHTML = html` and left the
 * tracker frozen on its first IDLE render. main.js's try/catch reported it
 * only as "[SSE] Parse error".
 */
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Per-stage detail lines, built ONLY from the real orchestrator output.
 *
 * Every mark is derived from the actual AgentResult.status and the actual
 * booleans/counts the agents returned — a stage is never ticked unless the
 * real result says it succeeded, and verification is never described as
 * passing unless VerificationAgent reported it passing.
 */
function renderStageLog(state, immune) {
  const r = (state.results && state.results) || {};
  const lines = [];

  const memorySeen = (state.history || []).some(h => h.stage === 'MEMORY_LOOKUP');
  const isWarm = state.stage === 'IMMUNE_RECOVERED' || !!state.isImmuneMatch;
  // On the warm path the detailed MEMORY HIT line is rendered further down,
  // where the real matched entry and score are available.
  if (memorySeen && !isWarm) {
    const ms = state.memoryLatencyMs;
    lines.push({
      label: 'MEMORY',
      ok: !!state.isImmuneMatch,
      text: state.isImmuneMatch
        ? `Immune memory hit${ms != null ? ` (${ms}ms)` : ''} — warm path`
        : `Search complete, no match${ms != null ? ` (${ms}ms)` : ''} — cold path`,
    });
  }

  if (r.triage) {
    lines.push({
      label: 'TRIAGE',
      ok: r.triage.status === 'success',
      text: r.triage.status === 'success'
        ? `Suspect identified: ${r.triage.rootCauseFile} → ${r.triage.suspectFunction}()`
        : (r.triage.error || r.triage.summary || 'failed'),
    });
  }

  if (r.diagnostic) {
    lines.push({
      label: 'DIAGNOSIS',
      ok: r.diagnostic.status === 'success',
      text: r.diagnostic.status === 'success'
        ? `Regression test generated: ${r.diagnostic.regressionTestPath}`
        : (r.diagnostic.error || r.diagnostic.summary || 'failed'),
    });
  }

  if (r.treatment) {
    lines.push({
      label: 'TREATMENT',
      ok: r.treatment.status === 'success',
      text: r.treatment.status === 'success'
        ? `Patch generated for ${r.treatment.targetFile} · confidence ${r.treatment.confidenceScore}`
        : (r.treatment.error || r.treatment.summary || 'failed'),
    });
  }

  if (r.verification) {
    const v = r.verification;
    const passed = v.status === 'success';
    const parts = [];
    parts.push(v.regressionTestPassed ? 'regression test passed' : 'regression test FAILED');
    parts.push(v.baselineUnitTestsPassed ? 'existing tests passed' : 'existing tests FAILED');
    if (v.totalTests) parts.push(`${v.passedTests}/${v.totalTests} tests`);
    lines.push({
      label: 'VERIFICATION',
      ok: passed,
      text: passed
        ? parts.join(' · ') + (v.patchApplied ? ' · patch applied' : '')
        : (v.error || parts.join(' · ')),
    });
  }

  if (r.scribe) {
    lines.push({
      label: 'SCRIBE',
      ok: r.scribe.status === 'success',
      text: r.scribe.status === 'success'
        ? `Postmortem generated${r.scribe.postmortemFilePath ? `: ${r.scribe.postmortemFilePath}` : ''}`
        : (r.scribe.error || r.scribe.summary || 'failed'),
    });
  }

  const warm = state.stage === 'IMMUNE_RECOVERED' || !!state.isImmuneMatch;

  if (warm) {
    // Everything below comes from the real `immune` payload the server sends
    // alongside the state, plus the real findMatch() numbers on the state.
    // Nothing is assumed: a missing payload renders as "not reported" rather
    // than as a successful match.
    const ms   = (immune && immune.memoryLatencyMs != null) ? immune.memoryLatencyMs : state.memoryLatencyMs;
    const conf = immune ? immune.confidence : null;
    const thr  = immune ? immune.threshold : null;
    const entry = immune ? immune.entry : null;

    if (immune) {
      lines.push({
        label: 'MEMORY HIT',
        ok: true,
        text:
          `Matched ${entry ? entry.id : 'entry'}` +
          (entry && entry.signature ? ` (${entry.signature})` : '') +
          (conf != null ? ` · score ${Number(conf).toFixed(3)}` : '') +
          (thr != null ? ` ≥ threshold ${Number(thr).toFixed(2)}` : '') +
          (ms != null ? ` · ${ms}ms` : '') +
          (immune.entryCount != null ? ` · ${immune.entryCount} entries in store` : ''),
      });
    } else {
      lines.push({
        label: 'MEMORY HIT',
        ok: !!state.isImmuneMatch,
        text: `Immune match reported${ms != null ? ` (${ms}ms)` : ''} — warm path`,
      });
    }

    if (immune && immune.reusedDiff) {
      lines.push({
        label: 'STORED FIX',
        ok: immune.fixApplied === true,
        text:
          `Reused verified fix from ${immune.targetFile || (entry && entry.rootCauseFile) || 'memory'}` +
          (entry && typeof entry.confidence === 'number'
            ? ` · stored confidence ${entry.confidence.toFixed(2)}`
            : '') +
          (immune.fixApplied === true
            ? ' · applied to disk'
            : ` · NOT applied${immune.error ? ` (${immune.error})` : ''}`),
      });
    }

    // The five cold-path agents genuinely did not run on this fast path.
    const skipped = [
      { label: 'TRIAGING', text: 'SKIPPED' },
      { label: 'DIAGNOSING', text: 'SKIPPED' },
      { label: 'TREATING', text: 'SKIPPED' },
      { label: 'VERIFYING', text: 'SKIPPED' },
      { label: 'SCRIBING', text: 'SKIPPED' },
    ];
    skipped.forEach(item => {
      lines.push({ label: item.label, ok: true, skipped: true, text: item.text });
    });

    lines.push({
      label: 'RECOVERY',
      ok: !immune || immune.fixApplied !== false,
      text: !immune
        ? 'Incident recovered via immune memory — no cold agents needed'
        : (immune.fixApplied === true
            ? 'Incident recovered via immune memory — no cold agents needed'
            : `Immune match found but recovery failed: ${immune.error || 'unknown reason'}`),
    });
  } else if (state.stage === 'RESOLVED') {
    lines.push({ label: 'RESOLVED', ok: true, text: 'Incident recovered \u2014 verified fix recorded' });
  } else if (state.stage === 'FAILED') {
    const hist = state.history || [];
    const last = hist.length ? hist[hist.length - 1].message : 'pipeline failed';
    lines.push({ label: 'FAILED', ok: false, text: last });
  }

  if (!lines.length) return '';

  return `
    <ul class="stage-log">
      ${lines.map(l => `
        <li class="stage-log__item stage-log__item--${l.skipped ? 'skipped' : (l.ok ? 'ok' : 'bad')}">
          <span class="stage-log__mark">${l.skipped ? '⏭' : (l.ok ? '✓' : '✕')}</span>
          <span class="stage-log__label">${escHtml(l.label)}</span>
          <span class="stage-log__text">${escHtml(l.text)}</span>
        </li>`).join('')}
    </ul>`;
}

/**
 * The actual stored patch that the warm path reused, rendered verbatim.
 * Returns '' on a cold run or when no diff was reported.
 */
function renderReusedDiff(immune) {
  if (!immune || !immune.reusedDiff) return '';
  const diff = String(immune.reusedDiff).trimEnd();
  return `
    <details class="reused-diff" open>
      <summary>Reused verified fix — ${escHtml(immune.targetFile || 'target file')}</summary>
      <pre class="reused-diff__body">${escHtml(diff)}</pre>
    </details>`;
}

function renderPipelineTracker(state, container, immune) {
  const steps = getSteps(state);

  const html = `
    <section class="card">
      <h3 class="card-title">Pipeline Tracker
        <span class="stage-badge stage--${state.stage}" style="margin-left:8px">${state.stage.replace(/_/g,' ')}</span>
        ${state.totalDurationMs ? `<span style="float:right;font-size:11px;color:var(--muted);font-weight:400">${(state.totalDurationMs/1000).toFixed(1)}s total</span>` : ''}
      </h3>
      <div class="pipeline-stepper">
        ${steps.map(step => {
          const cls = classifyStep(step, state, steps);
          const icon = cls === 'done' ? '✓' : (cls === 'active' ? step.icon : step.icon);
          return `
            <div class="step step--${cls}">
              <div class="step-dot">${icon}</div>
              <div class="step-label">${step.label.replace(/\n/g, '<br>')}</div>
            </div>`;
        }).join('')}
      </div>
      ${renderStageLog(state, immune)}
      ${renderReusedDiff(immune)}
      ${state.results && state.results.verification ? `
        <div style="margin-top:8px;font-size:12px;color:${state.results.verification.status === 'success' ? 'var(--green)' : 'var(--red)'}">
          ${state.results.verification.status === 'success' ? '✓' : '✕'} ${state.results.verification.passedTests}/${state.results.verification.totalTests} tests passed
          ${state.results.verification.regressionTestPassed ? '· Regression test green' : ''}
        </div>
      ` : ''}
    </section>`;

  container.innerHTML = html;
}

// Export for main.js
window.__PipelineTracker = { render: renderPipelineTracker };
