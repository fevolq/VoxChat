// This descriptor is embedded unchanged in the DSH settings bundle.
export const REMOTE = {
  package: '@fevolq/voxchat',
  descriptors: ['view', 'command'].map(method => ({
    id: '@fevolq/voxchat#voxchat/' + method, service: 'voxchat', namespace: 'voxchat', method,
    invocation: { kind: 'direct' },
    parameters: method === 'command' ? [{ name: 'command', wire: 'command', source: 'json', codec: {
      mode: 'strict', typeSymbol: '@fevolq/voxchat#command', create: () => ({ parse(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > 65536) throw new Error('无效管理请求');
        return value;
      } }),
    } }] : [],
    result: { mode: 'src-json' },
  })),
};
