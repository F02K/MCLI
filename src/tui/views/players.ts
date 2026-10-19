import { readList, type ListEntry, type ListKind } from '../../players';
import { box, fmtDuration, paint, theme } from '../draw';
import type { KeyEvent, MouseEvent } from '../input';
import { confirmModal, inputModal, menuModal } from '../modal';
import type { UiHost, View, ViewFrame } from '../types';
import { ListState, renderTable } from './util';

type TabId = 'online' | 'whitelist' | 'ops' | 'bans' | 'ipbans';

const NAME_RE = /^[A-Za-z0-9_.]{1,17}$/;
const IP_RE = /^[0-9a-fA-F:.]{3,45}$/;

interface TabDef {
  id: TabId;
  title: string;
  kind?: ListKind;
  addLabel?: string;
  removeLabel?: string;
}

const TABS: TabDef[] = [
  { id: 'online', title: 'Online' },
  { id: 'whitelist', title: 'Whitelist', kind: 'whitelist', addLabel: 'Add player', removeLabel: 'Remove' },
  { id: 'ops', title: 'Operators', kind: 'ops', addLabel: 'Op player', removeLabel: 'Deop' },
  { id: 'bans', title: 'Bans', kind: 'banned-players', addLabel: 'Ban player', removeLabel: 'Pardon' },
  { id: 'ipbans', title: 'IP bans', kind: 'banned-ips', addLabel: 'Ban IP', removeLabel: 'Pardon' },
];

export class PlayersView implements View {
  readonly id = 'players';
  readonly title = 'Players';
  private tab = 0;
  private list = new ListState();
  private cache = new Map<ListKind, { at: number; rows: ListEntry[] }>();

  constructor(private ui: UiHost) {}

  badge(): string {
    const n = this.ui.core.players.online.size;
    return n ? paint(String(n), theme.ok) : '';
  }

  hints(): string {
    const t = TABS[this.tab];
    const nav = '←→ section · ↑↓ select · Enter actions';
    if (t.id === 'online') return `${nav} · K kick · B ban · O op · D deop · W whitelist · M message`;
    if (t.id === 'whitelist') return `${nav} · A add · X remove · T whitelist on/off`;
    return `${nav} · A ${t.addLabel!.toLowerCase()} · X ${t.removeLabel!.toLowerCase()}`;
  }

  private rows(tab: TabDef): ListEntry[] {
    if (tab.id === 'online') {
      return [...this.ui.core.players.online.entries()].map(([name, at]) => ({ name, detail: fmtDuration(Date.now() - at) }));
    }
    const cached = this.cache.get(tab.kind!);
    if (cached && Date.now() - cached.at < 1000) return cached.rows;
    const rows = readList(this.ui.core.cfg.serverDir, tab.kind!);
    this.cache.set(tab.kind!, { at: Date.now(), rows });
    return rows;
  }

  private selectedName(): string | null {
    return this.rows(TABS[this.tab])[this.list.selected]?.name ?? null;
  }

  /** Runs a server console command, or explains why it can not run. */
  private run(command: string, doneText: string): void {
    if (!this.ui.core.server.send(command)) {
      this.ui.toast('The server must be running for this action (Dashboard: S).', 'warn');
      return;
    }
    this.ui.toast(doneText, 'ok');
    this.cache.clear();
    setTimeout(() => {
      this.cache.clear();
      this.ui.render();
    }, 800);
  }

  private askName(title: string, ip: boolean, then: (name: string) => void, label?: string): void {
    this.ui.modal(inputModal(title, '', then, {
      label,
      validate: (v) => (ip ? (IP_RE.test(v.trim()) ? null : 'Enter a valid IP address') : NAME_RE.test(v.trim()) ? null : 'Enter a valid player name'),
    }));
  }

  private add(): void {
    const t = TABS[this.tab];
    if (t.id === 'online') return;
    if (t.id === 'whitelist') this.askName('Whitelist player', false, (n) => this.run(`whitelist add ${n.trim()}`, `Whitelisted ${n.trim()}`));
    else if (t.id === 'ops') this.askName('Op player', false, (n) => this.run(`op ${n.trim()}`, `Opped ${n.trim()}`));
    else if (t.id === 'bans') this.askName('Ban player', false, (n) => this.ban(n.trim()));
    else this.askName('Ban IP address', true, (ip) => this.run(`ban-ip ${ip.trim()}`, `Banned ${ip.trim()}`));
  }

  private ban(name: string): void {
    this.ui.modal(inputModal(`Ban ${name}`, '', (reason) => this.run(`ban ${name} ${reason.trim()}`.trim(), `Banned ${name}`), { label: 'Reason (optional):' }));
  }

  private remove(): void {
    const t = TABS[this.tab];
    const name = this.selectedName();
    if (!name || t.id === 'online') return;
    const cmd = t.id === 'whitelist' ? `whitelist remove ${name}` : t.id === 'ops' ? `deop ${name}` : t.id === 'bans' ? `pardon ${name}` : `pardon-ip ${name}`;
    this.ui.modal(confirmModal(`${t.removeLabel} ${name}`, [`${t.removeLabel} "${name}"?`], () => this.run(cmd, `${t.removeLabel}: ${name}`)));
  }

  private onlineAction(action: string, name: string): void {
    switch (action) {
      case 'kick':
        this.ui.modal(inputModal(`Kick ${name}`, '', (r) => this.run(`kick ${name} ${r.trim()}`.trim(), `Kicked ${name}`), { label: 'Reason (optional):' }));
        break;
      case 'ban':
        this.ban(name);
        break;
      case 'op':
        this.run(`op ${name}`, `Opped ${name}`);
        break;
      case 'deop':
        this.run(`deop ${name}`, `Deopped ${name}`);
        break;
      case 'whitelist':
        this.run(`whitelist add ${name}`, `Whitelisted ${name}`);
        break;
      case 'msg':
        this.ui.modal(inputModal(`Message to ${name}`, '', (m) => this.run(`msg ${name} ${m.trim()}`, `Sent message to ${name}`)));
        break;
    }
  }

  onKey(k: KeyEvent): boolean {
    const t = TABS[this.tab];
    const count = this.rows(t).length;
    if (k.name === 'left') {
      this.tab = (this.tab + TABS.length - 1) % TABS.length;
      this.list = new ListState();
      return true;
    }
    if (k.name === 'right') {
      this.tab = (this.tab + 1) % TABS.length;
      this.list = new ListState();
      return true;
    }
    if (this.list.handle(k, count, 10)) return true;

    const name = this.selectedName();
    if (k.name === 'enter' && t.id === 'online' && name) {
      this.ui.modal(menuModal(`Player ${name}`, [
        { label: 'Kick', value: 'kick' },
        { label: 'Ban', value: 'ban' },
        { label: 'Op', value: 'op' },
        { label: 'Deop', value: 'deop' },
        { label: 'Add to whitelist', value: 'whitelist' },
        { label: 'Send message', value: 'msg' },
      ], (a) => this.onlineAction(a, name)));
      return true;
    }
    if (k.name === 'delete') {
      this.remove();
      return true;
    }
    if (k.name !== 'char') return false;
    const c = k.ch!.toLowerCase();
    if (t.id === 'online' && name) {
      const map: Record<string, string> = { k: 'kick', b: 'ban', o: 'op', d: 'deop', w: 'whitelist', m: 'msg' };
      if (map[c]) {
        this.onlineAction(map[c], name);
        return true;
      }
    } else if (c === 'a' && t.id !== 'online') {
      this.add();
      return true;
    } else if (c === 'x' && t.id !== 'online') {
      this.remove();
      return true;
    }
    if (c === 't' && t.id === 'whitelist') {
      const on = this.ui.core.properties.get('white-list') === 'true';
      this.run(`whitelist ${on ? 'off' : 'on'}`, `Whitelist ${on ? 'disabled' : 'enabled'}`);
      return true;
    }
    return false;
  }

  onMouse(e: MouseEvent, x: number, y: number): void {
    const count = this.rows(TABS[this.tab]).length;
    if (e.action === 'wheel-up') this.list.wheel(-1, count);
    else if (e.action === 'wheel-down') this.list.wheel(1, count);
    else if (e.action === 'down' && e.button === 0) {
      if (y === 0) {
        let at = 1;
        TABS.forEach((t, i) => {
          const width = ` ${t.title} (${this.rows(t).length}) `.length + 1;
          if (x >= at && x < at + width) {
            this.tab = i;
            this.list = new ListState();
          }
          at += width;
        });
      } else if (y >= 3) this.list.selected = this.list.offset + (y - 3);
    }
    this.ui.render();
  }

  render(w: number, h: number): ViewFrame {
    const t = TABS[this.tab];
    const tabs = TABS.map((def, i) => {
      const label = ` ${def.title} (${this.rows(def).length}) `;
      return i === this.tab ? paint(label, '38;5;255', theme.selBg, theme.bold) : paint(label, theme.muted);
    }).join(' ');

    const rows = this.rows(t);
    const cols =
      t.id === 'online'
        ? [{ title: 'PLAYER', width: 24 }, { title: 'ONLINE FOR', width: 0 }]
        : t.id === 'whitelist'
          ? [{ title: 'PLAYER', width: 0 }]
          : t.id === 'ops'
            ? [{ title: 'PLAYER', width: 24 }, { title: 'LEVEL', width: 0 }]
            : [{ title: t.id === 'bans' ? 'PLAYER' : 'IP', width: 24 }, { title: 'REASON', width: 0 }];
    const empty =
      t.id === 'online'
        ? this.ui.core.server.state === 'stopped'
          ? 'Server is stopped - nobody is online.'
          : 'Nobody is online right now.'
        : 'Nothing here yet. Press A to add an entry.';
    const table = renderTable(cols, rows.map((r) => [r.name, r.detail]), this.list, w - 2, h - 3, empty);

    let title = t.title;
    let right = '';
    if (t.id === 'whitelist') {
      const on = this.ui.core.properties.get('white-list') === 'true';
      right = on ? 'whitelist is ON' : 'whitelist is OFF';
    }
    if (this.ui.core.server.state === 'stopped' && t.id !== 'online') right = (right ? right + ' · ' : '') + 'read-only while stopped';
    if (t.id === 'online') title = 'Online players';
    const body = box(table, w, h - 1, { title, titleRight: right });
    return { lines: [' ' + tabs, ...body] };
  }
}
