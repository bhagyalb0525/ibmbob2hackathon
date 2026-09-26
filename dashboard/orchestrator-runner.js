// ===========================================================================
// REGEN orchestrator runner — child process entry point (Phase 3 & 4).
//
// Runs the EXISTING, UNMODIFIED agents/orchestrator.ts and streams its real
// PipelineState back to dashboard/server.js over the standard Node IPC channel.
//
// WHY A CHILD PROCESS?
//   VerificationAgent executes the test suite with
//   child_process.spawnSync('npm', ['run','test:demo'], ...) — a *synchronous*
//   call that blocks the Node event loop for the entire jest run (up to the
//   90s PIPELINE_TIMEOUT_MS). Running the orchestrator inside the HTTP server
//   process would therefore freeze /events, /api/shopflow/checkout and every
//   other request for the whole verification stage, and the dashboard could
//   not show the real-time stage progression it is supposed to show.
//   In a child process only the child blocks; the dashboard server stays live
//   and can relay each real state update over the existing SSE transport.
//
// Phase 4 addition:
//   When a cold-path run calls recordFix(), the runner intercepts it and sends
//   the new ImmuneMemoryEntry back to the parent (kind: 'memoryEntry'). The
//   parent persists it to a local JSON file and passes storePath to the next
//   fork, so a warm-path run genuinely finds the stored entry and takes the
//   IMMUNE_RECOVERED fast path — exactly as the project plan specifies.
//
// This file adds no pipeline logic. It only:
//   1. constructs the real Orchestrator with the real IncidentPayload,
//   2. observes the existing emitStateUpdate() and recordFix() hooks, and
//   3. relays snapshots of the real state (and new memory entries) to the parent.
// ===========================================================================

'use strict';

const REPO_ROOT = require('path').resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// IPC helpers
// ---------------------------------------------------------------------------
function send(message) {
  if (typeof process.send === 'function') {
    try {
      process.send(message);
    } catch (_) {
      /* parent went away */
    }
  }
}

/**
 * Observe the orchestrator's EXISTING emitStateUpdate() hook.
 *
 * `emitStateUpdate` is declared `private` in TypeScript, which is a
 * compile-time-only constraint — at runtime it is an ordinary prototype
 * method. Assigning an own property shadows it for this instance only, so
 * agents/orchestrator.ts stays byte-for-byte unmodified while every real
 * stage transition is still observed exactly where the pipeline already
 * announces it.
 *
 * Phase 4: we also shadow `recordVerifiedFix` (the private method that calls
 * this.memoryStore.recordFix) to send the new ImmuneMemoryEntry back to the
 * parent process, enabling cross-run persistence without modifying any agent
 * or memory file.
 *
 * The original method is always called first, so its console output and any
 * future behaviour are preserved. The real state object is never mutated.
 */
function observeStateUpdates(orchestrator) {
  const original = orchestrator.emitStateUpdate;

  /**
   * Real warm-path metadata, read from the orchestrator itself.
   * Returns null unless the run genuinely took the immune-memory fast path.
   */
  function readImmunePayload() {
    try {
      const recovery = orchestrator.getImmuneRecovery && orchestrator.getImmuneRecovery();
      if (!recovery || !recovery.matched) return null;
      return {
        matched: true,
        // Real score from ImmuneMemoryStore.findMatch()
        confidence: recovery.confidence,
        // Real measured lookup latency from findMatch()
        memoryLatencyMs: recovery.memoryLatencyMs,
        // Real threshold that was applied
        threshold: recovery.threshold,
        // The actual matched entry, exactly as stored
        entry: recovery.entry,
        // Whether the stored diff was genuinely written to disk
        fixApplied: recovery.fixApplied,
        targetFile: recovery.targetFile,
        // The actual stored diff that was reused
        reusedDiff: recovery.reusedDiff,
        error: recovery.error || null,
        // Real number of entries in the store this run loaded
        entryCount: orchestrator.getMemoryEntryCount ? orchestrator.getMemoryEntryCount() : null,
        // The five cold-path agents that did NOT run
        skippedAgents: [
          'TriageAgent',
          'DiagnosticAgent',
          'TreatmentAgent',
          'VerificationAgent',
          'ScribeAgent',
        ],
      };
    } catch (_) {
      return null;
    }
  }

  orchestrator.emitStateUpdate = function observedEmitStateUpdate() {
    if (typeof original === 'function') {
      original.call(this);
    }
    try {
      const state = this.getState();
      // `immune` is a sibling of `state`, so shared/types.ts needs no changes.
      const message = { kind: 'state', state };
      const immune = readImmunePayload();
      if (immune) message.immune = immune;
      send(message);
    } catch (err) {
      send({
        kind: 'log',
        level: 'warn',
        message: `[runner] could not serialise pipeline state: ${err && err.message}`,
      });
    }
  };

  // Phase 4: intercept recordVerifiedFix (private but accessible at runtime)
  // to relay the ACTUAL stored entry to the parent for cross-run persistence.
  const originalRecordFix = orchestrator.recordVerifiedFix;
  orchestrator.recordVerifiedFix = function observedRecordVerifiedFix() {
    // Snapshot the store BEFORE the real method runs so we can identify the
    // entry it genuinely adds, rather than reconstructing one.
    let beforeIds = [];
    try {
      const store = this.memoryStore;
      if (store && typeof store.getAll === 'function') {
        beforeIds = store.getAll().map(e => e.id);
      }
    } catch (_) {
      /* store not reachable — fall back to id matching below */
    }

    if (typeof originalRecordFix === 'function') {
      originalRecordFix.call(this);
    }

    // Send the real entry as recorded by the real ImmuneMemoryStore.
    try {
      const store = this.memoryStore;
      if (!store || typeof store.getAll !== 'function') return;

      const all = store.getAll();
      const added = all.filter(e => !beforeIds.includes(e.id));
      const state = this.getState();
      const incident = state.incident;
      const preferredId = incident ? `regen_${incident.incidentId}` : null;

      const entry =
        added[0] ||
        (preferredId ? all.find(e => e.id === preferredId) : undefined);

      if (entry) {
        send({ kind: 'memoryEntry', entry, entryCount: all.length });
      } else {
        send({
          kind: 'log',
          level: 'warn',
          message: '[runner] recordFix ran but no new entry was found in the store',
        });
      }
    } catch (err) {
      send({
        kind: 'log',
        level: 'warn',
        message: `[runner] could not relay memory entry: ${err && err.message}`,
      });
    }
  };
}

// ---------------------------------------------------------------------------
// Real pipeline execution
// ---------------------------------------------------------------------------
async function runRealPipeline(incident, options) {
  // Resolved through the ts-node require hook installed by the parent's
  // execArgv (-r ts-node/register/transpile-only -r tsconfig-paths/register).
  // The @shared/* path aliases used by the orchestrator resolve via
  // tsconfig-paths, exactly as they do for `npm run run:pipeline`.
  const { Orchestrator } = require('../agents/orchestrator');

  // Real signature: the incident is passed to the CONSTRUCTOR and
  // runPipeline() takes no arguments.
  const orchestrator = new Orchestrator(incident, options || {});
  observeStateUpdates(orchestrator);

  const finalState = await orchestrator.runPipeline();
  return finalState;
}

// ---------------------------------------------------------------------------
// Message loop
// ---------------------------------------------------------------------------
process.on('message', async message => {
  if (!message || message.kind !== 'run') return;

  try {
    const state = await runRealPipeline(message.incident, message.options);
    send({ kind: 'done', state });
    process.exitCode = 0;
  } catch (err) {
    // Never swallow: report the real error so the dashboard can show a
    // failure state instead of claiming success.
    send({
      kind: 'error',
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : null,
    });
    process.exitCode = 1;
  } finally {
    // Give the IPC channel a tick to flush before tearing the process down.
    setTimeout(() => process.exit(process.exitCode || 0), 50);
  }
});

// If the parent dies mid-run, do not leave an orphan jest/pipeline behind.
process.on('disconnect', () => process.exit(0));

module.exports = { runRealPipeline, REPO_ROOT };
