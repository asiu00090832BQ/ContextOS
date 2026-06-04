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

/**
 * Process-local event bus for in-app chat SSE streams. Keyed by conversationId.
 * Used by the chat engine to push streaming agent replies and run-driven
 * updates to /conversations/:id/events.
 */
class ConversationEventBus extends EventEmitter {
  emitConversationEvent(conversationId: string, payload: unknown): void {
    this.emit(`conversation:${conversationId}`, payload);
  }

  subscribe(
    conversationId: string,
    handler: (payload: unknown) => void,
  ): () => void {
    const channel = `conversation:${conversationId}`;
    this.on(channel, handler);
    return () => this.off(channel, handler);
  }
}

export const conversationEvents = new ConversationEventBus();
conversationEvents.setMaxListeners(0);
