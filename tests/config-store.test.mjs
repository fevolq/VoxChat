import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { modelConfig, effective, redact } from '../src/config.js';
import { Store } from '../src/store.js';
import { addBoundDevice } from './helpers.mjs';

test('configuration inherits by capability and never combines service secrets', () => {
  const first = modelConfig('asr', { baseUrl: 'http://localhost:9000/v1/', apiKey: 'secret', model: 'asr' });
  assert.equal(first.baseUrl, 'http://localhost:9000/v1');
  assert.equal(modelConfig('asr', { baseUrl: first.baseUrl, model: 'new' }, first).apiKey, 'secret');
  assert.equal(modelConfig('asr', { baseUrl: 'http://other/v1', model: 'new' }, first).apiKey, '');
  assert.equal(modelConfig('asr', { baseUrl: first.baseUrl, model: 'new', apiKey: '' }, first).apiKey, '');
  const config = effective({ asr: first, tts: { model: 'default' }, summary: { model: 'summary' } }, { tts: { model: 'override' } });
  assert.equal(config.asr.model, 'asr'); assert.equal(config.tts.model, 'override');
  assert.equal(config.summary.model, 'summary'); assert.equal(effective({}, {}).summary, null);
  assert.equal(redact(config).asr.apiKey, undefined); assert.equal(redact(config).asr.apiKeySet, true);
  assert.throws(() => modelConfig('asr', { baseUrl: 'https://user:secret@example.com', model: 'x' }));
  assert.throws(() => modelConfig('summary', { provider: 'p', model: 'x', extra: true }));
  const summary = modelConfig('summary', { baseUrl: 'https://example.com/v1', apiKey: 'summary-key', model: 'summary' });
  assert.equal(modelConfig('summary', { baseUrl: summary.baseUrl, model: 'updated' }, summary).apiKey, 'summary-key');
  assert.equal(modelConfig('summary', { baseUrl: 'https://other.example/v1', model: 'updated' }, summary).apiKey, '');
  assert.equal(redact({ summary }).summary.apiKey, undefined);
  assert.equal(redact({ summary }).summary.apiKeySet, true);
});

test('pairing is one-use, hashed and expiring; removing a grant preserves device identity', () => {
  const store = new Store(':memory:');
  try {
    store.addWorkspace('workspace');
    const pending = addBoundDevice(store, 'phone', ['workspace']);
    const row = store.device(pending.id);
    assert.notEqual(row.pairing_hash, pending.code);
    const paired = store.pair(pending.code);
    assert.equal(store.authenticate(paired.token).active_workspace_id, 'workspace');
    assert.notEqual(store.device(pending.id).token_hash, paired.token);
    assert.throws(() => store.pair(pending.code), { code: 'INVALID_PAIRING_CODE' });
    const expired = store.addDevice('expired');
    store.db.prepare('UPDATE devices SET expires=0 WHERE id=?').run(expired.id);
    assert.throws(() => store.pair(expired.code), { code: 'INVALID_PAIRING_CODE' });
    store.unbind(pending.id, 'workspace');
    assert.equal(store.authenticate(paired.token).active_workspace_id, null);
    assert.deepEqual(store.bindings(pending.id), []);
    store.revoke(pending.id); assert.throws(() => store.authenticate(paired.token), { code: 'UNAUTHORIZED' });
  } finally { store.close(); }
});

test('revisions are atomic; failed writes leave earlier configuration intact', () => {
  const store = new Store(':memory:');
  try {
    store.mutate(0, () => store.addWorkspace('work'));
    assert.throws(() => store.mutate(0, () => store.addWorkspace('other')), { code: 'REVISION_CONFLICT' });
    assert.throws(() => store.mutate(1, () => { store.addWorkspace('other'); throw new Error('fail'); }));
    assert.deepEqual(store.workspaces().map(row => row.id), ['work']); assert.equal(store.settings().revision, 1);
  } finally { store.close(); }
});

test('configuration, bindings and deduplication survive restart; unfinished requests are not replayed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'voxchat-store-')), path = join(dir, 'state.sqlite');
  let store = new Store(path);
  try {
    assert.deepEqual(store.settings().config, {});
    assert.deepEqual(store.voices(), []);
    store.addWorkspace('work'); store.addWorkspace('other');
    const pair = store.pair(addBoundDevice(store, 'phone', ['work', 'other']).code);
    const pending = store.addDevice('tablet');
    const defaults = { asr: modelConfig('asr', { baseUrl: 'https://asr.example.test/v1', model: 'asr', apiKey: 'saved-asr-key' }) };
    const deviceConfig = { tts: modelConfig('tts', { baseUrl: 'https://tts.example.test/v1', model: 'tts', apiKey: 'saved-tts-key' }) };
    store.mutate(store.settings().revision, () => {
      store.setConfig(defaults); store.setDeviceConfig(pair.deviceId, deviceConfig);
      store.saveVoice('voice', '音色', 'voice-value');
    });
    store.selectVoice(pair.deviceId, 'voice');
    store.select(pair.deviceId, 'other-session', 'other');
    store.select(pair.deviceId, 'session'); store.beginTurn(store.device(pair.deviceId), 'request', 'session');
    const revision = store.settings().revision;
    store.close(); store = new Store(path);
    assert.equal(store.settings().revision, revision);
    assert.deepEqual(store.settings().config, defaults);
    assert.deepEqual(store.device(pair.deviceId).config, deviceConfig);
    assert.equal(store.device(pair.deviceId).voice_id, 'voice');
    assert.equal(store.voice('voice').value, 'voice-value');
    assert.equal(store.authenticate(pair.token).session_id, 'session');
    store.selectWorkspace(pair.deviceId, 'other');
    assert.equal(store.authenticate(pair.token).session_id, 'other-session');
    assert.equal(store.device(pending.id).expires, pending.expires);
    assert.equal(store.pair(pending.code).deviceId, pending.id);
    assert.equal(store.db.prepare('SELECT status FROM turns').get().status, 'interrupted');
    assert.throws(() => store.beginTurn(store.device(pair.deviceId), 'request', 'session'), { code: 'DUPLICATE_REQUEST' });
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
