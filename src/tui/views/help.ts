import { join } from 'node:path';
import { CONFIG_FILE } from '../../config';
import { VERSION } from '../../version';
import { box, paint, theme } from '../draw';
import type { KeyEvent, MouseEvent } from '../input';
import type { UiHost, View, ViewFrame } from '../types';

export class HelpView implements View {
  readonly id = 'help';
  readonly title = 'Help';
  private scroll = 0;

  constructor(private ui: UiHost) {}

  hints(): string {
    return '↑↓ scroll';
  }

  private content(): string[] {
    const h = (t: string) => paint(t, theme.accent, theme.bold);
    const k = (key: string, text: string) => `  ${paint(key.padEnd(18), theme.warn)}${text}`;
    const cfg = this.ui.core.cfg;
    return [
      h('Navigation'),
      k('Tab / Shift+Tab', 'next / previous view'),
      k('F1-F7, Alt+1-7', 'jump to a view'),
      k('Mouse', 'click tabs and buttons, wheel scrolls lists and the console'),
      k('Ctrl+C or Q', 'quit (asks first while the server is running; again = force)'),
      '',
      h('Dashboard'),
      k('S / X / R', 'start / stop / restart the server'),
      k('B', 'create a backup'),
      k('C', 'open the console'),
      k('E / V / G / J / K', 'fix a listed problem: accept EULA / Versions / Settings / install Java / Backups'),
      '',
      h('Console'),
      k('Enter', 'send text to the server console'),
      k(':start :stop ...', 'MCLI commands start with a colon: :start :stop :restart :backup :status :quit'),
      k('Up / Down', 'command history'),
      k('PgUp / PgDn', 'scroll the log (Ctrl+L = jump to latest and clear filter)'),
      k('Ctrl+F', 'filter log lines'),
      '',
      h('Players'),
      k('Left / Right', 'switch between online players, whitelist, operators, bans'),
      k('Enter', 'open the action menu for the selected player'),
      k('K B O D W M', 'kick, ban, op, deop, whitelist, message (online players)'),
      k('A / X / T', 'add / remove an entry, toggle the whitelist'),
      '',
      h('Settings'),
      k('Enter / Space', 'change the selected value (booleans toggle, choices open a menu)'),
      k('/', 'filter server.properties keys'),
      '',
      h('Versions (download and update server software)'),
      k('I', 'install or switch: Paper, Vanilla, Fabric or Forge, any Minecraft version'),
      k('U', 'update to the newest build, or to the newest Minecraft version'),
      k('V / R', 'deep-check the server jar / re-download it'),
      k('J', 'Java: see all installs, pick one, or download a missing version'),
      k('E', 'accept the Minecraft EULA'),
      k(':install paper 1.21.8', 'the same from the console (also :versions :update :verify :repair :java)'),
      '',
      h('Backups'),
      k('N / R / D / O', 'new backup / restore / delete / open folder'),
      '',
      h('About'),
      `  MCLI ${VERSION} - Minecraft server manager`,
      `  Config file:   ${join(cfg.configDir, CONFIG_FILE)}`,
      `  Server folder: ${cfg.serverDir}`,
      `  Backups:       ${this.ui.core.backups.dir}`,
    ];
  }

  onKey(k: KeyEvent): boolean {
    const max = Math.max(0, this.content().length - 5);
    if (k.name === 'up') this.scroll--;
    else if (k.name === 'down') this.scroll++;
    else if (k.name === 'pgup') this.scroll -= 10;
    else if (k.name === 'pgdn') this.scroll += 10;
    else if (k.name === 'home') this.scroll = 0;
    else if (k.name === 'end') this.scroll = max;
    else return false;
    this.scroll = Math.max(0, Math.min(max, this.scroll));
    return true;
  }

  onMouse(e: MouseEvent): void {
    if (e.action === 'wheel-up') this.scroll = Math.max(0, this.scroll - 3);
    else if (e.action === 'wheel-down') this.scroll = Math.min(Math.max(0, this.content().length - 5), this.scroll + 3);
    this.ui.render();
  }

  render(w: number, h: number): ViewFrame {
    const lines = this.content().slice(this.scroll, this.scroll + h - 2);
    return { lines: box(lines, w, h, { title: 'Help' }) };
  }
}
