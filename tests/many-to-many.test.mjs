import test from 'node:test';
import assert from 'node:assert/strict';
import { abortable } from '../src/errors.js';
import { createDraft, buildOperations } from '../client/model.js';
import { fixture, command, bind, upload, events } from './helpers.mjs';

test('one credential accesses multiple authorized workspaces with independent session memory and device model configuration', async t => {
  const f = await fixture(t), second = bind(f.service);
  assert.deepEqual((await (await f.request('/workspaces')).json()).items.map(row => row.id), ['work-a']);
  assert.equal((await f.request('/workspace', { method: 'PUT', body: { workspaceId: 'work-b' } })).status, 403);
  command(f.service, { action: 'bindDevice', deviceId: f.pair.deviceId, workspaceId: 'work-b' });
  command(f.service, { action: 'configure', deviceId: f.pair.deviceId, kind: 'asr', value: { baseUrl: f.upstream.url + '/v1', model: 'b-asr' } });
  command(f.service, { action: 'configure', deviceId: f.pair.deviceId, kind: 'tts', value: { baseUrl: f.upstream.url + '/v1', model: 'b-tts', format: 'wav' } });
  command(f.service, { action: 'configure', deviceId: f.pair.deviceId, kind: 'summary', value: { baseUrl: f.upstream.url + '/v1', model: 'b-summary' } });
  const workspaces = await (await f.request('/workspaces')).json();
  assert.deepEqual(workspaces.items.map(row => row.id), ['work-a', 'work-b']);
  assert.deepEqual(f.service.listWorkspaces(second.deviceId).items.map(row => row.id), ['work-a']);
  assert.equal((await f.request('/workspace', { method: 'PUT', body: { workspaceId: 'work-b', deviceId: second.deviceId } })).status, 400);
  const selected = await (await f.request('/workspace', { method: 'PUT', body: { workspaceId: 'work-b' } })).json();
  assert.equal(selected.sessionId, null);
  assert.equal((await upload(f, 'no-b-session')).status, 422);
  assert.equal((await f.request('/session', { method: 'PUT', body: { sessionId: 'session-a' } })).status, 404);
  assert.equal((await f.request('/sessions/session-a/history')).status, 404);
  assert.deepEqual((await (await f.request('/sessions')).json()).items.map(row => row.sessionId), ['session-other']);
  assert.equal((await f.request('/session', { method: 'PUT', body: { sessionId: 'session-other' } })).status, 200);
  const rows = await events(await upload(f, 'b-turn'));
  assert.equal(rows.at(-1).type, 'complete');
  assert.ok(rows.every(row => row.protocol === 2 && row.workspaceId === 'work-b' && row.sessionId === 'session-other'));
  assert.match(f.upstream.calls[0].body, /b-asr/);
  assert.equal(JSON.parse(f.upstream.calls.find(call => call.path === '/v1/audio/speech').body).voice, 'sample');
  assert.equal(JSON.parse(f.upstream.calls.find(call => call.path === '/v1/chat/completions').body).model, 'b-summary');
  assert.equal((await (await f.request('/sessions/session-other/history')).json()).workspaceId, 'work-b');
  await f.request('/workspace', { method: 'PUT', body: { workspaceId: 'work-a' } });
  assert.equal((await (await f.request('/me')).json()).sessionId, 'session-a');
  assert.equal(f.service.me(second.deviceId).workspaceId, 'work-a');
  assert.equal(f.service.me(second.deviceId).sessionId, null);
  await f.request('/workspace', { method: 'PUT', body: { workspaceId: 'work-b' } });
  assert.equal((await (await f.request('/me')).json()).sessionId, 'session-other');
  command(f.service, { action: 'unbindDevice', workspaceId: 'work-b', deviceId: f.pair.deviceId });
  const me = await (await f.request('/me')).json();
  assert.equal(me.workspaceId, null); assert.equal(me.sessionId, null);
  assert.equal((await f.request('/sessions')).status, 422);
  assert.equal((await f.request('/workspace', { method: 'PUT', body: { workspaceId: 'work-b' } })).status, 403);
  assert.equal((await f.request('/workspace', { method: 'PUT', body: { workspaceId: 'work-a' } })).status, 200);
  assert.equal((await (await f.request('/me')).json()).sessionId, 'session-a');
  command(f.service, { action: 'revokeDevice', deviceId: f.pair.deviceId });
  assert.deepEqual(f.store.bindings(f.pair.deviceId), []);
  assert.equal((await f.request('/workspaces')).status, 401);
});

test('device is paired first and then granted two workspaces without pairing again', async t => {
  const f = await fixture(t), view = f.service.view(), draft = createDraft(view);
  draft.devices.push({ id: 'draft-phone', name: '共享手机', saved: false, workspaceIds: [] });
  draft.devices[0].workspaceIds.push('work-b');
  const operations = buildOperations(view, draft);
  assert.equal(operations.filter(row => row.action === 'addDevice').length, 1);
  const result = command(f.service, { action: 'batch', operations });
  const newDevice = result.result.find(row => row.action === 'addDevice').result;
  const pair = f.service.pair(newDevice.code);
  assert.deepEqual(pair.workspaceIds, []); assert.equal(pair.workspaceId, null);
  assert.deepEqual(f.service.me(pair.deviceId).workspaces, []);
  assert.equal(result.view.devices.length, 2);
  assert.equal(f.store.bindings(f.pair.deviceId).length, 2);
  const grantView = f.service.view(), grantDraft = createDraft(grantView);
  grantDraft.devices.find(device => device.id === pair.deviceId).workspaceIds = ['work-a', 'work-b'];
  command(f.service, { action: 'batch', operations: buildOperations(grantView, grantDraft) });
  assert.equal(f.service.me(pair.deviceId).workspaces.length, 2);
  const nextView = f.service.view(), next = createDraft(nextView);
  for (const device of next.devices) device.workspaceIds = ['work-b'];
  command(f.service, { action: 'batch', operations: buildOperations(nextView, next) });
  assert.equal(f.service.me(pair.deviceId).workspaces.length, 1);
  assert.equal(f.store.authenticate(pair.token).id, pair.deviceId);
  assert.equal(f.store.authenticate(f.pair.token).id, f.pair.deviceId);
  command(f.service, { action: 'unbindDevice', deviceId: pair.deviceId, workspaceId: 'work-b' });
  assert.deepEqual(f.service.me(pair.deviceId).workspaces, []);
  command(f.service, { action: 'bindDevice', deviceId: pair.deviceId, workspaceId: 'work-a' });
  assert.equal(f.service.me(pair.deviceId).workspaceId, null, 'granting access must not silently select a workspace');
  f.service.selectWorkspace(pair.deviceId, 'work-a');
  assert.equal(f.store.authenticate(pair.token).id, pair.deviceId);
});

test('workspace switching and unrelated grant removal do not retarget an in-flight voice turn', async t => {
  const f = await fixture(t);
  command(f.service, { action: 'bindDevice', deviceId: f.pair.deviceId, workspaceId: 'work-b' });
  let release;
  f.service.voice.transcribe = async (_config, _audio, _type, signal) => abortable(new Promise(resolve => { release = resolve; }), signal);
  const response = await upload(f, 'fixed-workspace');
  f.service.selectWorkspace(f.pair.deviceId, 'work-b'); f.service.select(f.pair.deviceId, 'session-other');
  command(f.service, { action: 'unbindDevice', deviceId: f.pair.deviceId, workspaceId: 'work-b' });
  release('在原工作区执行');
  const rows = await events(response);
  assert.equal(rows.at(-1).type, 'complete');
  assert.ok(rows.every(row => row.workspaceId === 'work-a' && row.sessionId === 'session-a'));
  assert.equal(f.dsh.calls[0].sessionId, 'session-a');
});

test('removing the in-flight grant cancels only that device; failed batches leave grants and jobs intact', async t => {
  const f = await fixture(t), second = bind(f.service);
  command(f.service, { action: 'bindDevice', deviceId: f.pair.deviceId, workspaceId: 'work-b' });
  f.service.select(second.deviceId, 'session-b');
  f.service.voice.transcribe = async (_config, _audio, _type, signal) => abortable(new Promise(() => {}), signal);
  const firstResponse = await upload(f, 'grant-revoked');
  const secondResponse = await upload(f, 'other-device', { token: second.token });
  const revision = f.service.view().revision;
  assert.throws(() => f.service.command({ action: 'batch', revision, operations: [
    { action: 'unbindDevice', deviceId: f.pair.deviceId, workspaceId: 'work-a' },
    { action: 'bindDevice', deviceId: f.pair.deviceId, workspaceId: 'not-authorized' },
  ] }));
  assert.equal(f.service.view().revision, revision);
  assert.equal(f.service.devices.get(f.pair.deviceId).controller.signal.aborted, false);
  assert.equal(f.store.hasBinding(f.pair.deviceId, 'work-a'), true);
  f.service.selectWorkspace(f.pair.deviceId, 'work-b');
  command(f.service, { action: 'unbindDevice', deviceId: f.pair.deviceId, workspaceId: 'work-a' });
  const rows = await events(firstResponse);
  assert.equal(rows.at(-1).error.code, 'WORKSPACE_FORBIDDEN');
  assert.equal(rows.at(-1).workspaceId, 'work-a');
  assert.equal(f.service.me(f.pair.deviceId).workspaceId, 'work-b');
  assert.equal(f.service.devices.get(second.deviceId).controller.signal.aborted, false);
  command(f.service, { action: 'unbindDevice', deviceId: second.deviceId, workspaceId: 'work-a' });
  assert.equal((await events(secondResponse)).at(-1).error.code, 'WORKSPACE_FORBIDDEN');
  assert.equal(f.store.authenticate(second.token).id, second.deviceId);
  assert.equal(f.dsh.calls.length, 0);
});

test('revoked authorization prevents pending history and session-list responses from returning data', async t => {
  const f = await fixture(t);
  let releaseHistory, releaseSessions;
  f.dsh.history = () => new Promise(resolve => { releaseHistory = resolve; });
  f.dsh.sessions = () => new Promise(resolve => { releaseSessions = resolve; });
  const history = f.service.history(f.pair.deviceId, 'session-a');
  const sessions = f.service.listSessions(f.pair.deviceId);
  const rejectedHistory = assert.rejects(history, { code: 'WORKSPACE_FORBIDDEN' });
  const rejectedSessions = assert.rejects(sessions, { code: 'WORKSPACE_FORBIDDEN' });
  command(f.service, { action: 'unbindDevice', deviceId: f.pair.deviceId, workspaceId: 'work-a' });
  releaseHistory({ items: ['private history'] }); releaseSessions(['private sessions']);
  await Promise.all([rejectedHistory, rejectedSessions]);
});
