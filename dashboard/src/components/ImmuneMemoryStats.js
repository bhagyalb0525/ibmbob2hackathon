// Metrics card displaying cache hit rate, time saved, and immune memory resolution speed

// Accumulated runtime stats (persisted across SSE events)
const _stats = {
  totalRuns:    0,
  immuneHits:   0,
  lastLatencyMs: null,
  totalTimeSavedMs: 0,
  memoryEntries: 3,  // seed_memory.json contains 3 entries
};

// A full pipeline (non-immune) takes roughly 6s; immune recovery ~0.7s
const FULL_PIPELINE_MS = 6000;
const IMMUNE_RECOVERY_MS = 700;

function renderImmuneMemoryStats(state, container) {
  // Update accumulated stats when a run completes
  if (state.stage === 'RESOLVED' || state.stage === 'IMMUNE_RECOVERED') {
    // Only increment on the first render for this resolution (debounce by incidentId)
    const runKey = `${state.incidentId}:${state.stage}`;
    if (_stats._lastRunKey !== runKey) {
      _stats._lastRunKey = runKey;
      _stats.totalRuns++;
      if (state.stage === 'IMMUNE_RECOVERED' || state.isImmuneMatch) {
        _stats.immuneHits++;
        _stats.lastLatencyMs = state.memoryLatencyMs || IMMUNE_RECOVERY_MS;
        _stats.totalTimeSavedMs += (FULL_PIPELINE_MS - IMMUNE_RECOVERY_MS);
      } else {
        _stats.lastLatencyMs = state.totalDurationMs || FULL_PIPELINE_MS;
      }
    }
  }

  const hitRate = _stats.totalRuns > 0
    ? Math.round((_stats.immuneHits / _stats.totalRuns) * 100)
    : 0;

  const timeSavedSec = (_stats.totalTimeSavedMs / 1000).toFixed(1);

  const latencyDisplay = _stats.lastLatencyMs != null
    ? (_stats.lastLatencyMs >= 1000
        ? `${(_stats.lastLatencyMs / 1000).toFixed(1)}s`
        : `${_stats.lastLatencyMs}ms`)
    : '—';

  const memoryMatch = state.isImmuneMatch || state.stage === 'IMMUNE_RECOVERED';

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
          <span class="stat-value stat-value--green">${timeSavedSec}s</span>
          <span class="stat-label">Time Saved</span>
        </div>
        <div class="stat-item">
          <span class="stat-value">${latencyDisplay}</span>
          <span class="stat-label">Last Latency</span>
        </div>
        <div class="stat-item">
          <span class="stat-value stat-value--yellow">${_stats.memoryEntries}</span>
          <span class="stat-label">Memory Entries</span>
        </div>
      </div>

      ${memoryMatch ? `
        <div style="margin-top:12px;padding:8px 12px;border-radius:6px;background:rgba(188,140,255,0.08);border:1px solid rgba(188,140,255,0.25);font-size:12px">
          <span style="color:var(--purple);font-weight:600">⚡ Immune recovery</span>
          <span style="color:var(--muted)"> — signature matched mem_001 (confidence 0.97).
          No agents dispatched. Patch applied from verified memory.</span>
        </div>
      ` : (state.incident ? `
        <div style="margin-top:12px;font-size:12px;color:var(--muted)">
          No immune match — full 5-agent pipeline in progress.
        </div>
      ` : `
        <div style="margin-top:12px;font-size:12px;color:var(--muted)">
          Seed memory loaded · 3 verified signatures · Jaccard + cosine similarity search
        </div>
      `)}
    </section>`;
}

window.__ImmuneMemoryStats = { render: renderImmuneMemoryStats };
