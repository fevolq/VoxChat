import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, command, bind, upload, events } from './helpers.mjs';

const configure = (f, deviceId, kind, model) => command(f.service, { action: 'configure', deviceId, kind,
  value: { baseUrl: f.upstream.url + '/v1', model, apiKey: model + '-key', ...(kind === 'tts' ? { format: 'wav' } : {}) } });

test('device models override plugin models across workspaces without affecting another device or exposing secrets', async t => {
  const f = await fixture(t), second = bind(f.service);
  f.service.select(second.deviceId, 'session-b');
  configure(f, null, 'summary', 'plugin-summary');
  for (const kind of ['asr', 'tts', 'summary']) configure(f, f.pair.deviceId, kind, 'device-' + kind);
  assert.equal((await events(await upload(f, 'device-a'))).at(-1).type, 'complete');
  command(f.service, { action: 'bindDevice', deviceId: f.pair.deviceId, workspaceId: 'work-b' });
  f.service.selectWorkspace(f.pair.deviceId, 'work-b'); f.service.select(f.pair.deviceId, 'session-other');
  assert.equal((await events(await upload(f, 'device-b'))).at(-1).type, 'complete');
  assert.equal((await events(await upload(f, 'other-device', { token: second.token }))).at(-1).type, 'complete');
  const asr = f.upstream.calls.filter(call => call.path.endsWith('/audio/transcriptions'));
  assert.deepEqual(asr.map(call => call.headers.authorization), ['Bearer device-asr-key', 'Bearer device-asr-key', 'Bearer test-provider-secret']);
  assert.match(asr[0].body, /device-asr/); assert.match(asr[1].body, /device-asr/); assert.match(asr[2].body, /asr-model/);
  for (const [path, expected] of [['/audio/speech', ['device-tts', 'device-tts', 'tts-model']], ['/chat/completions', ['device-summary', 'device-summary', 'plugin-summary']]]) {
    assert.deepEqual(f.upstream.calls.filter(call => call.path.endsWith(path)).map(call => JSON.parse(call.body).model), expected);
  }
  const view = f.service.view();
  assert.deepEqual(view.devices.find(device => device.id === f.pair.deviceId).sources, { asr: 'device', tts: 'device', summary: 'device' });
  assert.equal(view.devices.find(device => device.id === f.pair.deviceId).config.asr.apiKeySet, true);
  assert.equal(view.devices.find(device => device.id === f.pair.deviceId).config.asr.apiKey, undefined);
  assert.ok(view.workspaces.every(workspace => workspace.config === undefined));
  for (const path of ['/me', '/workspaces', '/voices']) {
    const response = await (await f.request(path)).json();
    assert.doesNotMatch(JSON.stringify(response), /device-asr|device-tts|device-summary|apiKey|baseUrl/);
  }
  for (const kind of ['asr', 'tts', 'summary']) command(f.service, { action: 'configure', deviceId: f.pair.deviceId, kind, value: null });
  assert.equal((await events(await upload(f, 'inherit-plugin'))).at(-1).type, 'complete');
  assert.equal(JSON.parse(f.upstream.calls.at(-1).body).model, 'tts-model');
  assert.equal(JSON.parse(f.upstream.calls.at(-2).body).model, 'plugin-summary');
  command(f.service, { action: 'configure', deviceId: null, kind: 'summary', value: null });
  assert.equal((await events(await upload(f, 'inherit-session'))).at(-1).type, 'complete');
  assert.equal(f.dsh.summaries.at(-1).model.model, 'session-model');
  assert.throws(() => command(f.service, { action: 'configure', workspaceId: 'work-a', kind: 'asr', value: null }), { code: 'INVALID_REQUEST' });
});

test('device configuration edits preserve in-flight model snapshots and failed saves roll back', async t => {
  const f = await fixture(t);
  for (const kind of ['asr', 'tts', 'summary']) configure(f, f.pair.deviceId, kind, 'before-' + kind);
  const transcribe = f.service.voice.transcribe;
  let release;
  f.service.voice.transcribe = (...args) => new Promise(resolve => { release = () => resolve(transcribe.apply(f.service.voice, args)); });
  const response = await upload(f, 'before-edit');
  for (const kind of ['asr', 'tts', 'summary']) configure(f, f.pair.deviceId, kind, 'after-' + kind);
  release(); assert.equal((await events(response)).at(-1).type, 'complete');
  f.service.voice.transcribe = transcribe;
  assert.equal((await events(await upload(f, 'after-edit'))).at(-1).type, 'complete');
  assert.deepEqual(f.upstream.calls.filter(call => call.path.endsWith('/audio/transcriptions')).map(call => call.headers.authorization), ['Bearer before-asr-key', 'Bearer after-asr-key']);
  for (const [path, kind] of [['/audio/speech', 'tts'], ['/chat/completions', 'summary']]) {
    assert.deepEqual(f.upstream.calls.filter(call => call.path.endsWith(path)).map(call => JSON.parse(call.body).model), ['before-' + kind, 'after-' + kind]);
  }
  const before = f.service.view();
  assert.throws(() => command(f.service, { action: 'batch', operations: [
    { action: 'configure', deviceId: f.pair.deviceId, kind: 'asr', value: null },
    { action: 'configure', deviceId: f.pair.deviceId, kind: 'tts', value: {} },
  ] }));
  assert.deepEqual(f.service.view(), before);
});
