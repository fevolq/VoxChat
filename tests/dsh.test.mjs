import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DshAdapter, finalText, visibleEvent } from '../src/dsh.js';
import { ApiError } from '../src/errors.js';

test('final reply follows submitted message identity, ignores other turns and rejects failed turns', () => {
  const turn = (number, id, text, kind = 'completed') => [
    { type: 'turn/start', data: { turn: number } }, { type: 'user/message', data: { turn: number, id } },
    { type: 'assistant/message', data: { turn: number, message: { content: [{ type: 'text', text }] } } },
    { type: 'turn/end', data: { turn: number, reason: { kind } } },
  ];
  assert.equal(finalText([...turn(1, 'ours', 'ours'), ...turn(2, 'other', 'other')], 'ours'), 'ours');
  assert.throws(() => finalText(turn(1, 'ours', 'unfinished', 'error'), 'ours'), { code: 'DSH_TURN_FAILED' });
  assert.equal(visibleEvent({ type: 'request/start', data: { credential: 'secret' } }), null);
  const visible = visibleEvent({ type: 'assistant/message', data: { message: { role: 'assistant', replay: 'private', content: [{ type: 'thinking', text: 'private' }, { type: 'text', text: 'public', replay: 'private' }] } } });
  assert.ok(!JSON.stringify(visible).includes('private'));
});

test('cancellation removes only our queued message and does not cancel another active turn', async () => {
  const bus = new EventEmitter(), removed = [], cancelled = [];
  const agent = {
    status: 'idle', inbox: { nextTurn: [], remove: id => { removed.push(id); return true; } },
    session: { snapshotEvents: () => [], requestHeader: () => null },
    ctx: { on: (name, callback) => { bus.on(name, callback); return () => bus.off(name, callback); } },
    followup() {}, whenIdle: () => new Promise(() => {}), cancel: value => cancelled.push(value),
  };
  const host = {
    agents: { get: () => agent }, workspaceRegistry: { list: () => [{ id: 'work', sessionIds: ['session'] }], archivedSessionIds: [] },
    sessionController: { inspect() {}, list() {}, resolveAgent: async () => ({ agent }), agents: { selectionFor: () => ({ current: { provider: 'p', model: 'm' } }) } },
    llm: { stream() {} },
  };
  const adapter = new DshAdapter(host), controller = new AbortController();
  const run = adapter.run('work', 'session', 'ours', 'text', () => {}, controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new ApiError(499, 'CANCELLED', 'cancel'));
  await assert.rejects(run, { code: 'CANCELLED' });
  assert.deepEqual(removed, ['ours']); assert.deepEqual(cancelled, []);
  assert.equal(bus.eventNames().length, 0);
});
