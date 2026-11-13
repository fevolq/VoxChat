import { join } from 'node:path';
import { Store } from './store.js';
import { DshAdapter } from './dsh.js';
import { Voice } from './voice.js';
import { VoxChat } from './service.js';
import { createHandler, PREFIX } from './http.js';
import { exposeAdmin } from './admin.js';
import { Connection } from './connection.js';

export const name = 'voxchat';
export const inject = ['profileContext', 'settings', 'webServer', 'workspaceRegistry', 'sessionController', 'agents', 'llm', 'typert'];

export function apply(ctx) {
  const dsh = new DshAdapter(ctx);
  const store = new Store(join(ctx.profileContext.dir, 'data', 'voxchat.sqlite'));
  const service = new VoxChat(store, dsh, new Voice(dsh));
  const handler = createHandler(service, { log: error => ctx.logger?.('voxchat').error(error) });
  const connection = new Connection(service, handler, join(ctx.profileContext.dir, 'data', 'voxchat-tunnel'));
  let route, closed = false;
  const close = async () => {
    if (closed) return;
    closed = true; route?.();
    try { await connection.close(); await service.close(); } finally { store.close(); }
  };
  ctx.effect(() => close);
  try {
    exposeAdmin(ctx, service);
    route = ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler });
    void connection.configure();
  } catch (error) { void close(); throw error; }
}
