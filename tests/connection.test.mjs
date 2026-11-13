import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { VoxChat } from '../src/service.js';
import { Connection } from '../src/connection.js';
import { createHandler } from '../src/http.js';
import { tunnelBinary } from '../src/tunnel.js';
import { command, fakeDsh, fixture, upload } from './helpers.mjs';

test('corrupt cached tunnel binaries are rejected without execution or download', async t => {
  const platform = { 'win32-x64': 'windows-amd64.exe', 'linux-x64': 'linux-amd64', 'linux-arm64': 'linux-arm64' }[process.platform + '-' + process.arch];
  if (!platform) return;
  const directory = await mkdtemp(join(tmpdir(), 'voxchat-corrupt-tunnel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'cloudflared-2026.11.0-' + platform), 'corrupt executable');
  await assert.rejects(tunnelBinary(directory, new AbortController().signal), { code: 'TUNNEL_CHECKSUM' });
});

test('address changes revoke every token and code, preserve device data and survive restarts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'voxchat-address-')), path = join(dir, 'store.sqlite');
  t.after(() => rm(dir, { recursive: true, force: true }));
  let store = new Store(path), service = new VoxChat(store, fakeDsh(), {});
  service.activateOrigin('https://first.example.test');
  command(service, { action: 'saveVoice', voiceId: 'sample', name: 'voice', value: 's0' });
  const paired = ['one', 'two'].map(name => {
    const device = command(service, { action: 'addDevice', name }).result;
    const pair = service.pair(device.code);
    for (const workspaceId of ['work-a', 'work-b']) command(service, { action: 'bindDevice', deviceId: device.id, workspaceId });
    service.selectWorkspace(device.id, 'work-a'); service.select(device.id, 'session-a'); service.selectVoice(device.id, 'sample');
    command(service, { action: 'configure', deviceId: device.id, kind: 'asr', value: { baseUrl: 'https://asr.example.test/v1', model: 'asr', apiKey: 'saved-key' } });
    return pair;
  });
  const pending = command(service, { action: 'addDevice', name: 'pending' }).result;
  const before = store.devices(), bindings = store.bindings(), revision = store.settings().revision;
  store.close(); store = new Store(path); service = new VoxChat(store, fakeDsh(), {});
  service.activateOrigin('https://first.example.test/');
  assert.equal(store.settings().revision, revision);
  for (const pair of paired) assert.equal(store.authenticate(pair.token).id, pair.deviceId);
  let disconnected = 0;
  const off = service.watchRequest(error => { assert.equal(error.code, 'DEVICE_REVOKED'); disconnected++; });
  service.activateOrigin('https://next.example.test'); off();
  assert.equal(disconnected, 1);
  assert.equal(store.settings().revision, revision + 1);
  for (const pair of paired) assert.throws(() => store.authenticate(pair.token), { code: 'UNAUTHORIZED' });
  assert.throws(() => service.pair(pending.code), { code: 'INVALID_PAIRING_CODE' });
  assert.deepEqual(store.bindings(), bindings);
  const retained = rows => rows.map(({ paired, expires, ...device }) => device);
  assert.deepEqual(retained(store.devices()), retained(before));
  assert.ok(store.devices().every(row => row.paired === null && row.expires === null));
  const refreshed = command(service, { action: 'refreshPairing', deviceId: paired[0].deviceId }).result;
  const reconnected = service.pair(refreshed.code);
  assert.equal(reconnected.deviceId, paired[0].deviceId);
  assert.equal(service.me(reconnected.deviceId).voiceId, 'sample');
  assert.equal(service.me(reconnected.deviceId).sessionId, 'session-a');
  store.close(); store = new Store(path);
  assert.equal(store.authenticate(reconnected.token).id, reconnected.deviceId); store.close();
});

test('manual mode starts no tunnel, automatic mode uses isolated device routes and switching closes it', async t => {
  const store = new Store(':memory:'), service = new VoxChat(store, fakeDsh(), {});
  command(service, { action: 'configurePairing', origin: 'https://manual.example.test' });
  let launches = 0, port, stopped = 0;
  const connection = new Connection(service, createHandler(service), null, async options => {
    launches++; port = options.port;
    return { origin: 'https://automatic.example.test', close: async () => { stopped++; } };
  });
  t.after(async () => { await connection.close(); await service.close(); store.close(); });
  await connection.configure(); await connection.configure();
  assert.equal(launches, 0); assert.equal(service.view().connection.mode, 'manual');
  command(service, { action: 'configurePairing', origin: '' }); await connection.pending;
  assert.equal(launches, 1); assert.equal(connection.view().origin, 'https://automatic.example.test');
  assert.equal(store.settings().config.pairingOrigin, '', 'runtime URL must not become saved manual configuration');
  const base = 'http://127.0.0.1:' + port;
  assert.equal((await fetch(base + '/voxchat/api/status')).status, 200);
  for (const path of ['/', '/api/remote', '/settings', '/other-plugin']) assert.equal((await fetch(base + path)).status, 404);
  const device = command(service, { action: 'addDevice', name: 'phone' }).result;
  const result = await fetch(base + '/voxchat/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: device.code }) });
  assert.equal(result.status, 200); const { token } = await result.json();
  assert.equal((await fetch(base + '/voxchat/api/me', { headers: { Authorization: 'Bearer ' + token } })).status, 200);
  command(service, { action: 'configurePairing', origin: 'https://manual.example.test' }); await connection.pending;
  assert.equal(stopped, 1); assert.equal(connection.view().mode, 'manual');
  assert.throws(() => store.authenticate(token), { code: 'UNAUTHORIZED' });
  await assert.rejects(fetch(base + '/voxchat/api/status'));
});

test('failed startup is visible, retry is explicit and does not renew pairing codes', async t => {
  const store = new Store(':memory:'), service = new VoxChat(store, fakeDsh(), {});
  let fail = true, failRunning, launches = 0;
  const connection = new Connection(service, createHandler(service), null, async options => {
    launches++; failRunning = options.onFailure;
    if (fail) throw new Error('tunnel service unavailable');
    return { origin: 'https://working.example.test', close: async () => {} };
  });
  t.after(async () => { await connection.close(); await service.close(); store.close(); });
  const pending = command(service, { action: 'addDevice', name: 'phone' }).result;
  await connection.configure();
  assert.equal(connection.view().status, 'error'); assert.match(connection.view().error, /unavailable/);
  assert.throws(() => connection.ready(), { code: 'CONNECTION_NOT_READY' });
  await connection.configure(); assert.equal(launches, 1, 'no implicit restart');
  fail = false; command(service, { action: 'retryTunnel' }); await connection.pending;
  assert.equal(connection.view().status, 'ready');
  assert.equal(store.device(pending.id).expires, pending.expires);
  assert.throws(() => command(service, { action: 'retryTunnel' }), { code: 'TUNNEL_NOT_FAILED' });
  failRunning(new Error('tunnel disconnected'));
  assert.equal(connection.view().status, 'error'); assert.equal(connection.view().origin, null);
  assert.equal(store.db.prepare('SELECT origin FROM connection').get().origin, 'https://working.example.test');
});

test('switching during startup aborts the stale tunnel before publishing a new address', async t => {
  const store = new Store(':memory:'), service = new VoxChat(store, fakeDsh(), {});
  let began; const started = new Promise(resolve => { began = resolve; });
  const connection = new Connection(service, createHandler(service), null, async ({ signal }) => {
    began(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  t.after(async () => { await connection.close(); store.close(); });
  void connection.configure(); await started;
  command(service, { action: 'configurePairing', origin: 'https://manual.example.test' }); await connection.pending;
  assert.deepEqual(connection.view(), { mode: 'manual', status: 'ready', origin: 'https://manual.example.test', error: null });
  assert.equal(store.db.prepare('SELECT origin FROM connection').get().origin, 'https://manual.example.test');
});

test('address invalidation aborts active audio streams and pending history responses', async t => {
  const f = await fixture(t);
  // A pre-existing connection baseline lets this test isolate actual address changes.
  f.store.db.prepare('UPDATE connection SET origin=?').run('https://old.example.test');
  let inDsh; const started = new Promise(resolve => { inDsh = resolve; });
  f.dsh.run = async (...args) => { inDsh(); const signal = args.at(-1); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); };
  const response = await upload(f, 'address-change');
  const stream = response.text(); stream.catch(() => {}); await started;
  let finishHistory, startHistory;
  const reading = new Promise(resolve => { startHistory = resolve; });
  f.dsh.history = async () => { startHistory(); return new Promise(resolve => { finishHistory = resolve; }); };
  const history = f.request('/sessions/session-a/history'); history.catch(() => {}); await reading;
  f.service.activateOrigin('https://new.example.test');
  await assert.rejects(stream); await assert.rejects(history);
  finishHistory({ items: [] });
  assert.equal((await f.request('/me')).status, 401);
  assert.equal(f.store.db.prepare('SELECT status FROM turns WHERE id=?').get('address-change').status, 'cancelled');
});
