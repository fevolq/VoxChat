import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { Store } from '../src/store.js';
import { Voice } from '../src/voice.js';
import { VoxChat } from '../src/service.js';
import { createHandler } from '../src/http.js';
import { ApiError } from '../src/errors.js';

export async function listen(t, handler) {
  const server = createServer(handler);
  // Stay in the dynamic/private range to avoid ports that Fetch blocks on some systems.
  while (true) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(randomInt(49152, 65536), '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      break;
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { server, url: 'http://127.0.0.1:' + server.address().port };
}
export const wav = () => {
  const buffer = Buffer.alloc(44 + 4800);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(24000, 24); buffer.writeUInt32LE(48000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(4800, 40); return buffer;
};
export async function provider(t) {
  const calls = []; let failTts = false;
  const { url } = await listen(t, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString(); calls.push({ path: req.url, headers: req.headers, body });
    if (req.url === '/v1/audio/transcriptions') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: '请告诉我执行结果' }));
    } else if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '已完成测试。' }, finish_reason: 'stop' }] }));
    } else if (req.url === '/v1/audio/speech') {
      if (failTts) { res.writeHead(503); res.end('secret-provider-error'); return; }
      const audio = wav(); res.writeHead(200, { 'Content-Type': 'audio/wav' }); res.write(audio.subarray(0, 44));
      setImmediate(() => res.end(audio.subarray(44)));
    } else { res.writeHead(404); res.end(); }
  });
  return { url, calls, failTts: () => { failTts = true; } };
}
export function fakeDsh() {
  const workspaces = [{ id: 'work-a', title: 'A', path: '/a', sessionIds: ['session-a', 'session-b'] }, { id: 'work-b', title: 'B', path: '/b', sessionIds: ['session-other'] }];
  const calls = [], summaries = [];
  return {
    calls, summaries, workspaces: () => workspaces,
    workspace(id) { const value = workspaces.find(row => row.id === id); if (!value) throw new ApiError(404, 'WORKSPACE_UNAVAILABLE', 'missing'); return value; },
    assertSession(workspaceId, sessionId) { if (!this.workspace(workspaceId).sessionIds.includes(sessionId)) throw new ApiError(404, 'SESSION_NOT_FOUND', 'outside workspace'); },
    busy: () => false,
    async sessions(workspaceId) { return this.workspace(workspaceId).sessionIds.map(sessionId => ({ sessionId })); },
    async history(workspaceId, sessionId) { this.assertSession(workspaceId, sessionId); return { sessionId, items: calls.filter(call => call.sessionId === sessionId) }; },
    async run(workspaceId, sessionId, messageId, text, emit, signal) {
      signal.throwIfAborted(); this.assertSession(workspaceId, sessionId);
      calls.push({ sessionId, text }); emit({ type: 'tool/call', data: { name: 'test-tool' } });
      return { text: '完整回复：已完成测试，保留原文和全部细节。', model: { provider: 'session-provider', model: 'session-model' } };
    },
    async summarize(model, input, system, signal) { signal.throwIfAborted(); summaries.push({ model, input, system }); return '已完成测试。'; },
  };
}
export function command(service, value) { return service.command({ ...value, revision: service.view().revision }); }
export function addBoundDevice(store, name, workspaceIds) {
  const device = store.addDevice(name);
  for (const workspaceId of workspaceIds) store.bind(device.id, workspaceId);
  if (workspaceIds.length) store.selectWorkspace(device.id, workspaceIds[0]);
  return device;
}
export function bind(service, workspaceId = 'work-a', name = 'phone') {
  const { result } = command(service, { action: 'addDevice', name });
  const paired = service.pair(result.code);
  command(service, { action: 'bindDevice', deviceId: paired.deviceId, workspaceId });
  service.selectWorkspace(paired.deviceId, workspaceId);
  service.selectVoice(paired.deviceId, 'test-voice');
  return paired;
}
export async function fixture(t) {
  const upstream = await provider(t), dsh = fakeDsh(), store = new Store(':memory:');
  const service = new VoxChat(store, dsh, new Voice(dsh));
  for (const kind of ['asr', 'tts']) command(service, { action: 'configure', deviceId: null, kind,
    value: { baseUrl: upstream.url + '/v1', apiKey: 'test-provider-secret', model: kind + '-model', ...(kind === 'tts' ? { format: 'wav' } : {}) } });
  command(service, { action: 'saveVoice', voiceId: 'test-voice', name: '测试音色', value: 'sample' });
  const pair = bind(service); service.select(pair.deviceId, 'session-a');
  t.after(async () => { await service.close(); store.close(); });
  const { url } = await listen(t, createHandler(service));
  const request = async (path, { method = 'GET', body, token = pair.token, headers = {} } = {}) => fetch(url + '/voxchat/api' + path, {
    method, body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body),
    headers: { Authorization: 'Bearer ' + token, ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
  });
  return { upstream, dsh, store, service, pair, request, url };
}
export const upload = (f, requestId, options = {}) => f.request('/turns', { method: 'POST', body: wav(), headers: { 'Content-Type': 'audio/wav', 'X-Request-Id': requestId }, ...options });
export async function events(response) { return (await response.text()).trim().split('\n').map(line => JSON.parse(line)); }
