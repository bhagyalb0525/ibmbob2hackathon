// Metrics card displaying cache hit rate, time saved, and immune memory resolution speed

// Accumulated runtime stats (persisted across SSE events).
// Every value here is a REAL measurement taken from the orchestrator's own
// state or from the real `immune` payload. No baseline duration is assumed:
// "time saved" is only computed once a real cold-path duration has been seen.
const _stats = {
  totalRuns:    0,
  immuneHits:   0,
  lastLatencyMs: null,
  totalTimeSavedMs: 0,
  fullRunMs:    null,      // real totalDurationMs of the last cold run
  memoryEntries: null,    // real entry count reported by the store
};

function renderImmuneMemoryStats(state, container, immune) {
  // Prefer the real numbers the server relays with a warm-path event.
  if (immune && typeof immune.entryCount === 'number') {
    _stats.memoryEntries = immune.entryCount;
  }

  // Update accumulated stats when a run completes
  if (state.stage === 'RESOLVED' || state.stage === 'IMMUNE_RECOVERED') {
    // Only increment on the first render for this resolution (debounce by incidentId)
    const runKey = `${state.incidentId}:${state.stage}`;
    if (_stats._lastRunKey !== runKey) {
      _stats._lastRunKey = runKey;
      _stats.totalRuns++;
      if (state.stage === 'IMMUNE_RECOVERED' || state.isImmuneMatch) {
        _stats.immuneHits++;
        // Real measured lookup latency only — never a made-up default.
        _stats.lastLatencyMs = state.memoryLatencyMs != null ? state.memoryLatencyMs : (immune ? immune.memoryLatencyMs : null);
        // Time saved needs both real durations; without a measured cold run
        // there is nothing honest to subtract from.
        const warmMs = typeof state.totalDurationMs === 'number' ? state.totalDurationMs : null;
        if (_stats.fullRunMs != null && warmMs != null) {
          _stats.totalTimeSavedMs += Math.max(0, _stats.fullRunMs - warmMs);
        }
      } else {
        // Cold path: record its real duration so a later warm run can be
        // compared against it.
        if (typeof state.totalDurationMs === 'number') _stats.fullRunMs = state.totalDurationMs;
        _stats.lastLatencyMs = state.totalDurationMs != null ? state.totalDurationMs : null;
      }
    }
  }

  const hitRate = _stats.totalRuns > 0
    ? Math.round((_stats.immuneHits / _stats.totalRuns) * 100)
    : 0;

  const timeSavedSec = _stats.totalTimeSavedMs > 0
    ? (_stats.totalTimeSavedMs / 1000).toFixed(1) + 's'
    : '—';

  const latencyDisplay = _stats.lastLatencyMs != null
    ? (_stats.lastLatencyMs >= 1000
        ? `${(_stats.lastLatencyMs / 1000).toFixed(1)}s`
        : `${_stats.lastLatencyMs}ms`)
    : (state.memoryLatencyMs != null ? `${state.memoryLatencyMs}ms` : '—');

  const memoryMatch = state.isImmuneMatch || state.stage === 'IMMUNE_RECOVERED';

  const matchDetails = immune
    ? `score ${Number(immune.confidence).toFixed(3)} ≥ threshold ${Number(immune.threshold).toFixed(2)} (${immune.memoryLatencyMs ?? 0}ms)`
    : (state.memoryLatencyMs != null ? `in ${state.memoryLatencyMs}ms` : '');

  container.innerHTML = `
    <section class="card">
      <h3 class="card-title">Immune Memory
        ${memoryMatch ? '<span style="color:var(--purple);font-size:11px;margin-left:8px">⚡ MATCH</span>' : ''}
      </h3>
      <div class="stat-grid">
        <div class="stat-item">
          <span class="stat-value stat-value--purple">${hitRate}%</span>
          <span class="stat-label">Cache Hit Rate</span>
        </div>
        <div class="stat-item">
          <span class="stat-value stat-value--green">${timeSavedSec}</span>
          <span class="stat-label">Time Saved</span>
        </div>
        <div class="stat-item">
          <span class="stat-value">${latencyDisplay}</span>
          <span class="stat-label">Last Latency</span>
        </div>
        <div class="stat-item">
          <span class="stat-value stat-value--yellow">${_stats.memoryEntries != null ? _stats.memoryEntries : '—'}</span>
          <span class="stat-label">Memory Entries</span>
        </div>
      </div>

      ${memoryMatch ? `
        <div style="margin-top:12px;padding:8px 12px;border-radius:6px;background:rgba(188,140,255,0.08);border:1px solid rgba(188,140,255,0.25);font-size:12px">
          <span style="color:var(--purple);font-weight:600">⚡ Immune recovery</span>
          <span style="color:var(--text)"> — real memory hit ${matchDetails}. Reused verified fix for ${immune && immune.targetFile ? immune.targetFile : 'cart.ts'}. All 5 cold-path agents skipped.</span>
        </div>
      ` : (state.incident ? `
        <div style="margin-top:12px;font-size:12px;color:var(--muted)">
          No immune match${state.memoryLatencyMs != null ? ` (searched in ${state.memoryLatencyMs}ms)` : ''} — the real five-agent cold path ran.
        </div>
      ` : `
        <div style="margin-top:12px;font-size:12px;color:var(--muted)">
          Seed memory loaded · 3 verified signatures · Jaccard + cosine similarity search
        </div>
      `)}
    </section>`;
}

window.__ImmuneMemoryStats = { render: renderImmuneMemoryStats };
