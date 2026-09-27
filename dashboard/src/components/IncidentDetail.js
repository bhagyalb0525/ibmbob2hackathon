// Incident view displaying root cause diagnosis, proposed code diff, and patch confidence score

/**
 * Render diff text as coloured HTML lines.
 * Lines starting with '+' → green, '-' → red, '@@' / 'diff' → muted.
 */
function renderDiff(diffText) {
  if (!diffText) return '';
  return diffText
    .split('\n')
    .map(line => {
      if (line.startsWith('+'))  return `<span class="diff-add">${escHtml(line)}</span>`;
      if (line.startsWith('-'))  return `<span class="diff-del">${escHtml(line)}</span>`;
      if (line.startsWith('@@') || line.startsWith('diff')) return `<span class="diff-meta">${escHtml(line)}</span>`;
      return `<span>${escHtml(line)}</span>`;
    })
    .join('\n');
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function renderIncidentDetail(state, container) {
  const inc = state.incident;

  if (!inc) {
    container.innerHTML = `
      <section class="card">
        <h3 class="card-title">Incident Detail</h3>
        <p style="color:var(--muted);font-size:13px">No active incident — a real ShopFlow checkout failure will appear here.</p>
      </section>`;
    return;
  }

  const treatment = state.results && state.results.treatment;
  const triage    = state.results && state.results.triage;

  const confidencePct = treatment ? Math.round(treatment.confidenceScore * 100) : null;

  // demo_service exposes no traffic metrics, so a captured incident carries no
  // real numbers. Render the chips only when the payload actually has values,
  // rather than presenting "0%" / "0ms" as if they had been measured.
  const m = inc.metrics || {};
  const hasMetrics = Object.keys(m).some(k => typeof m[k] === 'number' && m[k] > 0);

  container.innerHTML = `
    <section class="card">
      <h3 class="card-title">Incident Detail</h3>

      <div class="incident-row">
        <span class="incident-label">Incident ID</span>
        <span class="incident-value" style="font-family:monospace">${escHtml(inc.incidentId)}</span>
      </div>
      <div class="incident-row">
        <span class="incident-label">Service</span>
        <span class="incident-value">${escHtml(inc.serviceName)}</span>
        <span class="sev-badge sev--${inc.severity}">${inc.severity}</span>
      </div>
      <div class="incident-row">
        <span class="incident-label">Endpoint</span>
        <span class="incident-value" style="font-family:monospace">${escHtml(inc.endpoint)}</span>
        <span class="incident-value" style="color:var(--red)">${inc.httpStatus}</span>
      </div>
      <div class="incident-row">
        <span class="incident-label">Error</span>
        <span class="incident-value" style="color:var(--red);font-family:monospace">${escHtml(inc.errorMessage)}</span>
      </div>

      ${hasMetrics ? `
        <div class="metrics-row">
          <div class="metric-chip"><span>Error rate: </span>${(m.errorRate * 100).toFixed(0)}%</div>
          <div class="metric-chip"><span>Affected: </span>${m.affectedUsersPercent}%</div>
          <div class="metric-chip"><span>p99: </span>${m.p99LatencyMs}ms</div>
          <div class="metric-chip"><span>Failed: </span>${m.failedRequests}/${m.totalRequests}</div>
        </div>
      ` : `
        <div class="metrics-row">
          <div class="metric-chip"><span>Traffic metrics: </span>not reported by ${escHtml(inc.serviceName)}</div>
        </div>
      `}

      ${triage ? `
        <div style="margin-top:10px;font-size:12px">
          <span style="color:var(--muted)">Root cause: </span>
          <span style="font-family:monospace">${escHtml(triage.rootCauseFile)}</span>
          <span style="color:var(--muted)"> · </span>
          <span style="font-family:monospace">${escHtml(triage.suspectFunction)}()</span>
          <span style="color:var(--muted)"> L${triage.lineStart}–${triage.lineEnd}</span>
        </div>
        <div style="font-size:12px;color:var(--muted);margin-top:4px">${escHtml(triage.explanation)}</div>
      ` : ''}

      ${treatment ? `
        <div class="confidence-bar-wrap">
          <div class="confidence-label">Patch confidence: ${confidencePct}%</div>
          <div class="confidence-bar">
            <div class="confidence-fill" style="width:${confidencePct}%"></div>
          </div>
        </div>
        <div class="diff-block">${renderDiff(treatment.gitDiff)}</div>
      ` : ''}

      <div class="stack-trace">${escHtml(inc.stackTrace)}</div>
    </section>`;
}

window.__IncidentDetail = { render: renderIncidentDetail };
