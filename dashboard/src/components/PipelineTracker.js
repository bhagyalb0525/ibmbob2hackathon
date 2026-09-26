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
  { key: 'MEMORY_LOOKUP',  label: 'Memory\nLookup',  icon: '🧠', agent: 'immune_memory' },
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

  if (state.stage === step.key) return 'active';
  if (finalStage && stepIdx <= activeIdx) return 'done';
  if (stepIdx < activeIdx) return 'done';
  return 'pending';
}

function renderPipelineTracker(state, container) {
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
      ${state.results && state.results.verification ? `
        <div style="margin-top:8px;font-size:12px;color:var(--green)">
          ✓ ${state.results.verification.passedTests}/${state.results.verification.totalTests} tests passed
          ${state.results.verification.regressionTestPassed ? '· Regression test green' : ''}
        </div>
      ` : ''}
    </section>`;

  container.innerHTML = html;
}

// Export for main.js
window.__PipelineTracker = { render: renderPipelineTracker };
