import { REMOTE } from './remote.js';
import { ApiError, publicError } from './errors.js';

export function exposeAdmin(ctx, service) {
  const admin = {
    view: () => ({ ...service.view(), writable: Boolean(ctx.settings.writable) }),
    command(command) {
      try {
        if (!ctx.settings.writable) throw new ApiError(403, 'READ_ONLY', '当前 DSH 设置不可写');
        const result = service.command(command);
        return { accepted: true, ...result, view: { ...result.view, writable: true } };
      } catch (error) {
        return { accepted: false, error: publicError(error) };
      }
    },
  };
  Object.assign(admin, { typertRemote: Object.freeze({ service: admin, serviceKey: 'voxchat', namespace: 'voxchat' }) });
  ctx.provide('voxchat', admin);
  ctx.effect(() => ctx.typert.register({ package: REMOTE.package, face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: REMOTE.descriptors }));
}
