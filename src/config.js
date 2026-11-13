import { CAPABILITIES } from './contracts.js';
import { requireValue } from './errors.js';

function object(value, label = '请求') {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 400, 'INVALID_REQUEST', label + '必须是对象');
  return value;
}
export function text(value, label, max = 200) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= max,
    400, 'INVALID_REQUEST', label + '不能为空或超过长度限制');
  return value.trim();
}
export function id(value) {
  requireValue(typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value), 400, 'INVALID_ID', '无效的标识');
  return value;
}
export function keys(value, allowed) {
  object(value);
  requireValue(Object.keys(value).every(key => allowed.includes(key)), 400, 'INVALID_REQUEST', '请求包含不支持的字段');
}
export function modelConfig(kind, value, previous) {
  requireValue(CAPABILITIES.includes(kind), 400, 'INVALID_CONFIG', '未知模型配置类型');
  if (value === null) return null;
  keys(value, ['baseUrl', 'apiKey', 'model', ...(kind === 'asr' ? ['language'] : kind === 'tts' ? ['format', 'speed'] : [])]);
  const result = { model: text(value.model, '模型', 200) };
  let url;
  try { url = new URL(value.baseUrl); } catch { /* validated below */ }
  requireValue(url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash,
    400, 'INVALID_CONFIG', '服务地址必须是无认证信息、查询参数及片段的 HTTP(S) URL');
  result.baseUrl = url.href.replace(/\/+$/, '');
  // Only retain an omitted secret when editing the same service endpoint.
  result.apiKey = value.apiKey === undefined && previous?.baseUrl === result.baseUrl ? previous.apiKey ?? '' : value.apiKey ?? '';
  requireValue(typeof result.apiKey === 'string' && /^[\x20-\x7e]{0,4096}$/.test(result.apiKey), 400, 'INVALID_CONFIG', 'API Key 格式无效');
  result.apiKey = result.apiKey.trim();
  if (kind === 'asr' && value.language) result.language = text(value.language, '语言', 32);
  if (kind === 'tts') {
    result.format = value.format ?? 'mp3';
    requireValue(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'].includes(result.format), 400, 'INVALID_CONFIG', '不支持的音频格式');
    result.speed = value.speed ?? 1;
    requireValue(typeof result.speed === 'number' && Number.isFinite(result.speed) && result.speed >= 0.25 && result.speed <= 4,
      400, 'INVALID_CONFIG', '语速范围为 0.25–4');
  }
  return result;
}
export function redact(config) {
  return Object.fromEntries(CAPABILITIES.map(kind => {
    const value = config[kind];
    if (!value) return [kind, null];
    const { apiKey, ...safe } = value;
    return [kind, { ...safe, apiKeySet: Boolean(apiKey) }];
  }));
}
export function effective(defaults, device) {
  return Object.fromEntries(CAPABILITIES.map(kind => [kind, structuredClone(device[kind] ?? defaults[kind] ?? null)]));
}
export function pairingOrigin(value) {
  if (value === '') return '';
  let url;
  try { url = new URL(value); } catch { /* validated below */ }
  requireValue(url && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
    && !url.search && !url.hash && url.pathname === '/', 400, 'INVALID_CONFIG', 'DSH 访问地址需为 HTTP(S) 地址，不含路径、密钥或查询参数');
  requireValue(url.hostname !== 'localhost' && !url.hostname.endsWith('.localhost') && !/^127\./.test(url.hostname)
    && !['[::1]', '0.0.0.0', '[::]'].includes(url.hostname), 400, 'INVALID_CONFIG', '请填写手机可访问的地址；本机回环地址不可用于设备连接，留空可自动启动隧道');
  return url.origin;
}
