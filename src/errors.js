export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export function requireValue(condition, status, code, message) {
  if (!condition) throw new ApiError(status, code, message);
}
export function publicError(error) {
  return error instanceof ApiError
    ? { code: error.code, message: error.message }
    : { code: 'INTERNAL_ERROR', message: '操作失败，请查看 DSH 日志。' };
}
/** Stop waiting promptly even when a host activation does not support cancellation. */
export async function abortable(promise, signal) {
  signal.throwIfAborted();
  let cancel;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
    })]);
  } finally { signal.removeEventListener('abort', cancel); }
}
