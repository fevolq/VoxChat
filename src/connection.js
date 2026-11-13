import { createServer } from 'node:http';
import { startTunnel } from './tunnel.js';
import { ApiError, requireValue } from './errors.js';

export class Connection {
  constructor(service, handler, directory, launch = startTunnel) {
    this.service = service; this.handler = handler; this.directory = directory; this.launch = launch;
    this.state = { mode: 'tunnel', status: 'stopped', origin: null, error: null };
    this.pending = Promise.resolve(); this.generation = 0; this.closed = false;
    service.connection = this;
  }
  view() { return { ...this.state }; }
  ready() { requireValue(this.state.status === 'ready', 503, 'CONNECTION_NOT_READY', '访问入口尚未就绪，请在 DSH 语音交互设置中查看连接状态'); }
  retry() {
    requireValue(this.state.mode === 'tunnel' && this.state.status === 'error', 409, 'TUNNEL_NOT_FAILED', '仅自动隧道失败后可以重试');
    return this.configure(true);
  }
  configure(retry = false) {
    const manual = this.service.store.settings().config.pairingOrigin || '';
    if (this.closed || (!retry && manual === this.configured)) return this.pending;
    this.configured = manual;
    const generation = ++this.generation;
    this.controller?.abort(new ApiError(503, 'CONNECTION_CHANGED', '正在切换连接入口'));
    const controller = this.controller = new AbortController(), signal = controller.signal;
    this.state = { mode: manual ? 'manual' : 'tunnel', status: 'starting', origin: null, error: null };
    this.pending = this.pending.then(async () => {
      await this.cleanup?.(); this.cleanup = null;
      if (this.closed || generation !== this.generation) return;
      if (manual) { this.publish(manual); return; }
      const server = createServer(this.handler);
      let tunnel;
      this.cleanup = async () => {
        await tunnel?.close();
        await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
      };
      await new Promise((resolve, reject) => {
        server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      signal.throwIfAborted();
      tunnel = await this.launch({ port: server.address().port, directory: this.directory, signal, onFailure: error => {
        if (generation === this.generation && !this.closed) {
          this.state = { mode: 'tunnel', status: 'error', origin: null, error: error.message };
          this.service.disconnect(error); controller.abort(error);
        }
      } });
      signal.throwIfAborted();
      this.publish(tunnel.origin);
    }).catch(async error => {
      await this.cleanup?.(); this.cleanup = null;
      if (!this.closed && generation === this.generation) {
        this.state = { mode: manual ? 'manual' : 'tunnel', status: 'error', origin: null, error: error.message };
        this.service.disconnect(error);
      }
    });
    return this.pending;
  }
  publish(origin) {
    this.service.activateOrigin(origin);
    this.state = { mode: this.configured ? 'manual' : 'tunnel', status: 'ready', origin, error: null };
  }
  async close() {
    this.closed = true; this.generation++;
    this.controller?.abort(new ApiError(503, 'STOPPING', '插件正在停止'));
    await this.pending; await this.cleanup?.(); this.cleanup = null;
    this.state = { ...this.state, status: 'stopped', origin: null };
  }
}
