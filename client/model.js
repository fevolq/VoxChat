export function createDraft(view) {
  return { defaults: structuredClone(view.defaults), voices: structuredClone(view.voices), pairingOrigin: view.pairingOrigin,
    devices: view.devices.map(({ voice_id, ...device }) => ({ ...device, config: structuredClone(device.config), saved: true,
      workspaceIds: view.bindings.filter(binding => binding.device_id === device.id).map(binding => binding.workspace_id) })) };
}
function cleanConfig(value) {
  if (!value) return null;
  const { apiKeySet, ...config } = value;
  return config;
}
export function buildOperations(view, draft) {
  const operations = [], kinds = ['asr', 'tts', 'summary'];
  const configure = (deviceId, previous, next) => {
    for (const kind of kinds) if (JSON.stringify(cleanConfig(previous[kind])) !== JSON.stringify(cleanConfig(next[kind]))) {
      operations.push({ action: 'configure', deviceId, kind, value: cleanConfig(next[kind]) });
    }
  };
  configure(null, view.defaults, draft.defaults);
  if (operations.length) {
    for (const kind of kinds) {
      const value = draft.defaults[kind];
      if (kind === 'summary' && !value) continue;
      const title = { asr: 'ASR', tts: 'TTS', summary: '总结模型' }[kind];
      if (!value?.baseUrl?.trim() || !value?.model?.trim()) {
        throw new Error(`请填写插件级 ${title} 的 API 地址、模型名称。`);
      }
    }
  }
  if (draft.pairingOrigin !== view.pairingOrigin) operations.push({ action: 'configurePairing', origin: draft.pairingOrigin.trim() });
  for (const voice of draft.voices) {
    if (!voice.name.trim() || !voice.value.trim()) throw new Error('请填写音色名称和音色 ID。');
    const previous = view.voices.find(row => row.id === voice.id);
    if (!previous || previous.name !== voice.name || previous.value !== voice.value) {
      operations.push({ action: 'saveVoice', voiceId: voice.id, name: voice.name.trim(), value: voice.value.trim() });
    }
  }
  for (const device of view.devices) {
    if (!draft.devices.some(row => row.saved && row.id === device.id)) operations.push({ action: 'revokeDevice', deviceId: device.id });
  }
  for (const device of draft.devices) {
    if (!device.saved) {
      if (!device.name.trim()) throw new Error('请填写新设备的名称。');
      if (device.workspaceIds.length) throw new Error('请先保存设备，再配置可用工作区。');
      operations.push({ action: 'addDevice', name: device.name.trim() });
      continue;
    }
    const previous = view.bindings.filter(binding => binding.device_id === device.id).map(binding => binding.workspace_id);
    configure(device.id, view.devices.find(row => row.id === device.id).config, device.config);
    for (const workspaceId of previous) {
      if (!device.workspaceIds.includes(workspaceId)) operations.push({ action: 'unbindDevice', deviceId: device.id, workspaceId });
    }
    for (const workspaceId of new Set(device.workspaceIds)) {
      if (!previous.includes(workspaceId)) operations.push({ action: 'bindDevice', deviceId: device.id, workspaceId });
    }
  }
  for (const voice of view.voices) if (!draft.voices.some(row => row.id === voice.id)) operations.push({ action: 'removeVoice', voiceId: voice.id });
  return operations;
}
