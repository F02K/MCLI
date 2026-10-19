import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { backupDirOf, loadConfig, saveConfigValue } from '../src/config';
import { INSTALL_META_FILE, readInstallMeta, writeInstallMeta } from '../src/installmeta';
import { tmp } from './helpers';

describe('config', () => {
  it('uses defaults when there is no mcli.json', () => {
    const dir = tmp('cfg');
    const cfg = loadConfig(dir);
    assert.equal(cfg.serverDir, resolve(dir));
    assert.equal(cfg.maxMemory, '2G');
    assert.equal(cfg.autoRestart, true);
    assert.equal(cfg.javaAutoInstall, false);
    assert.equal(cfg.configDir, dir);
  });

  it('merges user values over the defaults and resolves serverDir', () => {
    const dir = tmp('cfg');
    writeFileSync(join(dir, 'mcli.json'), JSON.stringify({ serverDir: 'srv', maxMemory: '8G', backupKeep: 3 }));
    const cfg = loadConfig(dir);
    assert.equal(cfg.serverDir, resolve(dir, 'srv'));
    assert.equal(cfg.maxMemory, '8G');
    assert.equal(cfg.backupKeep, 3);
    assert.equal(cfg.minMemory, '1G');
  });

  it('reports a broken mcli.json with its path', () => {
    const dir = tmp('cfg');
    writeFileSync(join(dir, 'mcli.json'), '{ nope');
    assert.throws(() => loadConfig(dir), /Cannot parse .*mcli\.json/);
  });

  it('computes the backup folder', () => {
    const dir = tmp('cfg');
    assert.equal(backupDirOf(loadConfig(dir)), join(resolve(dir), 'backups'));
    writeFileSync(join(dir, 'mcli.json'), JSON.stringify({ backupDir: 'b' }));
    assert.equal(backupDirOf(loadConfig(dir)), resolve(dir, 'b'));
  });

  it('saveConfigValue updates memory and file and keeps unrelated keys', () => {
    const dir = tmp('cfg');
    writeFileSync(join(dir, 'mcli.json'), JSON.stringify({ customLaunch: { command: 'x', args: [] }, maxMemory: '1G' }));
    const cfg = loadConfig(dir);
    saveConfigValue(cfg, 'maxMemory', '4G');
    saveConfigValue(cfg, 'autoRestart', false);
    assert.equal(cfg.maxMemory, '4G');
    const onDisk = JSON.parse(readFileSync(join(dir, 'mcli.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(onDisk.maxMemory, '4G');
    assert.equal(onDisk.autoRestart, false);
    assert.deepEqual(onDisk.customLaunch, { command: 'x', args: [] });
  });

  it('saveConfigValue creates the file when it does not exist', () => {
    const dir = tmp('cfg');
    saveConfigValue(loadConfig(dir), 'java', 'C:/java.exe');
    assert.equal((JSON.parse(readFileSync(join(dir, 'mcli.json'), 'utf8')) as { java: string }).java, 'C:/java.exe');
  });
});

describe('install metadata', () => {
  const meta = { provider: 'paper', mcVersion: '1.21.8', identity: '60', file: 'paper.jar', installedAt: 'now' } as const;

  it('round-trips', () => {
    const dir = tmp('meta');
    assert.equal(readInstallMeta(dir), null);
    writeInstallMeta(dir, meta);
    assert.deepEqual(readInstallMeta(dir), meta);
  });

  it('ignores broken or incomplete files', () => {
    const dir = tmp('meta');
    writeFileSync(join(dir, INSTALL_META_FILE), '{broken');
    assert.equal(readInstallMeta(dir), null);
    writeFileSync(join(dir, INSTALL_META_FILE), JSON.stringify({ foo: 1 }));
    assert.equal(readInstallMeta(dir), null);
  });
});
