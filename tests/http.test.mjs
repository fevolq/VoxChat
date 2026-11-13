import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, bind, command, upload, events, wav } from './helpers.mjs';
import { abortable } from '../src/errors.js';

test('real HTTP voice pipeline returns transcript, process, original, script and ordered audio bytes', async t => {
  const f = await fixture(t), response = await upload(f, 'turn-1');
  assert.equal(response.status, 200);
  const rows = await events(response);
  assert.equal(rows.at(-1).type, 'complete');
  assert.equal(rows.at(-1).data.status, 'audio_delivered');
  assert.deepEqual(rows.map(row => row.seq), rows.map((_, i) => i));
  assert.ok(rows.every(row => row.sessionId === 'session-a' && row.requestId === 'turn-1'));
  assert.ok(rows.some(row => row.type === 'transcript')); assert.ok(rows.some(row => row.type === 'dsh.event'));
  assert.match(rows.find(row => row.type === 'reply').data.text, /全部细节/);
  assert.equal(rows.find(row => row.type === 'speech.text').data.text, '已完成测试。');
  assert.deepEqual(Buffer.concat(rows.filter(row => row.type === 'audio.chunk').map(row => Buffer.from(row.data.data, 'base64'))), wav());
  assert.deepEqual(f.dsh.calls, [{ sessionId: 'session-a', text: '请告诉我执行结果' }]);
  assert.deepEqual(f.dsh.summaries[0].model, { provider: 'session-provider', model: 'session-model' });
  assert.match(f.upstream.calls[0].headers['content-type'], /multipart\/form-data/);
  assert.equal(f.upstream.calls[0].headers.authorization, 'Bearer test-provider-secret');
  assert.match(f.upstream.calls[0].body, /filename="recording.wav"/);
  assert.equal(JSON.parse(f.upstream.calls[1].body).input, '已完成测试。');
  assert.equal((await upload(f, 'turn-1')).status, 409); assert.equal(f.dsh.calls.length, 1);
});

test('workspace isolation, independent session selections and no public admin endpoint', async t => {
  const f = await fixture(t), second = bind(f.service);
  assert.equal((await f.request('/me', { token: 'bad' })).status, 401);
  assert.equal((await f.request('/admin')).status, 404);
  assert.equal((await f.request('/sessions/session-other/history')).status, 404);
  assert.equal((await f.request('/session', { method: 'PUT', body: { sessionId: 'session-other' } })).status, 404);
  assert.equal((await f.request('/session', { method: 'PUT', body: { sessionId: 'session-b', workspaceId: 'work-b' } })).status, 400);
  assert.equal((await f.request('/session', { method: 'PUT', body: { sessionId: 'session-b' } })).status, 200);
  assert.equal(f.service.me(second.deviceId).sessionId, null);
  const list = await (await f.request('/sessions')).json();
  assert.deepEqual(list.items.map(row => row.sessionId), ['session-a', 'session-b']);
  assert.equal((await f.request('/sessions/session-b/history?limit=-1')).status, 400);
  command(f.service, { action: 'revokeDevice', deviceId: f.pair.deviceId });
  assert.equal((await f.request('/me')).status, 401);
});

test('device summary uses OpenAI Chat Completions with its own credentials and preserves DSH input', async t => {
  const f = await fixture(t);
  command(f.service, { action: 'configure', deviceId: null, kind: 'summary', value: { baseUrl: f.upstream.url + '/v1', model: 'global-model', apiKey: 'global-summary-key' } });
  command(f.service, { action: 'configure', deviceId: f.pair.deviceId, kind: 'summary', value: { baseUrl: f.upstream.url + '/v1', model: 'device-model', apiKey: 'device-summary-key' } });
  const rows = await events(await upload(f, 'override'));
  assert.equal(rows.at(-1).type, 'complete');
  const request = f.upstream.calls.find(call => call.path === '/v1/chat/completions'), body = JSON.parse(request.body);
  assert.equal(request.headers.authorization, 'Bearer device-summary-key');
  assert.equal(body.model, 'device-model'); assert.equal(body.stream, false);
  assert.equal(body.messages[0].role, 'system'); assert.equal(body.messages[1].role, 'user');
  assert.equal(body.messages[1].content, rows.find(row => row.type === 'reply').data.text);
  assert.equal(f.dsh.summaries.length, 0); assert.equal(f.dsh.calls.length, 1);
  assert.ok(!JSON.stringify(f.service.view()).includes('test-provider-secret'));
  assert.ok(!JSON.stringify(f.service.view()).includes('device-summary-key'));
});

test('TTS failures preserve returned original and never report completion or leak upstream errors', async t => {
  const f = await fixture(t); f.upstream.failTts();
  const rows = await events(await upload(f, 'tts-failure'));
  assert.ok(rows.some(row => row.type === 'reply'));
  assert.equal(rows.at(-1).type, 'error'); assert.equal(rows.at(-1).phase, 'tts');
  assert.equal(rows.at(-1).error.code, 'PROVIDER_ERROR');
  assert.ok(!rows.some(row => row.type === 'complete'));
  assert.ok(!JSON.stringify(rows).includes('secret-provider-error'));
});

test('invalid media, missing ID and empty recordings are rejected before DSH execution', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/turns', { method: 'POST', body: { text: 'not voice' } })).status, 415);
  assert.equal((await f.request('/turns', { method: 'POST', body: wav(), headers: { 'Content-Type': 'audio/wav' } })).status, 400);
  assert.equal((await upload(f, 'empty', { body: Buffer.alloc(0) })).status, 400);
  assert.equal(f.dsh.calls.length, 0);
});

test('same session is exclusive; device switch does not retarget an accepted turn; cancel releases the lock', async t => {
  const f = await fixture(t), second = bind(f.service); f.service.select(second.deviceId, 'session-a');
  let entered; const started = new Promise(resolve => { entered = resolve; });
  f.service.voice.transcribe = async (_config, _audio, _type, signal) => { entered(); return abortable(new Promise(() => {}), signal); };
  const response = await upload(f, 'running'); await started;
  assert.equal((await upload(f, 'busy', { token: second.token })).status, 409);
  f.service.select(f.pair.deviceId, 'session-b');
  assert.equal((await f.request('/turns/running', { method: 'DELETE', token: second.token })).status, 404);
  assert.equal((await f.request('/turns/running', { method: 'DELETE' })).status, 200);
  const rows = await events(response); assert.ok(rows.filter(row => row.sessionId).every(row => row.sessionId === 'session-a'));
  assert.equal(rows.at(-1).error.code, 'CANCELLED'); assert.equal(f.service.sessions.size, 0);
});

test('revocation aborts ongoing requests and shutdown drains work', async t => {
  const f = await fixture(t);
  f.service.voice.transcribe = async (_config, _audio, _type, signal) => abortable(new Promise(() => {}), signal);
  const response = await upload(f, 'revoked');
  command(f.service, { action: 'revokeDevice', deviceId: f.pair.deviceId });
  const rows = await events(response); assert.equal(rows.at(-1).error.code, 'DEVICE_REVOKED');
  await f.service.close(); assert.equal(f.service.devices.size, 0);
});

test('HTTP pairing consumes the code and rejects replay', async t => {
  const f = await fixture(t), pending = command(f.service, { action: 'addDevice', name: 'new' }).result;
  const first = await f.request('/pair', { method: 'POST', body: { code: pending.code } }); assert.equal(first.status, 200);
  assert.equal((await f.request('/pair', { method: 'POST', body: { code: pending.code } })).status, 401);
});

test('a disconnected HTTP consumer aborts provider work and releases the session', async t => {
  const f = await fixture(t);
  f.service.voice.transcribe = async (_config, _audio, _type, signal) => abortable(new Promise(() => {}), signal);
  const response = await upload(f, 'disconnect'), job = f.service.devices.get(f.pair.deviceId);
  assert.ok(job);
  await response.body.cancel();
  let timer;
  try { await Promise.race([job.done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('disconnect did not abort')), 2000); })]); }
  finally { clearTimeout(timer); }
  assert.equal(f.service.devices.size, 0); assert.equal(f.dsh.calls.length, 0);
});
