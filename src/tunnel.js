import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiError, requireValue } from './errors.js';

const VERSION = '2026.11.0';
// SHA-256 digests from the official Cloudflare release. Never run an unchecked download.
const BINARIES = {
  'win32-x64': ['windows-amd64.exe', 'd5c1d82031da6253dcdcff64c944cd0fe063016edeb2e4fd088075fc9bd52d0a'],
  'linux-x64': ['linux-amd64', '51f7c68b57ed7269164075d7e789efce5b59355982f06392deeb037d982a51fd'],
  'linux-arm64': ['linux-arm64', 'abe54a006acf9faf2d19ee9d953cb0d0804e92f59c5382a162e57b84d086f56f'],
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function tunnelBinary(directory, signal) {
  const binary = BINARIES[process.platform + '-' + process.arch];
  requireValue(binary, 503, 'TUNNEL_PLATFORM', '自动隧道暂不支持此系统架构，请手动填写访问地址');
  const [name, checksum] = binary, path = join(directory, 'cloudflared-' + VERSION + '-' + name);
  await mkdir(directory, { recursive: true });
  let bytes;
  try { bytes = await readFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (bytes) {
    requireValue(hash(bytes) === checksum, 503, 'TUNNEL_CHECKSUM', '隧道客户端缓存校验失败，请移除损坏的缓存后重试');
    return path;
  }
  try {
    const response = await fetch('https://github.com/cloudflare/cloudflared/releases/download/' + VERSION + '/cloudflared-' + name,
      { signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]) });
    requireValue(response.ok, 503, 'TUNNEL_DOWNLOAD', `隧道客户端下载失败：HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    signal.throwIfAborted();
    throw new ApiError(503, 'TUNNEL_DOWNLOAD', '隧道客户端下载失败：' + error.message);
  }
  requireValue(hash(bytes) === checksum, 503, 'TUNNEL_CHECKSUM', '隧道客户端下载校验失败');
  const temporary = path + '.' + randomUUID() + '.part';
  try {
    await writeFile(temporary, bytes, { mode: 0o700 }); signal.throwIfAborted();
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  if (process.platform !== 'win32') await chmod(path, 0o700);
  return path;
}

export async function startTunnel({ port, directory, signal, onFailure }) {
  const binary = await tunnelBinary(directory, signal);
  const sessionDirectory = await mkdtemp(join(directory, 'session-'));
  let child, closePromise, timer, ready = false, output = '', lastLog = '', lastError = '';
  const exit = () => child?.kill();
  const close = () => closePromise ??= (async () => {
    clearTimeout(timer); signal.removeEventListener('abort', abort); process.removeListener('exit', exit);
    if (child) {
      const ended = new Promise(resolve => child.once('close', resolve));
      if (child.exitCode === null && child.signalCode === null) { child.kill(); await ended; }
    }
    await rm(sessionDirectory, { recursive: true, force: true });
  })();
  const abort = () => { void close(); };
  try {
    // An explicit empty config prevents a user's existing cloudflared config from changing this tunnel.
    const config = join(sessionDirectory, 'config.yml');
    await writeFile(config, '{}\n', { mode: 0o600 }); signal.throwIfAborted();
    const origin = await new Promise((resolve, reject) => {
      let settled = false, publicOrigin, registered = false;
      const fail = message => {
        const error = new ApiError(503, 'TUNNEL_FAILED', message);
        if (settled) { if (ready && !closePromise) onFailure(error); }
        else { settled = true; reject(error); }
      };
      try {
        child = spawn(binary, ['--no-autoupdate', 'tunnel', '--config', config, '--url', 'http://127.0.0.1:' + port,
          '--metrics', '127.0.0.1:0', '--loglevel', 'info'],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) { fail('无法启动隧道客户端：' + error.message); return; }
      process.once('exit', exit);
      child.once('error', error => fail('无法启动隧道客户端：' + error.message));
      child.once('close', code => fail('隧道进程已退出（' + code + '）' + (lastLog ? '：' + lastLog : '')));
      const inspect = chunk => {
        output += chunk.toString();
        const lines = output.split(/\r?\n/); output = lines.pop();
        for (const line of lines) {
          if (line.trim()) lastLog = line.trim().slice(-1000);
          if (/\bERR\b/.test(line)) lastError = line.trim().slice(-1000);
          const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i.exec(line);
          if (match) publicOrigin = match[0];
          if (line.includes('Registered tunnel connection')) registered = true;
          if (publicOrigin && registered && !settled) {
            settled = true; ready = true; clearTimeout(timer); resolve(publicOrigin);
          }
        }
      };
      child.stdout.on('data', inspect); child.stderr.on('data', inspect);
      timer = setTimeout(() => fail('隧道连接超时' + (lastError || lastLog ? '：' + (lastError || lastLog) : '')), 60_000);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
    return { origin, close };
  } catch (error) { await close(); throw error; }
}
