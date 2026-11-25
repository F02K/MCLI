/** Terminal color and cursor sequences such as ESC[93m. Servers print them even when not on a terminal. */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export const stripAnsi = (text: string): string => text.replace(ANSI_RE, '');
