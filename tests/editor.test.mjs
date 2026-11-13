import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraft, buildOperations } from '../client/model.js';
import { fixture, fakeDsh, command } from './helpers.mjs';
import { Store } from '../src/store.js';
import { VoxChat } from '../src/service.js';

test('draft collects model edits and device changes into one save', async t => {
  const f = await fixture(t), view = f.service.view(), draft = createDraft(view);
  assert.deepEqual(buildOperations(view, draft), []);
  draft.defaults.asr.model = 'new-asr';
  draft.devices.push({ id: 'local-device', name: '新手机', saved: false, workspaceIds: [] });
  draft.devices[0].workspaceIds = [];
  const operations = buildOperations(view, draft);
  assert.ok(operations.every(op => !JSON.stringify(op).includes('apiKeySet')));
  const result = f.service.command({ action: 'batch', revision: view.revision, operations });
  assert.equal(result.view.revision, view.revision + 1);
  assert.equal(f.store.settings().config.asr.apiKey, 'test-provider-secret');
  assert.equal(result.view.devices.find(row => row.name === '新手机').active_workspace_id, null);
  assert.ok(result.result.find(row => row.action === 'addDevice').result.code);
  assert.equal(f.store.authenticate(f.pair.token).active_workspace_id, null);
  assert.deepEqual(f.store.bindings(f.pair.deviceId), []);
});

test('saving an open settings draft preserves a newer client voice selection', async t => {
  const f = await fixture(t);
  command(f.service, { action: 'saveVoice', voiceId: 'voice-two', name: '第二个音色', value: 'second' });
  const view = f.service.view(), draft = createDraft(view);
  const selected = await f.request('/voice', { method: 'PUT', body: { voiceId: 'voice-two' } });
  assert.equal(selected.status, 200);
  draft.defaults.asr.model = 'edited-in-open-settings';
  const operations = buildOperations(view, draft);
  assert.deepEqual(operations.map(operation => operation.action), ['configure']);
  f.service.command({ action: 'batch', revision: view.revision, operations });
  assert.equal(f.store.settings().config.asr.model, 'edited-in-open-settings');
  assert.equal(f.service.me(f.pair.deviceId).voiceId, 'voice-two');
});

test('invalid batch rolls back all edits and does not revoke or cancel devices', async t => {
  const f = await fixture(t), view = f.service.view();
  let aborted = false;
  f.service.devices.set(f.pair.deviceId, { controller: { abort() { aborted = true; } } });
  try {
    assert.throws(() => f.service.command({ action: 'batch', revision: view.revision, operations: [
      { action: 'revokeDevice', deviceId: f.pair.deviceId },
      { action: 'configure', deviceId: null, kind: 'asr', value: { model: '' } },
    ] }));
    assert.equal(f.store.authenticate(f.pair.token).id, f.pair.deviceId);
    assert.equal(f.service.view().revision, view.revision); assert.equal(aborted, false);
  } finally { f.service.devices.delete(f.pair.deviceId); }
});

test('deselecting a device workspace removes only its grant and preserves shared configuration', async t => {
  const f = await fixture(t), view = f.service.view(), draft = createDraft(view);
  draft.devices[0].workspaceIds = [];
  const operations = buildOperations(view, draft);
  assert.deepEqual(operations.map(op => op.action), ['unbindDevice']);
  f.service.command({ action: 'batch', revision: view.revision, operations });
  assert.ok(f.dsh.workspace('work-a')); assert.deepEqual(f.service.view().workspaces, view.workspaces);
  assert.equal(f.store.authenticate(f.pair.token).id, f.pair.deviceId);
  assert.deepEqual(f.service.listWorkspaces(f.pair.deviceId).items, []);
});

test('invalid new rows cannot be submitted; stale revisions do not overwrite changes', async t => {
  const f = await fixture(t), view = f.service.view(), draft = createDraft(view);
  draft.devices.push({ id: 'new', name: '', saved: false, workspaceIds: [] });
  assert.throws(() => buildOperations(view, draft), /名称/);
  assert.throws(() => f.service.command({ action: 'batch', revision: view.revision - 1,
    operations: [{ action: 'configure', deviceId: null, kind: 'asr', value: null }] }), { code: 'REVISION_CONFLICT' });
  assert.ok(f.store.settings().config.asr);
});

test('unbound devices can configure models before workspace grants; plugin defaults remain required', async t => {
  const store = new Store(':memory:'), service = new VoxChat(store, fakeDsh(), {});
  t.after(() => store.close());
  const revision = service.view().revision;
  for (const action of ['addWorkspace', 'removeWorkspace']) {
    assert.throws(() => command(service, { action, workspaceId: 'work-a' }), { code: 'INVALID_COMMAND' });
  }
  assert.throws(() => command(service, { action: 'addDevice', name: 'legacy', workspaceIds: ['work-a'] }), { code: 'INVALID_REQUEST' });
  assert.equal(service.view().revision, revision);
  assert.equal(store.devices().length, 0);
  const pending = command(service, { action: 'addDevice', name: '先配对' }).result;
  const paired = service.pair(pending.code);
  assert.deepEqual(paired.workspaceIds, []); assert.equal(paired.workspaceId, null);
  assert.equal(store.workspaces().length, 0);
  assert.throws(() => command(service, { action: 'batch', operations: [
    { action: 'bindDevice', deviceId: paired.deviceId, workspaceId: 'work-a' },
    { action: 'configure', deviceId: paired.deviceId, kind: 'asr', value: {} },
  ] }));
  assert.equal(store.workspaces().length, 0, 'a failed save also rolls back automatic registration');
  for (const kind of ['asr', 'tts']) command(service, { action: 'configure', deviceId: paired.deviceId, kind,
    value: { baseUrl: 'http://example.test/v1', model: kind } });
  assert.equal(service.ready(paired.deviceId).asr, false);
  command(service, { action: 'bindDevice', deviceId: paired.deviceId, workspaceId: 'work-a' });
  service.selectWorkspace(paired.deviceId, 'work-a'); service.select(paired.deviceId, 'session-a');
  await assert.rejects(service.run(paired.deviceId, 'required-defaults', () => { throw new Error('must not read audio'); }, () => {}, new AbortController().signal), { code: 'VOICE_NOT_CONFIGURED' });
  for (const kind of ['asr', 'tts']) assert.throws(() => command(service, { action: 'configure', deviceId: null, kind, value: null }), { code: 'REQUIRED_MODEL_CONFIG' });
  command(service, { action: 'configure', deviceId: null, kind: 'summary', value: null });
});
