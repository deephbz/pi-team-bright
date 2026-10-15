import { createHash } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// Load alongside normal PTB, not instead of it. Does not install itself.
export default function diagnostics(pi: ExtensionAPI) {
  const record = (event: string, fields?: Record<string, unknown>) => {
    (globalThis as typeof globalThis & {
      __ptbFreezeRecord?: (event: string, fields?: Record<string, unknown>) => void;
    }).__ptbFreezeRecord?.(event, fields);
  };
  pi.on('session_start', () => { record('session_start'); });
  pi.on('session_shutdown', () => { record('session_shutdown'); });
  pi.on('agent_start', () => { record('agent_start'); });
  pi.on('agent_end', () => { record('agent_end'); });
  const toolFields = (event: { toolCallId: string; toolName: string }) => ({
    call: createHash('sha256').update(event.toolCallId).digest('hex').slice(0, 16),
    tool: /^[a-zA-Z0-9_-]{1,64}$/.test(event.toolName) ? event.toolName : 'other',
  });
  pi.on('tool_execution_start', event => { record('tool_begin', toolFields(event)); });
  pi.on('tool_execution_end', event => {
    record('tool_end', { ...toolFields(event), isError: event.isError });
  });
}
