import { randomUUID } from 'node:crypto';
import { effective, id, keys, modelConfig, pairingOrigin, redact, text } from './config.js';
import { ApiError, requireValue } from './errors.js';
import { LIMITS, PROTOCOL } from './contracts.js';

export class VoxChat {
  constructor(store, dsh, voice) {
    this.store = store; this.dsh = dsh; this.voice = voice;
    this.devices = new Map(); this.sessions = new Map(); this.requests = new Set(); this.closed = false;
  }
  view() {
    const { revision, config } = this.store.settings();
    const available = this.dsh.workspaces();
    return { revision, defaults: redact(config), pairingOrigin: config.pairingOrigin ?? '', connection: this.connection?.view() ?? null, voices: this.store.voices(), available,
      devices: this.store.devices().map(device => ({ ...device, config: redact(device.config),
        sources: Object.fromEntries(['asr', 'tts', 'summary'].map(kind => [kind, device.config[kind] ? 'device' : config[kind] ? 'plugin' : kind === 'summary' ? 'session' : 'missing'])) })),
      bindings: this.store.bindings(), workspaces: this.store.workspaces().map(row => ({ id: row.id, workspace: available.find(item => item.id === row.id) ?? null })) };
  }
  command(command) {
    requireValue(!this.closed, 503, 'STOPPING', '插件正在停止');
    const batch = command?.action === 'batch';
    if (batch) {
      keys(command, ['action', 'revision', 'operations']);
      requireValue(Array.isArray(command.operations) && command.operations.length > 0 && command.operations.length <= 200,
        400, 'INVALID_COMMAND', '保存操作数量必须在 1–200 之间');
    }
    const operations = batch ? command.operations : [command];
    const fields = {
      configure: ['deviceId', 'kind', 'value'],
      addDevice: ['name'], revokeDevice: ['deviceId'], refreshPairing: ['deviceId'],
      saveVoice: ['voiceId', 'name', 'value'], removeVoice: ['voiceId'], configurePairing: ['origin'], retryTunnel: [],
      bindDevice: ['workspaceId', 'deviceId'], unbindDevice: ['workspaceId', 'deviceId'],
    };
    for (const operation of operations) {
      requireValue(Object.hasOwn(fields, operation?.action ?? ''), 400, 'INVALID_COMMAND', '未知管理操作');
      keys(operation, ['action', ...(batch ? [] : ['revision']), ...fields[operation.action]]);
    }
    if (operations.some(command => command.action === 'retryTunnel')) {
      requireValue(!batch && this.connection?.state.mode === 'tunnel' && this.connection.state.status === 'error',
        409, 'TUNNEL_NOT_FAILED', '仅自动隧道失败后可以单独重试');
    }
    const results = this.store.mutate(command.revision, () => operations.map(command => {
      let result = null;
      switch (command.action) {
        case 'configure': {
          const deviceId = command.deviceId === null ? null : id(command.deviceId);
          requireValue(deviceId !== null || command.kind === 'summary' || command.value !== null,
            422, 'REQUIRED_MODEL_CONFIG', '插件级 ASR 和 TTS 必须配置');
          const config = deviceId === null ? this.store.settings().config : this.store.device(deviceId).config;
          const value = modelConfig(command.kind, command.value, config[command.kind]);
          if (deviceId === null) this.store.setConfig({ ...config, [command.kind]: value });
          else this.store.setDeviceConfig(deviceId, { ...config, [command.kind]: value });
          break;
        }
        case 'addDevice': result = this.store.addDevice(text(command.name, '设备名称', 80)); break;
        case 'bindDevice': {
          this.dsh.workspace(id(command.workspaceId)); this.store.device(id(command.deviceId));
          if (!this.store.workspaces().some(row => row.id === command.workspaceId)) this.store.addWorkspace(command.workspaceId);
          this.store.bind(command.deviceId, command.workspaceId); break;
        }
        case 'unbindDevice': this.store.unbind(id(command.deviceId), id(command.workspaceId)); break;
        case 'revokeDevice': this.store.revoke(id(command.deviceId)); break;
        case 'refreshPairing': result = this.store.refreshPairing(id(command.deviceId)); break;
        case 'saveVoice': this.store.saveVoice(id(command.voiceId), text(command.name, '音色名称', 80), text(command.value, '音色 ID', 200)); break;
        case 'removeVoice': this.store.removeVoice(id(command.voiceId)); break;
        case 'configurePairing': this.store.setConfig({ ...this.store.settings().config, pairingOrigin: pairingOrigin(command.origin) }); break;
        case 'retryTunnel': break;
      }
      return { action: command.action, deviceId: command.deviceId ?? null, workspaceId: command.workspaceId ?? null, result };
    }));
    // Cancel only after commit, and only when the job's own authorization was removed.
    const existing = new Set(this.store.devices().map(device => device.id));
    for (const [deviceId, job] of this.devices) {
      if (!existing.has(deviceId)) job.controller.abort(new ApiError(401, 'DEVICE_REVOKED', '设备已撤销'));
      else if (!this.store.hasBinding(deviceId, job.workspaceId)) job.controller.abort(new ApiError(403, 'WORKSPACE_FORBIDDEN', '此工作区的设备授权已解除'));
    }
    if (operations.some(command => command.action === 'configurePairing')) void this.connection?.configure();
    if (operations.some(command => command.action === 'retryTunnel')) void this.connection.retry();
    return { result: batch ? results : results[0].result, view: this.view() };
  }
  activateOrigin(origin) {
    const normalized = pairingOrigin(origin);
    requireValue(normalized, 500, 'INVALID_ORIGIN', '连接地址不能为空');
    if (this.store.activateOrigin(normalized)) this.disconnect(new ApiError(401, 'DEVICE_REVOKED', 'DSH 访问地址已变化，请重新配对设备'));
  }
  watchRequest(disconnect) { this.requests.add(disconnect); return () => this.requests.delete(disconnect); }
  disconnect(error) {
    for (const job of this.devices.values()) job.controller.abort(error);
    for (const disconnect of this.requests) disconnect(error);
  }
  pair(code) {
    requireValue(!this.closed, 503, 'STOPPING', '插件正在停止');
    code = text(code, '配对码', 128).toUpperCase();
    requireValue(/^[A-Z0-9]{6}$/.test(code), 401, 'INVALID_PAIRING_CODE', '配对码需为 6 位字母或数字');
    return this.store.pair(code, workspaceId => this.dsh.workspace(workspaceId));
  }
  access(deviceId) {
    requireValue(!this.closed, 503, 'STOPPING', '插件正在停止');
    const device = this.store.device(deviceId);
    requireValue(device.paired, 401, 'UNAUTHORIZED', '设备尚未完成配对');
    return device;
  }
  scope(deviceId, workspaceId) {
    const device = this.access(deviceId);
    workspaceId ??= device.active_workspace_id;
    requireValue(workspaceId, 422, 'WORKSPACE_REQUIRED', '请先选择已授权工作区');
    const binding = this.store.binding(deviceId, workspaceId);
    this.store.workspace(workspaceId); this.dsh.workspace(workspaceId);
    return { workspaceId, sessionId: binding.session_id };
  }
  listWorkspaces(deviceId) {
    const device = this.access(deviceId), available = this.dsh.workspaces();
    const items = this.store.bindings(deviceId).flatMap(binding => {
      const workspace = available.find(row => row.id === binding.workspace_id);
      return workspace ? [{ ...workspace, sessionId: binding.session_id, ready: this.ready(deviceId) }] : [];
    });
    return { workspaceId: items.some(row => row.id === device.active_workspace_id) ? device.active_workspace_id : null, items };
  }
  me(deviceId) {
    const device = this.access(deviceId), { workspaceId, items } = this.listWorkspaces(deviceId);
    const workspace = items.find(row => row.id === workspaceId) ?? null;
    return { protocol: PROTOCOL, deviceId, name: device.name, voiceId: device.voice_id, voices: this.store.voices(), workspaceId, workspace, workspaces: items,
      sessionId: workspace?.sessionId ?? null, ready: workspace?.ready ?? { asr: false, tts: false, summary: 'session' } };
  }
  listVoices(deviceId) {
    const device = this.access(deviceId);
    return { voiceId: device.voice_id, items: this.store.voices() };
  }
  selectVoice(deviceId, voiceId) {
    this.access(deviceId);
    this.store.selectVoice(deviceId, voiceId === null ? null : id(voiceId));
    return this.listVoices(deviceId);
  }
  selectWorkspace(deviceId, workspaceId) {
    const scope = this.scope(deviceId, id(workspaceId));
    this.store.selectWorkspace(deviceId, scope.workspaceId);
    return { ...scope, ready: this.ready(deviceId) };
  }
  ready(deviceId) {
    const device = this.store.device(deviceId), defaults = this.store.settings().config, config = effective(defaults, device.config);
    return { asr: Boolean(defaults.asr && config.asr), tts: Boolean(defaults.tts && config.tts && device.voice_id), summary: config.summary ? 'configured' : 'session' };
  }
  async listSessions(deviceId, signal) {
    const { workspaceId } = this.scope(deviceId);
    const items = await this.dsh.sessions(workspaceId, signal);
    this.scope(deviceId, workspaceId);
    return { workspaceId, items };
  }
  async history(deviceId, sessionId, before, limit, signal) {
    const { workspaceId } = this.scope(deviceId);
    const result = await this.dsh.history(workspaceId, id(sessionId), before, limit, signal);
    this.scope(deviceId, workspaceId);
    return { ...result, workspaceId };
  }
  select(deviceId, sessionId) {
    const { workspaceId } = this.scope(deviceId);
    this.dsh.assertSession(workspaceId, id(sessionId));
    this.store.select(deviceId, sessionId, workspaceId);
    return { workspaceId, sessionId };
  }
  cancel(deviceId, requestId) {
    this.access(deviceId);
    const active = this.devices.get(deviceId);
    requireValue(active && active.requestId === requestId, 404, 'TURN_NOT_FOUND', '该设备没有对应的进行中请求');
    active.controller.abort(new ApiError(499, 'CANCELLED', '请求已取消'));
    return { cancelled: true };
  }
  async run(deviceId, requestId, readAudio, emit, callerSignal) {
    const { workspaceId, sessionId } = this.scope(deviceId);
    id(requestId);
    requireValue(sessionId, 422, 'SESSION_REQUIRED', '请先选择会话');
    this.dsh.assertSession(workspaceId, sessionId);
    requireValue(!this.devices.has(deviceId) && !this.sessions.has(sessionId) && !this.dsh.busy(sessionId),
      409, 'SESSION_BUSY', '设备或会话已有进行中的请求');
    const defaults = this.store.settings().config, config = effective(defaults, this.store.device(deviceId).config);
    requireValue(defaults.asr && defaults.tts && config.asr && config.tts, 422, 'VOICE_NOT_CONFIGURED', '请先完成插件级 ASR 和 TTS 配置');
    const voiceId = this.store.device(deviceId).voice_id;
    requireValue(voiceId, 422, 'DEVICE_VOICE_REQUIRED', '请先在设备端选择音色');
    config.tts.voice = this.store.voice(voiceId).value;
    this.store.beginTurn({ id: deviceId }, requestId, sessionId);
    const controller = new AbortController();
    const signal = AbortSignal.any([callerSignal, controller.signal]);
    const timer = setTimeout(() => controller.abort(new ApiError(504, 'TURN_TIMEOUT', '语音请求超时')), LIMITS.turnMs);
    let resolveDone;
    const job = { requestId, workspaceId, controller, done: new Promise(resolve => { resolveDone = resolve; }) };
    this.devices.set(deviceId, job); this.sessions.set(sessionId, job);
    let phase = 'upload', seq = 0;
    const send = (type, data) => {
      signal.throwIfAborted();
      this.scope(deviceId, workspaceId);
      this.dsh.assertSession(workspaceId, sessionId);
      return emit({ protocol: PROTOCOL, requestId, workspaceId, sessionId, seq: seq++, type, data });
    };
    const stage = async value => { phase = value; await send('phase', { phase }); };
    try {
      const { audio, type } = await readAudio(signal);
      await stage('asr');
      const transcript = await this.voice.transcribe(config.asr, audio, type, signal);
      await send('transcript', { text: transcript });
      this.scope(deviceId, workspaceId); this.dsh.assertSession(workspaceId, sessionId);
      await stage('dsh');
      const result = await this.dsh.run(workspaceId, sessionId, randomUUID(), transcript, event => {
        void send('dsh.event', event).catch(error => controller.abort(error));
      }, signal);
      await send('reply', { text: result.text });
      await stage('summary');
      const script = await this.voice.script(config.summary, result.model, result.text, signal);
      await send('speech.text', { text: script });
      await stage('tts');
      await this.voice.speak(config.tts, script, signal, send);
      await send('complete', { status: 'audio_delivered' });
      this.store.endTurn(deviceId, requestId, 'completed');
    } catch (error) {
      this.store.endTurn(deviceId, requestId, signal.aborted ? 'cancelled' : 'failed');
      const failure = signal.aborted ? signal.reason : error;
      const safe = failure instanceof ApiError ? failure : new ApiError(502, 'VOICE_STAGE_FAILED', `${phase} 阶段失败，请检查模型服务或 DSH 状态`);
      safe.phase = phase;
      safe.streamContext = { protocol: PROTOCOL, requestId, workspaceId, sessionId, seq: seq++ };
      throw safe;
    } finally {
      clearTimeout(timer); this.devices.delete(deviceId); this.sessions.delete(sessionId); resolveDone();
    }
  }
  async close() {
    this.closed = true;
    const jobs = [...this.devices.values()];
    this.disconnect(new ApiError(503, 'STOPPING', '插件正在停止'));
    await Promise.all(jobs.map(job => job.done));
  }
}
