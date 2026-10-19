import { saveConfigValue, type EditableConfigKey } from '../../config';
import { metaFor, Properties, type PropType } from '../../properties';
import { box, highlight, pad, paint, theme } from '../draw';
import type { KeyEvent, MouseEvent } from '../input';
import { inputModal, menuModal } from '../modal';
import type { UiHost, View, ViewFrame } from '../types';
import { ListState } from './util';

interface Row {
  key: string;
  value: string;
  type: PropType;
  options?: string[];
  desc: string;
  save(value: string): void;
}

const MCLI_FIELDS: { key: EditableConfigKey; type: PropType; desc: string; validate?: (v: string) => string | null }[] = [
  { key: 'java', type: 'string', desc: 'Path to a fixed java executable. Empty = MCLI finds or installs a fitting Java per server (recommended).' },
  { key: 'javaAutoInstall', type: 'bool', desc: 'Download and install a missing Java version automatically (Eclipse Temurin) instead of asking first.' },
  { key: 'minMemory', type: 'string', desc: 'Initial JVM heap (-Xms), e.g. 1G or 512M. Not used for Forge/NeoForge (user_jvm_args.txt).', validate: (v) => (/^\d+[KMGkmg]$/.test(v) || v === '' ? null : 'Use a number with K, M or G (e.g. 2G)') },
  { key: 'maxMemory', type: 'string', desc: 'Maximum JVM heap (-Xmx), e.g. 4G. Not used for Forge/NeoForge (user_jvm_args.txt).', validate: (v) => (/^\d+[KMGkmg]$/.test(v) || v === '' ? null : 'Use a number with K, M or G (e.g. 4G)') },
  { key: 'autoRestart', type: 'bool', desc: 'Restart the server automatically after a crash.' },
  { key: 'maxRestarts', type: 'int', desc: 'Give up after this many crashes in a row.' },
  { key: 'backupIntervalMinutes', type: 'int', desc: 'Automatic backup every N minutes while the server runs (0 = off).' },
  { key: 'backupKeep', type: 'int', desc: 'Keep only the newest N backups (0 = keep all).' },
];

type Section = 'properties' | 'mcli';

export class SettingsView implements View {
  readonly id = 'settings';
  readonly title = 'Settings';
  private section: Section = 'properties';
  private lists: Record<Section, ListState> = { properties: new ListState(), mcli: new ListState() };
  private filter = '';
  private props: Properties;

  constructor(private ui: UiHost) {
    this.props = new Properties(ui.core.cfg.serverDir);
  }

  onShow(): void {
    this.props.reload();
  }

  hints(): string {
    const f = this.section === 'properties' ? ' · / filter' : '';
    return `←→ section · ↑↓ select · Enter/Space change${f} · R reload`;
  }

  private rows(): Row[] {
    if (this.section === 'mcli') {
      const cfg = this.ui.core.cfg;
      return MCLI_FIELDS.map((f) => ({
        key: f.key,
        value: String(cfg[f.key]),
        type: f.type,
        desc: f.desc,
        save: (v: string) => {
          const value = f.type === 'bool' ? v === 'true' : f.type === 'int' ? Number(v) : v;
          saveConfigValue(cfg, f.key, value);
        },
      }));
    }
    const needle = this.filter.toLowerCase();
    return this.props
      .entries()
      .filter((e) => !needle || e.key.toLowerCase().includes(needle))
      .map((e) => {
        const meta = metaFor(e.key, e.value);
        return { key: e.key, value: e.value, type: meta.type, options: meta.options, desc: meta.desc, save: (v: string) => this.props.set(e.key, v) };
      });
  }

  private edit(row: Row): void {
    const done = (v: string) => {
      try {
        row.save(v);
      } catch (err) {
        this.ui.toast(`Could not save: ${(err as Error).message}`, 'error');
        return;
      }
      const running = this.ui.core.server.state !== 'stopped';
      this.ui.toast(`Saved ${row.key} = ${v}${running ? ' (applies after a server restart)' : ''}`, 'ok');
    };
    if (row.type === 'bool') return done(row.value === 'true' ? 'false' : 'true');
    if (row.type === 'enum' && row.options) {
      const items = row.options.map((o) => ({ label: o, value: o, hint: o === row.value ? '(current)' : '' }));
      this.ui.modal(menuModal(row.key, items, done, Math.max(0, row.options.indexOf(row.value))));
      return;
    }
    const field = this.section === 'mcli' ? MCLI_FIELDS.find((f) => f.key === row.key) : undefined;
    const validate = (v: string): string | null => {
      if (row.type === 'int' && !/^-?\d+$/.test(v.trim())) return 'Enter a whole number';
      if (row.type === 'int' && this.section === 'mcli' && Number(v) < 0) return 'Must be 0 or greater';
      return field?.validate?.(v.trim()) ?? null;
    };
    this.ui.modal(inputModal(row.key, row.value, (v) => done(row.type === 'int' || field ? v.trim() : v), { label: row.desc, validate }));
  }

  onKey(k: KeyEvent): boolean {
    const rows = this.rows();
    const list = this.lists[this.section];
    if (k.name === 'left' || k.name === 'right') {
      this.section = this.section === 'properties' ? 'mcli' : 'properties';
      return true;
    }
    if (list.handle(k, rows.length, 10)) return true;
    if (k.name === 'enter' || (k.name === 'char' && k.ch === ' ')) {
      const row = rows[list.selected];
      if (row) this.edit(row);
      return true;
    }
    if (k.name === 'escape' && this.filter) {
      this.filter = '';
      return true;
    }
    if (k.name === 'char') {
      const c = k.ch!.toLowerCase();
      if (c === 'r') {
        this.props.reload();
        this.ui.toast('Reloaded settings from disk.', 'info');
        return true;
      }
      if (c === '/' && this.section === 'properties') {
        this.ui.modal(inputModal('Filter settings', this.filter, (v) => {
          this.filter = v.trim();
          this.lists.properties = new ListState();
        }, { label: 'Show only keys containing (empty = all):' }));
        return true;
      }
    }
    return false;
  }

  onMouse(e: MouseEvent, x: number, y: number): void {
    const rows = this.rows();
    const list = this.lists[this.section];
    if (e.action === 'wheel-up') list.wheel(-1, rows.length);
    else if (e.action === 'wheel-down') list.wheel(1, rows.length);
    else if (e.action === 'down' && e.button === 0) {
      if (y === 0) {
        const mcliStart = 1 + ' server.properties '.length + 1;
        this.section = x >= mcliStart ? 'mcli' : 'properties';
      } else if (y >= 3) {
        list.selected = list.offset + (y - 3);
        list.clamp(rows.length);
      }
    }
    this.ui.render();
  }

  private valueText(row: Row, w: number): string {
    const v = row.value;
    if (row.type === 'bool') return v === 'true' ? paint('● true', theme.ok) : paint('○ false', theme.muted);
    if (row.type === 'int') return paint(v, theme.accent);
    return v === '' ? paint('(empty)', theme.dim) : pad(v, w);
  }

  render(w: number, h: number): ViewFrame {
    const tab = (label: string, active: boolean) => (active ? paint(` ${label} `, '38;5;255', theme.selBg, theme.bold) : paint(` ${label} `, theme.muted));
    const tabs = ' ' + tab('server.properties', this.section === 'properties') + ' ' + tab('MCLI', this.section === 'mcli');

    const rows = this.rows();
    const list = this.lists[this.section];
    const detailH = 5;
    const tableH = h - 1 - detailH; // outer box height of the list
    const bodyH = tableH - 3; // minus borders and header
    const inner = w - 2;
    const keyW = Math.min(34, Math.floor(inner * 0.4));
    const valW = inner - keyW - 3;
    const lines: string[] = [paint(pad(` ${'SETTING'.padEnd(keyW)} VALUE`, inner), theme.muted, theme.bold)];

    if (this.section === 'properties' && !this.props.exists) {
      lines.push('');
      lines.push(paint(' server.properties not found.', theme.warn));
      lines.push(paint(` Start the server once so it generates ${this.props.path}`, theme.muted));
    } else if (!rows.length) {
      lines.push('');
      lines.push(paint(' No settings match the filter.', theme.muted));
    } else {
      const start = list.window(bodyH, rows.length);
      for (let i = start; i < Math.min(rows.length, start + bodyH); i++) {
        const r = rows[i];
        const line = ` ${pad(r.key, keyW)} ${this.valueText(r, valW)}`;
        lines.push(i === list.selected ? highlight(line, inner) : line);
      }
    }
    const title = this.section === 'properties' ? 'server.properties' + (this.filter ? ` · filter "${this.filter}"` : '') : 'MCLI settings (mcli.json)';
    const right = rows.length ? `${list.selected + 1}/${rows.length}` : '';
    const listBox = box(lines, w, tableH, { title, titleRight: right });

    const sel = rows[list.selected];
    const detail: string[] = sel
      ? [` ${paint(sel.key, theme.accent, theme.bold)}  ${paint(`(${sel.type}${sel.options ? ': ' + sel.options.join(' / ') : ''})`, theme.muted)}`, ` ${sel.desc}`]
      : [];
    if (this.ui.core.server.state !== 'stopped' && this.section === 'properties') detail.push(paint(' The server is running: changes apply after a restart.', theme.warn));
    const detailBox = box(detail, w, detailH, { title: 'Details' });
    return { lines: [tabs, ...listBox, ...detailBox] };
  }
}
