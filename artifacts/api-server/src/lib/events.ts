import { EventEmitter } from "node:events";

/**
 * Process-local event bus for run SSE streams. Keyed by runId.
 * Used by the run engine to push real-time events to /runs/:id/events.
 */
class RunEventBus extends EventEmitter {
  emitRunEvent(runId: string, payload: unknown): void {
    this.emit(`run:${runId}`, payload);
  }

  subscribe(runId: string, handler: (payload: unknown) => void): () => void {
    const channel = `run:${runId}`;
    this.on(channel, handler);
    return () => this.off(channel, handler);
  }
}

export const runEvents = new RunEventBus();
runEvents.setMaxListeners(0);
