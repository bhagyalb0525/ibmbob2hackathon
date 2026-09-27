// Incident view displaying root cause diagnosis, proposed code diff, and patch confidence score

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
        <p style="color:var(--muted);font-size:13px">No active incident — trigger a pipeline run to begin.</p>
      </section>`;
    return;
  }

  const treatment = state.results && state.results.treatment;
  const triage    = state.results && state.results.triage;
  const verification = state.results && state.results.verification;

  const confidencePct = treatment ? Math.round(treatment.confidenceScore * 100) : null;

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

      <div class="metrics-row">
        <div class="metric-chip"><span>Error rate: </span>${(inc.metrics.errorRate * 100).toFixed(0)}%</div>
        <div class="metric-chip"><span>Affected: </span>${inc.metrics.affectedUsersPercent}%</div>
        <div class="metric-chip"><span>p99: </span>${inc.metrics.p99LatencyMs}ms</div>
        <div class="metric-chip"><span>Failed: </span>${inc.metrics.failedRequests}/${inc.metrics.totalRequests}</div>
      </div>

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

      ${verification && verification.patchApplied ? `
        <div style="margin-top:10px;padding:8px 12px;border-radius:6px;background:rgba(63,185,80,0.1);border:1px solid rgba(63,185,80,0.3);font-size:12px">
          <span style="color:var(--green);font-weight:600">✓ Fix Applied</span>
          <span style="color:var(--text)"> — patch verified and deployed to ${escHtml(treatment ? treatment.targetFile : 'target file')}</span>
        </div>
      ` : ''}

      <div class="stack-trace">${escHtml(inc.stackTrace)}</div>
    </section>`;
}

window.__IncidentDetail = { render: renderIncidentDetail };
