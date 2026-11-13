import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as plugin from '../src/index.js';
import { provider, events, wav } from './helpers.mjs';
import { Store } from '../src/store.js';

test('native DSH plugin mounts, resumes history, preserves original and summarizes via inherited model', {
  skip: !process.env.DSH_TEST_PACKAGE, timeout: 30_000,
}, async t => {
  const requireHost = createRequire(process.env.DSH_TEST_PACKAGE);
  const load = async name => import(pathToFileURL(requireHost.resolve('@deepseek-ai/' + name)));
  const { Context, Service } = await load('cordis'), ctx = new Context(), fibers = [];
  const dir = await mkdtemp(join(tmpdir(), 'voxchat-native-'));
  const mount = async (name, config = {}) => {
    const module = await load(name), fiber = ctx.plugin(module.default ?? module, config);
    fibers.push(fiber); await fiber.await(); return module;
  };
  const errors = [];
  ctx.logger.exporter({ export(event) { if (event.type === 'error') errors.push(event); } });
  t.after(async () => {
    const cleanupErrors = [];
    for (const fiber of fibers.reverse()) {
      try { await fiber.dispose(); } catch (error) { cleanupErrors.push(error); }
    }
    await rm(dir, { recursive: true, force: true });
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'DSH host cleanup failed');
    assert.deepEqual(errors, [], 'DSH host should not emit errors');
  });
  await mount('dsh-storage'); await mount('dsh-storage-json', { root: join(dir, 'storage') }); await mount('dsh-storage-domain', { backend: 'json' });
  await mount('dsh-typert-registry'); await mount('dsh-session'); await mount('dsh-session-projection');
  await mount('dsh-session-persistence-jsonl', { root: join(dir, 'sessions'), compression: 'none' });
  await mount('dsh-workspace'); await mount('dsh-system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: false });
  await mount('dsh-attachment-local', { dshHome: join(dir, 'attachments') });
  await mount('dsh-tools'); await mount('dsh-skill'); await mount('dsh-agent');
  const { LlmAdapter } = await mount('dsh-llm');
  const modelCalls = [], fullReply = '已完成需求中的工作。以下是完整原文及详细执行结果，仍有一项需要用户确认。'.repeat(30);
  class Model extends LlmAdapter {
    async *stream(options) {
      modelCalls.push(options);
      const text = options.system?.startsWith('你负责将 DSH') ? '工作已完成，但仍有一项需要你确认，详情请查看原文。' : fullReply;
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const modelFiber = ctx.plugin({ name: 'voxchat-test-model', inject: ['llm'], apply(c) { c.llm.registerAdapter(['vox-test'], new Model()); } });
  fibers.push(modelFiber); await modelFiber.await();
  await mount('dsh-agent-loop', { agents: [] });
  await mount('dsh-fs-local', { cwd: dir });
  await mount('dsh-agent-default-model', { provider: 'vox-test', model: 'native-model' });
  await mount('dsh-api-remote-access');
  await mount('dsh-session-query-sqlite', { path: join(dir, 'query.sqlite'), openAt: 'first-search' });
  class FileUploads extends Service { constructor(c) { super(c, 'fileUploads'); } registerAgentResolver() { return () => {}; } }
  const uploadFiber = ctx.plugin(FileUploads); fibers.push(uploadFiber); await uploadFiber.await();
  await mount('dsh-api-session-controller', { nativeOpen: false });
  await mount('dsh-host-webserver', { host: '127.0.0.1', port: 0 });
  ctx.provide('profileContext', { dir, home: dir }); ctx.provide('settings', { writable: true, configure: () => () => {} });
  const workspacePath = join(dir, 'work'); await mkdir(workspacePath);
  const workspace = await ctx.workspaceRegistry.create(workspacePath, '语音工作区');
  const created = await ctx.sessionController.create({ workspaceId: workspace.id });
  assert.ok(workspace.sessionIds.includes(created.sessionId));
  const upstream = await provider(t);
  const stored = new Store(join(dir, 'data', 'voxchat.sqlite'));
  stored.setConfig({ pairingOrigin: 'https://native.example.test' }); stored.close();
  let pluginFiber = ctx.plugin(plugin); fibers.push(pluginFiber); await pluginFiber.await();
  assert.equal(ctx.remoteAccess.decide({ principal: { kind: 'owner' }, action: 'voxchat/command', resources: [{ kind: 'global' }] }).kind, 'allow');
  assert.equal(ctx.remoteAccess.decide({ principal: { kind: 'voxchat-device' }, action: 'voxchat/command', resources: [{ kind: 'global' }] }).kind, 'deny');
  const command = value => {
    const result = ctx.voxchat.command({ ...value, revision: ctx.voxchat.view().revision });
    assert.equal(result.accepted, true, result.error?.message); return result;
  };
  for (const kind of ['asr', 'tts']) command({ action: 'configure', deviceId: null, kind,
    value: { baseUrl: upstream.url + '/v1', model: kind, ...(kind === 'tts' ? { format: 'wav' } : {}) } });
  command({ action: 'saveVoice', voiceId: 'native-voice', name: '测试音色', value: 'test' });
  const pairing = command({ action: 'addDevice', name: 'Native test' }).result;
  const base = ctx.webServer.getOrigin() + '/voxchat/api';
  t.diagnostic('Native DSH endpoint: ' + base);
  const pairResponse = await fetch(base + '/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pairing.code }) });
  assert.equal(pairResponse.status, 200); const pair = await pairResponse.json();
  assert.deepEqual(pair.workspaceIds, []); assert.equal(pair.workspaceId, null);
  const headers = { Authorization: 'Bearer ' + pair.token };
  const voices = await (await fetch(base + '/voices', { headers })).json();
  assert.deepEqual(voices, { voiceId: null, items: [{ id: 'native-voice', name: '测试音色', value: 'test' }] });
  const chooseVoice = await fetch(base + '/voice', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ voiceId: 'native-voice' }) });
  assert.equal(chooseVoice.status, 200); assert.equal((await chooseVoice.json()).voiceId, 'native-voice');
  assert.equal((await fetch(base + '/sessions', { headers })).status, 422);
  command({ action: 'bindDevice', workspaceId: workspace.id, deviceId: pair.deviceId });
  const chooseWorkspace = await fetch(base + '/workspace', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: workspace.id }) });
  assert.equal(chooseWorkspace.status, 200);
  const selected = await fetch(base + '/session', { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: created.sessionId }) });
  assert.equal(selected.status, 200);
  const response = await fetch(base + '/turns', { method: 'POST', headers: { ...headers, 'Content-Type': 'audio/wav', 'X-Request-Id': 'native-1' }, body: wav() });
  const rows = await events(response);
  assert.equal(rows.at(-1).type, 'complete', JSON.stringify(rows));
  assert.equal(rows.find(row => row.type === 'reply').data.text, fullReply);
  assert.ok(rows.some(row => row.type === 'dsh.event' && row.data.type === 'assistant/message'));
  assert.ok(rows.find(row => row.type === 'speech.text').data.text.length < fullReply.length);
  assert.equal(modelCalls.length, 2);
  assert.equal(modelCalls[1].provider, 'vox-test'); assert.equal(modelCalls[1].model, 'native-model');
  const original = await ctx.sessionController.inspect(created.sessionId);
  assert.equal(original.events.filter(event => event.type === 'user/message').length, 1);
  assert.ok(JSON.stringify(original.events).includes(fullReply));
  assert.ok(!JSON.stringify(original.events).includes('你负责将 DSH'));
  const history = await (await fetch(base + '/sessions/' + created.sessionId + '/history', { headers })).json();
  assert.ok(history.items.some(event => event.type === 'assistant/message'));
  const list = await (await fetch(base + '/sessions', { headers })).json();
  assert.ok(list.items.some(item => item.sessionId === created.sessionId));
  await ctx.sessionPersistence.flush();
  await pluginFiber.dispose(); fibers.pop();
  assert.equal((await fetch(base + '/me', { headers })).status, 404);
  pluginFiber = ctx.plugin(plugin); fibers.push(pluginFiber); await pluginFiber.await();
  const restored = await fetch(base + '/me', { headers });
  assert.equal(restored.status, 200);
  const me = await restored.json();
  assert.equal(me.voiceId, 'native-voice'); assert.deepEqual(me.voices, voices.items);
  const repeat = await fetch(base + '/turns', { method: 'POST', headers: { ...headers, 'Content-Type': 'audio/wav', 'X-Request-Id': 'native-1' }, body: wav() });
  assert.equal(repeat.status, 409);
  const second = await events(await fetch(base + '/turns', { method: 'POST', headers: { ...headers, 'Content-Type': 'audio/wav', 'X-Request-Id': 'native-2' }, body: wav() }));
  assert.equal(second.at(-1).type, 'complete');
  const after = await ctx.sessionController.inspect(created.sessionId);
  assert.equal(after.events.filter(event => event.type === 'user/message').length, 2);
  assert.ok(JSON.stringify(modelCalls[2].messages).includes(fullReply), 'existing session history was reused');
  const secondPath = join(dir, 'second-work'); await mkdir(secondPath);
  const secondWorkspace = await ctx.workspaceRegistry.create(secondPath, '第二工作区');
  const secondSession = await ctx.sessionController.create({ workspaceId: secondWorkspace.id });
  command({ action: 'bindDevice', deviceId: pair.deviceId, workspaceId: secondWorkspace.id });
  command({ action: 'configure', deviceId: pair.deviceId, kind: 'summary', value: { baseUrl: upstream.url + '/v1', model: 'independent-summary' } });
  const granted = await (await fetch(base + '/workspaces', { headers })).json();
  assert.deepEqual(granted.items.map(row => row.id), [workspace.id, secondWorkspace.id]);
  const selectJson = (path, body) => fetch(base + path, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await selectJson('/workspace', { workspaceId: secondWorkspace.id })).status, 200);
  assert.equal((await selectJson('/session', { sessionId: secondSession.sessionId })).status, 200);
  const third = await events(await fetch(base + '/turns', { method: 'POST', headers: { ...headers, 'Content-Type': 'audio/wav', 'X-Request-Id': 'native-3' }, body: wav() }));
  assert.equal(third.at(-1).type, 'complete');
  assert.ok(third.every(row => row.workspaceId === secondWorkspace.id && row.sessionId === secondSession.sessionId && row.protocol === 2));
  assert.equal((await ctx.sessionController.inspect(created.sessionId)).events.filter(event => event.type === 'user/message').length, 2);
  const back = await (await selectJson('/workspace', { workspaceId: workspace.id })).json();
  assert.equal(back.sessionId, created.sessionId);
});
