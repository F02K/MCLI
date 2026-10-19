export interface Term {
  readonly cols: number;
  readonly rows: number;
  write(s: string): void;
  onData(cb: (data: string) => void): void;
  onResize(cb: () => void): void;
  open(): void;
  close(): void;
}

/** The real terminal: alternate screen, raw keyboard input, mouse reporting. */
export function createRealTerm(): Term {
  const { stdin, stdout } = process;
  let opened = false;
  const restore = () => term.close();
  const term: Term = {
    get cols() {
      return stdout.columns || 80;
    },
    get rows() {
      return stdout.rows || 24;
    },
    write: (s) => void stdout.write(s),
    onData: (cb) => {
      stdin.setEncoding('utf8');
      stdin.on('data', cb);
    },
    onResize: (cb) => void stdout.on('resize', cb),
    open: () => {
      if (opened) return;
      opened = true;
      // alt screen, hide cursor, no auto-wrap, mouse (clicks + wheel, SGR encoding), window title
      stdout.write('\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1000h\x1b[?1006h\x1b]0;MCLI\x07');
      stdin.setRawMode(true);
      stdin.resume();
      process.on('exit', restore);
    },
    close: () => {
      if (!opened) return;
      opened = false;
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\x1b[?1006l\x1b[?1000l\x1b[?7h\x1b[0m\x1b[?25h\x1b[?1049l');
    },
  };
  return term;
}
