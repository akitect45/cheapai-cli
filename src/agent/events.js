export const AGENT_EVENT_TYPES = Object.freeze([
  'agent_start',
  'turn_start',
  'message_start',
  'message_delta',
  'message_end',
  'reasoning_delta',
  'tool_preflight',
  'tool_start',
  'tool_update',
  'tool_end',
  'turn_end',
  'agent_end',
  'notice',
]);

export function createEventStream({ sessionId, runId } = {}) {
  let sequence = 0;
  const subscribers = new Set();

  return {
    emit(type, data = {}, ids = {}) {
      if (!AGENT_EVENT_TYPES.includes(type)) throw new Error(`Unknown agent event: ${type}`);
      const event = Object.freeze({
        type,
        sessionId: ids.sessionId || sessionId || null,
        runId: ids.runId || runId || null,
        turnId: ids.turnId || null,
        sequence: ++sequence,
        timestamp: new Date().toISOString(),
        data,
      });
      for (const subscriber of [...subscribers]) {
        try {
          subscriber(event);
        } catch {
          // A presentation subscriber cannot corrupt runtime execution.
        }
      }
      return event;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Event subscriber must be a function.');
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    get sequence() {
      return sequence;
    },
    clear() {
      subscribers.clear();
    },
  };
}
