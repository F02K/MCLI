import type { ServerState } from '../server';
import { theme } from './draw';

const STATE_STYLE: Record<ServerState, { icon: string; label: string; color: string }> = {
  running: { icon: '●', label: 'RUNNING', color: theme.ok },
  starting: { icon: '◐', label: 'STARTING', color: theme.warn },
  stopping: { icon: '◑', label: 'STOPPING', color: theme.warn },
  stopped: { icon: '○', label: 'STOPPED', color: theme.err },
};

export const stateStyle = (s: ServerState) => STATE_STYLE[s];
