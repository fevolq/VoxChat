import test from 'node:test';
import assert from 'node:assert/strict';
import { Voice } from '../src/voice.js';
import { fixture, upload, events, command } from './helpers.mjs';

test('long reply includes its ending in summarization; excessive output fails instead of being truncated', async () => {
  const inputs = [], signal = new AbortController().signal;
  const voice = new Voice({ async summarize(_model, input) { inputs.push(input); return '摘要'; } });
  const original = '开头' + '内容'.repeat(7000) + '末尾关键失败';
  assert.equal(await voice.script(null, { provider: 'p', model: 'm' }, original, signal), '摘要');
  assert.equal(inputs.slice(0, 2).join(''), original); assert.match(inputs[1], /末尾关键失败/);
  const tooLong = new Voice({ async summarize() { return '长'.repeat(900); } });
  await assert.rejects(tooLong.script(null, { provider: 'p', model: 'm' }, '原文', signal), { code: 'SUMMARY_TOO_LONG' });
});

test('ASR empty transcription does not send a DSH message', async t => {
  const f = await fixture(t);
  f.service.voice.fetch = async () => new Response(JSON.stringify({ text: ' ' }), { headers: { 'Content-Type': 'application/json' } });
  const rows = await events(await upload(f, 'empty-asr'));
  assert.equal(rows.at(-1).error.code, 'EMPTY_TRANSCRIPT'); assert.equal(f.dsh.calls.length, 0);
});

test('successful TTS HTTP response with JSON instead of audio is rejected', async t => {
  const f = await fixture(t), originalFetch = f.service.voice.fetch;
  f.service.voice.fetch = async (url, options) => url.endsWith('/audio/speech')
    ? new Response('{"error":"bad"}', { headers: { 'Content-Type': 'application/json' } }) : originalFetch(url, options);
  const rows = await events(await upload(f, 'bad-audio'));
  assert.equal(rows.at(-1).error.code, 'INVALID_AUDIO_RESPONSE'); assert.ok(!rows.some(row => row.type === 'audio.chunk'));
});

test('independent OpenAI summary includes the complete long reply and authenticates each request', async () => {
  const requests = [], config = { baseUrl: 'https://summary.example/v1', model: 'summary-model', apiKey: 'summary-secret' };
  const voice = new Voice({}, async (url, options) => {
    requests.push({ url, ...options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: '完整摘要' }, finish_reason: 'stop' }] }));
  });
  const original = '前文' + '内容'.repeat(8000) + '最后一步失败，请用户检查';
  assert.equal(await voice.script(config, null, original, new AbortController().signal), '完整摘要');
  assert.equal(requests.length, 3);
  assert.equal(requests.slice(0, 2).map(request => request.body.messages[1].content).join(''), original);
  assert.ok(requests.every(request => request.url === 'https://summary.example/v1/chat/completions'
    && request.headers.Authorization === 'Bearer summary-secret' && request.body.model === 'summary-model'));
});

test('truncated, refused or malformed summaries fail before TTS without exposing upstream content', async t => {
  const f = await fixture(t), originalFetch = f.service.voice.fetch;
  command(f.service, { action: 'configure', deviceId: null, kind: 'summary', value: { baseUrl: f.upstream.url + '/v1', model: 'summary' } });
  const failures = [
    { choices: [{ message: { content: 'secret incomplete text' }, finish_reason: 'length' }] },
    { choices: [{ message: { content: '', refusal: 'secret refusal' }, finish_reason: 'stop' }] },
    { choices: [{ message: { content: 'secret text', tool_calls: [{}] }, finish_reason: 'stop' }] },
    { choices: [{ message: { content: '  ' }, finish_reason: 'stop' }] },
    'not-json-secret',
  ];
  for (const [index, value] of failures.entries()) {
    f.service.voice.fetch = async (url, options) => url.endsWith('/chat/completions')
      ? new Response(typeof value === 'string' ? value : JSON.stringify(value)) : originalFetch(url, options);
    const rows = await events(await upload(f, 'summary-failed-' + index));
    assert.ok(rows.some(row => row.type === 'reply'));
    assert.equal(rows.at(-1).phase, 'summary'); assert.equal(rows.at(-1).error.code, 'SUMMARY_FAILED');
    assert.ok(!rows.some(row => row.type === 'speech.text' || row.type === 'complete'));
    assert.ok(!JSON.stringify(rows).includes('secret'));
  }
  assert.equal(f.upstream.calls.filter(row => row.path === '/v1/audio/speech').length, 0);
});
