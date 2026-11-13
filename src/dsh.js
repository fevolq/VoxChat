import { ApiError, abortable, requireValue } from './errors.js';

const VISIBLE = new Set(['turn/start', 'turn/end', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'deliverables/presented']);
export function visibleEvent(event) {
  if (!VISIBLE.has(event.type)) return null;
  const copy = structuredClone(event);
  // Return visible content, never provider replay state or reasoning blocks.
  if (copy.data?.message) {
    const { id, role, content } = copy.data.message;
    copy.data.message = { id, role, content: (content ?? []).filter(block => ['text', 'tool-call', 'tool-result', 'image', 'file'].includes(block.type))
      .map(block => { const { replay, ...value } = block; return value; }) };
  }
  return copy;
}
export function finalText(events, messageId) {
  let start = -1, matched = false;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.type === 'turn/start') { start = i; matched = false; }
    if (event.type === 'user/message' && event.data.id === messageId && start >= 0) matched = true;
    if (event.type === 'turn/end' && matched) {
      requireValue(event.data.reason?.kind === 'completed', 502, 'DSH_TURN_FAILED', 'DSH 本轮未正常完成，请在 DSH 中查看详情');
      const last = events.slice(start, i).findLast(row => row.type === 'assistant/message');
      const blocks = last?.data.message?.content ?? [];
      const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('\n').trim();
      requireValue(text && !blocks.some(block => block.type === 'tool-call'), 502, 'EMPTY_REPLY', 'DSH 未产生可播报的最终文字回复');
      return text;
    }
  }
  throw new ApiError(502, 'DSH_TURN_INCOMPLETE', '未找到本轮 DSH 回复');
}

export class DshAdapter {
  constructor(host) {
    this.host = host;
    for (const [name, method] of [['workspaceRegistry', 'list'], ['sessionController', 'inspect'], ['sessionController', 'list'],
      ['sessionController', 'resolveAgent'], ['llm', 'stream']]) {
      if (typeof host[name]?.[method] !== 'function') throw new Error(`VoxChat requires DSH ${name}.${method}`);
    }
    if (typeof host.sessionController.agents?.selectionFor !== 'function') throw new Error('VoxChat requires DSH 0.2.1 session model selection');
  }
  workspaces() { return this.host.workspaceRegistry.list().map(({ id, title, path }) => ({ id, title, path })); }
  workspace(id) {
    const workspace = this.host.workspaceRegistry.list().find(row => row.id === id);
    requireValue(workspace, 404, 'WORKSPACE_UNAVAILABLE', 'DSH 工作区已不存在');
    return workspace;
  }
  assertSession(workspaceId, sessionId) {
    requireValue(this.workspace(workspaceId).sessionIds.includes(sessionId), 404, 'SESSION_NOT_FOUND', '会话不属于绑定工作区或已不存在');
  }
  busy(sessionId) {
    const agent = this.host.agents.get(sessionId);
    return Boolean(agent && (agent.status !== 'idle' || agent.inbox.nextTurn.length));
  }
  async sessions(workspaceId, signal) {
    this.workspace(workspaceId);
    const result = await this.host.sessionController.list({}, signal);
    const ids = new Set(this.workspace(workspaceId).sessionIds);
    return result.items.filter(row => ids.has(row.sessionId) && row.origin !== 'subagent');
  }
  async history(workspaceId, sessionId, before, limit, signal) {
    this.assertSession(workspaceId, sessionId);
    const snapshot = await this.host.sessionController.inspect(sessionId, signal);
    this.assertSession(workspaceId, sessionId);
    const events = snapshot.events.filter(event => before === undefined || event.seq < before).map(visibleEvent).filter(Boolean);
    const items = events.slice(-limit);
    return { sessionId, items, hasMore: events.length > items.length, before: items[0]?.seq ?? null };
  }
  async run(workspaceId, sessionId, messageId, text, onEvent, signal) {
    this.assertSession(workspaceId, sessionId);
    const resolved = await abortable(this.host.sessionController.resolveAgent(sessionId), signal);
    if (resolved.error) throw new ApiError(409, 'SESSION_UNAVAILABLE', '无法激活 DSH 会话，请在 DSH 中检查状态');
    this.assertSession(workspaceId, sessionId);
    const agent = resolved.agent;
    requireValue(!this.busy(sessionId), 409, 'SESSION_BUSY', 'DSH 会话正在处理其他请求');
    requireValue(!this.host.workspaceRegistry.archivedSessionIds.includes(sessionId), 409, 'SESSION_ARCHIVED', '请先在 DSH 中取消会话归档');
    const initialModel = { ...this.host.sessionController.agents.selectionFor(agent).current };
    let turn, sent = false, ended = false;
    let finish, fail;
    const completed = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const disposers = [];
    const end = error => {
      if (ended) return;
      ended = true;
      queueMicrotask(() => {
        if (error) { fail(error); return; }
        try {
          const text = finalText(agent.session.snapshotEvents(), messageId);
          const config = agent.session.requestHeader()?.config ?? initialModel;
          finish({ text, model: { provider: config.provider, model: config.model, ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}) } });
        } catch (error) { fail(error); }
      });
    };
    const cancel = () => {
      if (sent && !ended) {
        const removed = agent.inbox.remove(messageId);
        if (!removed && turn !== undefined) agent.cancel({ kind: 'hook', reason: 'VoxChat request stopped' }, { keepInbox: true });
      }
      end(signal.reason ?? new ApiError(499, 'CANCELLED', '请求已取消'));
    };
    try {
      disposers.push(agent.ctx.on('agent/inbox/claimed', payload => {
        if (payload.agent === agent && payload.message.id === messageId) turn = payload.turn;
      }));
      disposers.push(agent.ctx.on('agent/inbox/discarded', payload => {
        if (payload.agent === agent && payload.message.id === messageId) end(new ApiError(409, 'MESSAGE_DISCARDED', 'DSH 输入已被移除'));
      }));
      disposers.push(agent.ctx.on('session/event', (source, event) => {
        if (source !== agent.session || turn === undefined || event.data?.turn !== turn || ended) return;
        const visible = visibleEvent(event);
        if (visible) {
          try { onEvent(visible); } catch (error) { cancel(); end(error); }
        }
        if (event.type === 'turn/end') end();
      }));
      signal.addEventListener('abort', cancel, { once: true });
      signal.throwIfAborted();
      sent = true;
      agent.followup({ id: messageId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
      void agent.whenIdle().then(() => end(new ApiError(502, 'DSH_TURN_INCOMPLETE', 'DSH 会话已结束但没有完整结果')), end);
      return await completed;
    } catch (error) {
      cancel();
      await completed.catch(() => {});
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
      for (const dispose of disposers.reverse()) dispose();
    }
  }
  async summarize(model, input, system, signal) {
    const blocks = new Map();
    let finished = false;
    for await (const chunk of this.host.llm.stream({ ...model, system, messages: [{ role: 'user', content: [{ type: 'text', text: input }] }], maxTokens: 1500, signal })) {
      signal.throwIfAborted();
      if (chunk.type === 'text-delta') blocks.set(chunk.index, (blocks.get(chunk.index) ?? '') + chunk.text);
      if (chunk.type === 'block-end' && chunk.block.type === 'text') blocks.set(chunk.index, chunk.block.text);
      if (chunk.type === 'finish') {
        requireValue(chunk.reason.kind === 'stop', 502, 'SUMMARY_FAILED', '总结模型未正常完成回复');
        finished = true;
      }
    }
    const text = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join('').trim();
    requireValue(finished && text, 502, 'SUMMARY_FAILED', '总结模型没有返回完整播报稿');
    return text;
  }
}
