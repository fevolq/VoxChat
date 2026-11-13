import { once } from 'node:events';
import { API, PREFIX, PROTOCOL, LIMITS } from './contracts.js';
import { keys } from './config.js';
import { AUDIO } from './voice.js';
import { ApiError, publicError, requireValue } from './errors.js';

export { PREFIX };
function readBody(req, max, signal) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [];
    const clean = () => {
      clearTimeout(timer); req.off('data', data); req.off('end', end); req.off('error', fail); req.off('aborted', aborted);
      signal.removeEventListener('abort', aborted);
    };
    const fail = error => { clean(); chunks = []; req.resume(); reject(error); };
    const aborted = () => fail(signal.reason ?? new ApiError(400, 'UPLOAD_ABORTED', '上传已中断'));
    const data = chunk => {
      size += chunk.length;
      if (size > max) fail(new ApiError(413, 'BODY_TOO_LARGE', '请求内容超过大小限制'));
      else chunks.push(chunk);
    };
    const end = () => { clean(); resolve(Buffer.concat(chunks)); };
    const timer = setTimeout(() => fail(new ApiError(408, 'UPLOAD_TIMEOUT', '上传超时')), LIMITS.uploadMs);
    req.on('data', data); req.once('end', end); req.once('error', fail); req.once('aborted', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
function method(req, res, expected) {
  if (req.method === expected) return;
  res.setHeader('Allow', expected);
  throw new ApiError(405, 'METHOD_NOT_ALLOWED', '请求方法不支持');
}
function integer(value, fallback, min, max) {
  if (value === null) return fallback;
  const result = Number(value);
  requireValue(/^\d+$/.test(value) && Number.isSafeInteger(result) && result >= min && result <= max, 400, 'INVALID_PAGE', '分页参数无效');
  return result;
}
export function createHandler(service, { log = () => {} } = {}) {
  const pairingAttempts = new Map();
  let pairingWindow = { count: 0, until: 0 };
  return async (req, res) => {
    let release;
    const controller = new AbortController(), signal = controller.signal;
    const disconnect = () => { if (!res.writableEnded) controller.abort(new ApiError(499, 'DISCONNECTED', '客户端已断开')); };
    res.once('close', disconnect);
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    const json = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    const body = async () => {
      requireValue(req.headers['content-type']?.split(';')[0].trim() === 'application/json', 415, 'CONTENT_TYPE', '需要 application/json');
      const bytes = await readBody(req, LIMITS.jsonBytes, signal);
      try { return JSON.parse(bytes.toString('utf8')); } catch { throw new ApiError(400, 'INVALID_JSON', 'JSON 格式无效'); }
    };
    const emit = async event => {
      signal.throwIfAborted();
      requireValue(!res.destroyed, 499, 'DISCONNECTED', '客户端已断开');
      requireValue(res.writableLength < 2 * 1024 * 1024, 503, 'SLOW_CLIENT', '客户端接收速度过慢');
      if (!res.headersSent) res.writeHead(200, { ...headers, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
      if (!res.write(JSON.stringify(event) + '\n')) await once(res, 'drain', { signal });
    };
    try {
      const url = new URL(req.url, 'http://localhost'), path = url.pathname;
      requireValue(!req.headers['content-encoding'] || req.headers['content-encoding'] === 'identity', 415, 'CONTENT_ENCODING', '不支持压缩请求体');
      if ([PREFIX, PREFIX + '/', API + '/status'].includes(path)) {
        method(req, res, 'GET'); json(200, { name: 'VoxChat', protocol: PROTOCOL, status: 'ready' }); return;
      }
      service.connection?.ready();
      release = service.watchRequest(error => { controller.abort(error); res.destroy(); });
      if (path === API + '/pair') {
        method(req, res, 'POST');
        const now = Date.now(), ip = req.socket.remoteAddress;
        if (pairingWindow.until <= now) pairingWindow = { count: 0, until: now + 60_000 };
        requireValue(++pairingWindow.count <= 120, 429, 'RATE_LIMIT', '配对请求过于频繁');
        for (const [key, value] of pairingAttempts) if (value.until <= now) pairingAttempts.delete(key);
        requireValue(pairingAttempts.size < 1024 || pairingAttempts.has(ip), 429, 'RATE_LIMIT', '请稍后配对');
        const bucket = pairingAttempts.get(ip) ?? { count: 0, until: now + 60_000 };
        pairingAttempts.set(ip, bucket);
        requireValue(++bucket.count <= 30, 429, 'RATE_LIMIT', '配对请求过于频繁');
        const value = await body(); keys(value, ['code']);
        json(200, service.pair(value.code)); return;
      }
      const known = [API + '/me', API + '/voices', API + '/voice', API + '/workspaces', API + '/workspace', API + '/sessions', API + '/session', API + '/turns'].includes(path)
        || new RegExp('^' + API + '/sessions/[a-zA-Z0-9_-]+/history$').test(path)
        || new RegExp('^' + API + '/turns/[a-zA-Z0-9_-]+$').test(path);
      requireValue(known, 404, 'NOT_FOUND', '接口不存在');
      const token = /^Bearer ([a-zA-Z0-9_-]{43})$/.exec(req.headers.authorization ?? '')?.[1];
      requireValue(token, 401, 'UNAUTHORIZED', '需要设备 Bearer 凭证');
      const device = service.store.authenticate(token);
      if (path === API + '/me') { method(req, res, 'GET'); json(200, service.me(device.id)); return; }
      if (path === API + '/voices') { method(req, res, 'GET'); json(200, service.listVoices(device.id)); return; }
      if (path === API + '/voice') {
        method(req, res, 'PUT'); const value = await body(); keys(value, ['voiceId']);
        json(200, service.selectVoice(device.id, value.voiceId)); return;
      }
      if (path === API + '/workspaces') { method(req, res, 'GET'); json(200, service.listWorkspaces(device.id)); return; }
      if (path === API + '/workspace') {
        method(req, res, 'PUT'); const value = await body(); keys(value, ['workspaceId']);
        json(200, service.selectWorkspace(device.id, value.workspaceId)); return;
      }
      if (path === API + '/sessions') { method(req, res, 'GET'); json(200, await service.listSessions(device.id, signal)); return; }
      if (path === API + '/session') {
        method(req, res, 'PUT'); const value = await body(); keys(value, ['sessionId']);
        json(200, service.select(device.id, value.sessionId)); return;
      }
      if (path.endsWith('/history')) {
        method(req, res, 'GET');
        json(200, await service.history(device.id, path.split('/').at(-2), integer(url.searchParams.get('before'), undefined, 0, Number.MAX_SAFE_INTEGER),
          integer(url.searchParams.get('limit'), 100, 1, 500), signal)); return;
      }
      if (path.startsWith(API + '/turns/')) {
        method(req, res, 'DELETE'); json(200, service.cancel(device.id, path.split('/').at(-1))); return;
      }
      method(req, res, 'POST');
      const type = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
      requireValue(Object.hasOwn(AUDIO, type ?? ''), 415, 'AUDIO_FORMAT', '需要支持的音频 Content-Type');
      requireValue(service.devices.size < 16, 503, 'CAPACITY', '当前语音请求过多，请稍后再试');
      await service.run(device.id, req.headers['x-request-id'], async scoped => {
        const audio = await readBody(req, LIMITS.audioBytes, scoped);
        requireValue(audio.length > 0, 400, 'EMPTY_AUDIO', '录音不能为空');
        return { audio, type };
      }, emit, signal);
      res.end();
    } catch (error) {
      req.resume();
      if (!(error instanceof ApiError)) log(error);
      if (!res.destroyed) {
        if (!res.headersSent) json(error instanceof ApiError ? error.status : 500, { error: publicError(error) });
        else res.end(JSON.stringify({ ...error.streamContext, type: 'error', error: publicError(error), phase: error.phase ?? null }) + '\n');
      }
    } finally { release?.(); res.off('close', disconnect); }
  };
}
