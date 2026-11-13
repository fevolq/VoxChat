import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { LIMITS } from './contracts.js';
import { requireValue } from './errors.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const decode = row => row ? { ...row, config: JSON.parse(row.config) } : undefined;
export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
      this.transaction(() => this.db.exec(`
        CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, config TEXT NOT NULL);
        INSERT OR IGNORE INTO settings VALUES(1,0,'{}');
        CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS voices (id TEXT PRIMARY KEY, name TEXT NOT NULL, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL,
          token_hash TEXT UNIQUE, pairing_hash TEXT UNIQUE, expires INTEGER,
          active_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
          voice_id TEXT REFERENCES voices(id) ON DELETE SET NULL, config TEXT NOT NULL DEFAULT '{}',
          created INTEGER NOT NULL, paired INTEGER);
        CREATE TABLE IF NOT EXISTS device_workspaces (
          device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, session_id TEXT,
          PRIMARY KEY(device_id,workspace_id));
        CREATE TABLE IF NOT EXISTS turns (device_id TEXT NOT NULL, id TEXT NOT NULL, session_id TEXT NOT NULL,
          status TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(device_id,id));
        CREATE TABLE IF NOT EXISTS connection (id INTEGER PRIMARY KEY CHECK(id=1), origin TEXT);
        INSERT OR IGNORE INTO connection VALUES(1,NULL);
        UPDATE turns SET status='interrupted' WHERE status='running';`));
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  settings() { return decode(this.db.prepare('SELECT * FROM settings WHERE id=1').get()); }
  activateOrigin(origin) {
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT origin FROM connection WHERE id=1').get().origin;
      if (previous === origin) return false;
      const revoke = previous !== null || Boolean(this.db.prepare('SELECT 1 FROM devices WHERE token_hash IS NOT NULL LIMIT 1').get());
      this.db.prepare('UPDATE connection SET origin=? WHERE id=1').run(origin);
      if (revoke) this.db.exec('UPDATE devices SET token_hash=NULL,paired=NULL,pairing_hash=NULL,expires=NULL');
      this.db.exec('UPDATE settings SET revision=revision+1 WHERE id=1');
      return revoke;
    });
  }
  workspaces() { return this.db.prepare('SELECT * FROM workspaces ORDER BY rowid').all(); }
  workspace(id) {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
    requireValue(row, 404, 'WORKSPACE_NOT_FOUND', '工作区尚未接入 VoxChat');
    return row;
  }
  devices() { return this.db.prepare('SELECT id,name,active_workspace_id,voice_id,config,created,paired,expires FROM devices ORDER BY created,rowid').all().map(decode); }
  voices() { return this.db.prepare('SELECT * FROM voices ORDER BY rowid').all(); }
  voice(id) {
    const row = this.db.prepare('SELECT * FROM voices WHERE id=?').get(id);
    requireValue(row, 422, 'VOICE_NOT_FOUND', '音色不存在，请重新选择'); return row;
  }
  saveVoice(id, name, value) {
    requireValue(this.voices().length < 100 || this.voices().some(row => row.id === id), 422, 'VOICE_LIMIT', '最多保存 100 个音色');
    this.db.prepare('INSERT INTO voices VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,value=excluded.value').run(id, name, value);
  }
  removeVoice(id) { this.voice(id); this.db.prepare('DELETE FROM voices WHERE id=?').run(id); }
  selectVoice(deviceId, voiceId) {
    this.device(deviceId); if (voiceId !== null) this.voice(voiceId);
    this.db.prepare('UPDATE devices SET voice_id=? WHERE id=?').run(voiceId, deviceId);
  }
  bindings(deviceId) {
    return deviceId === undefined ? this.db.prepare('SELECT * FROM device_workspaces ORDER BY rowid').all()
      : this.db.prepare('SELECT * FROM device_workspaces WHERE device_id=? ORDER BY rowid').all(deviceId).map(row => ({ ...row }));
  }
  hasBinding(deviceId, workspaceId) {
    return Boolean(this.db.prepare('SELECT 1 FROM device_workspaces WHERE device_id=? AND workspace_id=?').get(deviceId, workspaceId));
  }
  binding(deviceId, workspaceId) {
    const row = this.db.prepare('SELECT * FROM device_workspaces WHERE device_id=? AND workspace_id=?').get(deviceId, workspaceId);
    requireValue(row, 403, 'WORKSPACE_FORBIDDEN', '设备未获授权访问此工作区');
    return row;
  }
  device(id) {
    const row = this.db.prepare(`SELECT d.*, b.session_id FROM devices d LEFT JOIN device_workspaces b
      ON b.device_id=d.id AND b.workspace_id=d.active_workspace_id WHERE d.id=?`).get(id);
    requireValue(row, 401, 'DEVICE_REVOKED', '设备不存在或已撤销');
    return decode(row);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  mutate(revision, fn) {
    return this.transaction(() => {
      requireValue(Number.isInteger(revision) && revision === this.settings().revision, 409, 'REVISION_CONFLICT', '配置已变化，请刷新后重试');
      const result = fn();
      this.db.exec('UPDATE settings SET revision=revision+1 WHERE id=1');
      return result;
    });
  }
  setConfig(config) { this.db.prepare('UPDATE settings SET config=? WHERE id=1').run(JSON.stringify(config)); }
  setDeviceConfig(deviceId, config) {
    this.device(deviceId);
    this.db.prepare('UPDATE devices SET config=? WHERE id=?').run(JSON.stringify(config), deviceId);
  }
  addWorkspace(id) {
    requireValue(!this.workspaces().some(row => row.id === id), 409, 'ALREADY_EXISTS', '工作区已接入');
    this.db.prepare('INSERT INTO workspaces (id) VALUES(?)').run(id);
  }
  addDevice(name) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO devices (id,name,created) VALUES(?,?,?)').run(id, name, Date.now());
    return this.refreshPairing(id);
  }
  refreshPairing(id) {
    const device = this.device(id);
    requireValue(!device.token_hash, 409, 'ALREADY_PAIRED', '设备已配对，无需刷新配对码');
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do { code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(''); }
    while (this.db.prepare('SELECT 1 FROM devices WHERE pairing_hash=?').get(hash(code)));
    const expires = Date.now() + LIMITS.pairingMs;
    this.db.prepare('UPDATE devices SET pairing_hash=?,expires=? WHERE id=?').run(hash(code), expires, id);
    return { id, code, expires };
  }
  bind(deviceId, workspaceId) {
    this.device(deviceId); this.workspace(workspaceId);
    requireValue(!this.hasBinding(deviceId, workspaceId), 409, 'ALREADY_BOUND', '设备已关联此工作区');
    this.db.prepare('INSERT INTO device_workspaces (device_id,workspace_id) VALUES(?,?)').run(deviceId, workspaceId);
  }
  unbind(deviceId, workspaceId) {
    this.binding(deviceId, workspaceId);
    this.db.prepare('DELETE FROM device_workspaces WHERE device_id=? AND workspace_id=?').run(deviceId, workspaceId);
    this.db.prepare('UPDATE devices SET active_workspace_id=NULL WHERE id=? AND active_workspace_id=?').run(deviceId, workspaceId);
  }
  pair(code, validate = () => {}) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM devices WHERE pairing_hash=? AND token_hash IS NULL AND expires>?').get(hash(code.trim().toUpperCase()), Date.now());
      requireValue(row, 401, 'INVALID_PAIRING_CODE', '配对码无效、已使用或已过期');
      const workspaceIds = this.bindings(row.id).map(binding => binding.workspace_id);
      for (const workspaceId of workspaceIds) validate(workspaceId);
      const token = randomBytes(32).toString('base64url');
      this.db.prepare('UPDATE devices SET token_hash=?,pairing_hash=NULL,expires=NULL,paired=? WHERE id=?').run(hash(token), Date.now(), row.id);
      this.db.exec('UPDATE settings SET revision=revision+1 WHERE id=1');
      return { deviceId: row.id, workspaceId: row.active_workspace_id, workspaceIds, token };
    });
  }
  authenticate(token) {
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash=?').get(hash(token));
    requireValue(row, 401, 'UNAUTHORIZED', '设备凭证无效');
    return this.device(row.id);
  }
  revoke(id) { this.device(id); this.db.prepare('DELETE FROM devices WHERE id=?').run(id); }
  selectWorkspace(deviceId, workspaceId) {
    this.binding(deviceId, workspaceId);
    this.db.prepare('UPDATE devices SET active_workspace_id=? WHERE id=?').run(workspaceId, deviceId);
  }
  select(deviceId, sessionId, workspaceId = this.device(deviceId).active_workspace_id) {
    this.binding(deviceId, workspaceId);
    this.db.prepare('UPDATE device_workspaces SET session_id=? WHERE device_id=? AND workspace_id=?').run(sessionId, deviceId, workspaceId);
  }
  beginTurn(device, requestId, sessionId) {
    requireValue(!this.db.prepare('SELECT 1 FROM turns WHERE device_id=? AND id=?').get(device.id, requestId),
      409, 'DUPLICATE_REQUEST', '该请求已受理，请查看会话记录；不要自动重发');
    this.db.prepare("INSERT INTO turns VALUES(?,?,?,'running',?)").run(device.id, requestId, sessionId, Date.now());
  }
  endTurn(deviceId, requestId, status) { this.db.prepare('UPDATE turns SET status=? WHERE device_id=? AND id=?').run(status, deviceId, requestId); }
}
