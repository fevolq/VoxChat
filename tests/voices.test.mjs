import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, command, bind, upload, events } from './helpers.mjs';

test('devices choose shared voices independently while inheriting plugin model configuration', async t => {
  const f = await fixture(t), second = bind(f.service);
  command(f.service, { action: 'saveVoice', voiceId: 'voice-two', name: '另一个音色', value: 'second-voice' });
  const selected = await f.request('/voice', { method: 'PUT', token: second.token, body: { voiceId: 'voice-two' } });
  assert.equal(selected.status, 200); assert.equal((await selected.json()).voiceId, 'voice-two');
  f.service.select(second.deviceId, 'session-b');
  assert.equal((await events(await upload(f, 'first-voice'))).at(-1).type, 'complete');
  assert.equal((await events(await upload(f, 'second-voice', { token: second.token }))).at(-1).type, 'complete');
  const tts = f.upstream.calls.filter(call => call.path.endsWith('/audio/speech')).map(call => JSON.parse(call.body));
  assert.deepEqual(tts.map(call => call.voice), ['sample', 'second-voice']);
  assert.equal(tts[0].model, tts[1].model);
  assert.equal(f.service.me(second.deviceId).voiceId, 'voice-two');
  assert.equal(f.service.me(second.deviceId).ready.tts, true);
  assert.equal(f.store.settings().config.tts.voice, undefined);
  assert.throws(() => command(f.service, { action: 'configure', deviceId: null, kind: 'tts', value: {
    baseUrl: f.upstream.url + '/v1', model: 'tts', voice: 'must-select-on-device',
  } }), { code: 'INVALID_REQUEST' });
});

test('device APIs return the complete library and allow only authenticated selection for the calling device', async t => {
  const f = await fixture(t);
  command(f.service, { action: 'saveVoice', voiceId: 'voice-two', name: '第二个音色', value: 'second' });
  const pending = command(f.service, { action: 'addDevice', name: '尚无工作区' }).result;
  const paired = f.service.pair(pending.code), token = paired.token;
  const expected = [
    { id: 'test-voice', name: '测试音色', value: 'sample' },
    { id: 'voice-two', name: '第二个音色', value: 'second' },
  ];
  const catalog = await f.request('/voices', { token });
  assert.equal(catalog.status, 200); assert.deepEqual(await catalog.json(), { voiceId: null, items: expected });
  const before = await (await f.request('/me', { token })).json();
  assert.equal(before.voiceId, null); assert.deepEqual(before.voices, expected); assert.deepEqual(before.workspaces, []);
  assert.ok(!JSON.stringify(before).includes('test-provider-secret'));
  const selected = await f.request('/voice', { method: 'PUT', token, body: { voiceId: 'voice-two' } });
  assert.equal(selected.status, 200); assert.deepEqual(await selected.json(), { voiceId: 'voice-two', items: expected });
  assert.equal((await (await f.request('/me', { token })).json()).voiceId, 'voice-two');
  assert.equal(f.service.me(f.pair.deviceId).voiceId, 'test-voice');
  for (const [body, status, code] of [
    [{ voiceId: 'missing' }, 422, 'VOICE_NOT_FOUND'],
    [{}, 400, 'INVALID_ID'],
    [{ voiceId: 'test-voice', deviceId: f.pair.deviceId }, 400, 'INVALID_REQUEST'],
    [{ voiceId: 'test-voice', name: 'changed' }, 400, 'INVALID_REQUEST'],
  ]) {
    const response = await f.request('/voice', { method: 'PUT', token, body });
    assert.equal(response.status, status); assert.equal((await response.json()).error.code, code);
    assert.equal(f.service.me(paired.deviceId).voiceId, 'voice-two');
  }
  for (const [path, options] of [['/voices', {}], ['/voice', { method: 'PUT', body: { voiceId: 'test-voice' } }]]) {
    assert.equal((await f.request(path, { ...options, token: '' })).status, 401);
    assert.equal((await f.request(path, { ...options, token: 'a'.repeat(43) })).status, 401);
  }
  const cleared = await f.request('/voice', { method: 'PUT', token, body: { voiceId: null } });
  assert.equal(cleared.status, 200); assert.deepEqual(await cleared.json(), { voiceId: null, items: expected });
  assert.throws(() => command(f.service, { action: 'setDeviceVoice', deviceId: paired.deviceId, voiceId: 'test-voice' }), { code: 'INVALID_COMMAND' });
  assert.throws(() => command(f.service, { action: 'addDevice', name: '管理员代选', voiceId: 'test-voice' }), { code: 'INVALID_REQUEST' });
  command(f.service, { action: 'revokeDevice', deviceId: paired.deviceId });
  assert.equal((await f.request('/voice', { method: 'PUT', token, body: { voiceId: 'test-voice' } })).status, 401);
});

test('changing the client selection during a turn applies to the next turn', async t => {
  const f = await fixture(t);
  command(f.service, { action: 'saveVoice', voiceId: 'voice-two', name: '第二个音色', value: 'second' });
  let release;
  const transcribe = f.service.voice.transcribe;
  f.service.voice.transcribe = () => new Promise(resolve => { release = resolve; });
  const response = await upload(f, 'before-selection');
  const selected = await f.request('/voice', { method: 'PUT', body: { voiceId: 'voice-two' } });
  assert.equal(selected.status, 200);
  release('当前录音');
  assert.equal((await events(response)).at(-1).type, 'complete');
  f.service.voice.transcribe = transcribe;
  assert.equal((await events(await upload(f, 'after-selection'))).at(-1).type, 'complete');
  assert.deepEqual(f.upstream.calls.filter(call => call.path.endsWith('/audio/speech')).map(call => JSON.parse(call.body).voice), ['sample', 'second']);
});

test('voice removal clears future selection but does not change an accepted turn', async t => {
  const f = await fixture(t);
  let release;
  f.service.voice.transcribe = () => new Promise(resolve => { release = resolve; });
  const response = await upload(f, 'before-removal');
  command(f.service, { action: 'saveVoice', voiceId: 'test-voice', name: '改名', value: 'edited-during-turn' });
  command(f.service, { action: 'removeVoice', voiceId: 'test-voice' });
  assert.equal(f.store.device(f.pair.deviceId).voice_id, null); assert.equal(f.service.me(f.pair.deviceId).ready.tts, false);
  assert.deepEqual(await (await f.request('/voices')).json(), { voiceId: null, items: [] });
  const me = await (await f.request('/me')).json();
  assert.equal(me.voiceId, null); assert.deepEqual(me.voices, []);
  release('已接受的请求');
  assert.equal((await events(response)).at(-1).type, 'complete');
  assert.equal(JSON.parse(f.upstream.calls.find(call => call.path.endsWith('/audio/speech')).body).voice, 'sample');
  const next = await upload(f, 'after-removal');
  assert.equal(next.status, 422); assert.equal((await next.json()).error.code, 'DEVICE_VOICE_REQUIRED');
  assert.equal(f.dsh.calls.length, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM turns').get().n, 1);
});

test('invalid voice edits roll back the entire save including device selection and model changes', async t => {
  const f = await fixture(t), before = f.service.view();
  assert.throws(() => command(f.service, { action: 'batch', operations: [
    { action: 'saveVoice', voiceId: 'new-voice', name: '新音色', value: 'new' },
    { action: 'configure', deviceId: null, kind: 'asr', value: { baseUrl: f.upstream.url + '/v1', model: 'changed' } },
    { action: 'removeVoice', voiceId: 'test-voice' },
    { action: 'removeVoice', voiceId: 'missing' },
  ] }), { code: 'VOICE_NOT_FOUND' });
  assert.deepEqual(f.service.view(), before);
});
