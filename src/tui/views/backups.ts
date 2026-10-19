import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import type { BackupInfo } from '../../backup';
import { box, fmtAge, fmtBytes, paint, theme } from '../draw';
import type { KeyEvent, MouseEvent } from '../input';
import { confirmModal, menuModal } from '../modal';
import type { UiHost, View, ViewFrame } from '../types';
import { ListState, renderTable } from './util';

/** Opens a folder in the system file manager. Replaceable so tests do not launch one. */
export const folderOpener = { open: openFolder };

function openFolder(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [dir], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
}

export class BackupsView implements View {
  readonly id = 'backups';
  readonly title = 'Backups';
  private items: BackupInfo[] = [];
  private list = new ListState();

  constructor(private ui: UiHost) {
    ui.core.on('backups', () => void this.reload());
  }

  badge(): string {
    return this.ui.core.backups.busy ? paint('…', theme.warn) : '';
  }

  hints(): string {
    return '↑↓ select · Enter actions · N new backup · R restore · D delete · O open folder';
  }

  onShow(): void {
    void this.reload();
  }

  private async reload(): Promise<void> {
    this.items = await this.ui.core.backups.list();
    this.list.clamp(this.items.length);
    this.ui.render();
  }

  private selected(): BackupInfo | undefined {
    return this.items[this.list.selected];
  }

  private create(): void {
    if (this.ui.core.backups.busy) return void this.ui.toast(`Busy: ${this.ui.core.backups.busy}`, 'warn');
    this.ui.toast('Backup started...', 'info');
    void this.ui.core.backups.create().then((b) => {
      this.ui.toast(b ? `Backup created: ${b.name}` : 'Backup failed - see the console.', b ? 'ok' : 'error');
      void this.reload();
    });
  }

  private restore(b: BackupInfo): void {
    const { core } = this.ui;
    if (core.server.state !== 'stopped') return void this.ui.toast('Stop the server before restoring a backup.', 'warn');
    this.ui.modal(confirmModal('Restore backup', [`Restore ${b.name}?`, 'The current world folders are renamed (not deleted).'], () => {
      void core.backups.restore(b.name).then((ok) => {
        this.ui.toast(ok ? 'Backup restored.' : 'Restore failed - see the console.', ok ? 'ok' : 'error');
        void this.reload();
      });
    }, true));
  }

  private remove(b: BackupInfo): void {
    this.ui.modal(confirmModal('Delete backup', [`Delete ${b.name}?`, 'This cannot be undone.'], () => {
      void this.ui.core.backups.remove(b.name).then(() => {
        this.ui.toast(`Deleted ${b.name}`, 'ok');
        void this.reload();
      });
    }, true));
  }

  onKey(k: KeyEvent): boolean {
    if (this.list.handle(k, this.items.length, 10)) return true;
    const b = this.selected();
    if (k.name === 'enter' && b) {
      this.ui.modal(menuModal(b.name, [
        { label: 'Restore this backup', value: 'restore' },
        { label: 'Delete this backup', value: 'delete' },
        { label: 'Create new backup', value: 'new' },
        { label: 'Open backup folder', value: 'open' },
      ], (a) => {
        if (a === 'restore') this.restore(b);
        else if (a === 'delete') this.remove(b);
        else if (a === 'new') this.create();
        else folderOpener.open(this.ui.core.backups.dir);
      }));
      return true;
    }
    if (k.name === 'delete' && b) {
      this.remove(b);
      return true;
    }
    if (k.name !== 'char') return false;
    switch (k.ch!.toLowerCase()) {
      case 'n':
        this.create();
        return true;
      case 'r':
        if (b) this.restore(b);
        return true;
      case 'd':
        if (b) this.remove(b);
        return true;
      case 'o':
        folderOpener.open(this.ui.core.backups.dir);
        return true;
    }
    return false;
  }

  onMouse(e: MouseEvent, _x: number, y: number): void {
    if (e.action === 'wheel-up') this.list.wheel(-1, this.items.length);
    else if (e.action === 'wheel-down') this.list.wheel(1, this.items.length);
    else if (e.action === 'down' && e.button === 0 && y >= 8) {
      this.list.selected = this.list.offset + (y - 8);
      this.list.clamp(this.items.length);
    }
    this.ui.render();
  }

  render(w: number, h: number): ViewFrame {
    const { core } = this.ui;
    const b = core.backups;
    const cfg = core.cfg;
    const folders = b.worldFolders();
    const infoLines = [
      ` ${paint('Folder'.padEnd(10), theme.muted)}${b.dir}`,
      ` ${paint('Worlds'.padEnd(10), theme.muted)}${folders.length ? folders.join(', ') : paint('none found yet', theme.warn)}`,
      ` ${paint('Schedule'.padEnd(10), theme.muted)}${cfg.backupIntervalMinutes > 0 ? `every ${cfg.backupIntervalMinutes} min while the server runs` : 'manual only'} · keep ${cfg.backupKeep > 0 ? 'newest ' + cfg.backupKeep : 'all'}`,
      ` ${paint('Status'.padEnd(10), theme.muted)}${b.busy ? paint(b.busy, theme.warn, theme.bold) : paint('idle', theme.ok)}`,
    ];
    const infoH = 6;
    const info = box(infoLines, w, infoH, { title: 'Backup settings', titleRight: 'change in Settings > MCLI' });
    const total = this.items.reduce((n, i) => n + i.size, 0);
    const table = renderTable(
      [
        { title: 'BACKUP', width: 0 },
        { title: 'SIZE', width: 10, align: 'right' },
        { title: 'CREATED', width: 16 },
      ],
      this.items.map((i) => [i.name, fmtBytes(i.size), fmtAge(i.mtime)]),
      this.list,
      w - 2,
      h - infoH - 2,
      'No backups yet. Press N to create one.',
    );
    const listBox = box(table, w, h - infoH, { title: `Backups (${this.items.length})`, titleRight: this.items.length ? `${fmtBytes(total)} total` : '' });
    return { lines: [...info, ...listBox] };
  }
}
