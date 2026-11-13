import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { REMOTE } from '../src/remote.js';
import { Store } from '../src/store.js';
import { VoxChat } from '../src/service.js';
import { fakeDsh } from './helpers.mjs';
import { Connection } from '../src/connection.js';

const nodes = tree => tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(nodes)] : [];
const label = tree => tree && typeof tree === 'object' ? tree.children.map(label).join('') : String(tree ?? '');

test('settings manages devices first, assigns workspaces and requires plugin model fields', async t => {
  const store = new Store(':memory:'), dsh = fakeDsh(), service = new VoxChat(store, dsh, {});
  store.setConfig({ pairingOrigin: 'https://dsh.example.test' });
  const connection = new Connection(service, null, null, () => { throw new Error('Manual mode must not start a tunnel'); });
  await connection.configure(); t.after(() => connection.close());
  dsh.workspaces().push(...Array.from({ length: 100 }, (_, i) => ({ id: 'extra-' + i, title: '工作区 ' + i, path: '/projects/' + i, sessionIds: [] })));
  t.after(() => store.close());
  let extension, Component, registration, mounted;
  const view = () => ({ ...service.view(), writable: true });
  const hooks = [], effects = [], cleanup = [], commands = [], styles = [], timers = [];
  let cursor = 0;
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children: children.flat(Infinity).filter(value => value !== null && value !== false && value !== undefined) }; },
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
      return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return hooks[i] ??= { current: initial }; },
    useEffect(fn) { const i = cursor++; if (!(i in hooks)) { hooks[i] = true; effects.push(fn); } },
  };
  const ctx = {
    inject: (_services, fn) => ({ await: async () => fn(ctx) }),
    effect(fn) { cleanup.push(fn()); }, on: () => () => {},
    slots: { inject: (_name, fn) => fn(), register(info, component) { registration = info; Component = component; } },
    remote: {
      $mount: async value => { mounted = value; },
      voxchat: {
        view: async () => ({ ok: true, value: view() }),
        command: async value => {
          commands.push(value);
          const result = service.command(value);
          return { ok: true, value: { accepted: true, ...result, view: view() } };
        },
      },
    },
  };
  runInNewContext(await readFile(new URL('../dist/client.js', import.meta.url), 'utf8'), {
    structuredClone, URL, setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval: () => {}, window: { location: { origin: 'http://127.0.0.1:3080' }, __ModuleLoader__: { load(value) { extension = value; } } },
    MutationObserver: class { observe() {} disconnect() {} },
    document: { createElement: () => ({ remove() { styles.pop(); } }), head: { append(value) { styles.push(value); } }, body: {}, querySelectorAll: () => [] },
  });
  assert.equal(extension.id, '@fevolq/voxchat');
  await extension.factory(name => { assert.equal(name, 'react'); return React; }).apply(ctx);
  assert.equal(registration.label(), '语音交互');
  assert.deepEqual(JSON.parse(JSON.stringify(mounted)), JSON.parse(JSON.stringify(REMOTE)));
  const render = () => { cursor = 0; const tree = Component(); for (const effect of effects.splice(0)) cleanup.push(effect()); return tree; };
  const forms = tree => nodes(tree).filter(node => typeof node.type === 'function');
  const click = (tree, text) => nodes(tree).find(node => node.type === 'button' && label(node) === text).props.onClick();
  const workspaceTrigger = tree => nodes(tree).find(node => node.props.className === 'vox-workspace-trigger');
  const searchWorkspaces = query => {
    nodes(tree).find(node => node.props['aria-label'] === '搜索可用工作区').props.onChange({ target: { value: query } });
    tree = render();
  };
  const submit = tree => tree.props.onSubmit({ preventDefault() {} });
  render(); await nextTurn(); let tree = render();
  assert.match(label(tree), /还没有绑定设备/); assert.match(label(tree), /0 台设备/);
  assert.doesNotMatch(label(tree), /设备管理|新增工作区/);
  const models = forms(tree);
  const asrFields = models[0].type(models[0].props), ttsFields = models[1].type(models[1].props), summaryFields = models[2].type(models[2].props);
  assert.doesNotMatch(label(asrFields) + label(ttsFields), /暂不配置|配置方式/);
  assert.equal(nodes(asrFields).filter(node => node.type === 'input' && node.props.required).length, 2);
  assert.equal(nodes(ttsFields).filter(node => node.type === 'input' && node.props.required).length, 2);
  assert.doesNotMatch(label(ttsFields), /音色名称/);
  assert.match(label(summaryFields), /继承当前会话模型/);
  click(tree, '添加第一台设备'); tree = render();
  assert.equal(commands.length, 0); assert.match(label(tree), /1 台设备/);
  assert.equal(nodes(tree).filter(node => node.props.type === 'checkbox').length, 0, 'grant workspaces after creating the device');
  click(tree, '放弃修改'); tree = render(); assert.match(label(tree), /0 台设备/);
  click(tree, '添加第一台设备'); tree = render();
  nodes(tree).find(node => node.type === 'input').props.onChange({ target: { value: '我的手机' } }); tree = render();
  await submit(tree); tree = render();
  assert.equal(commands[0].operations[0].action, 'addDevice');
  assert.equal(commands[0].operations[0].workspaceIds, undefined);
  assert.equal(store.workspaces().length, 0); assert.equal(store.devices().length, 1);
  const code = nodes(tree).find(node => node.type === 'code').children[0];
  assert.match(code, /^[A-Z0-9]{6}$/);
  assert.ok(nodes(tree).some(node => node.type === 'img' && node.props.src.startsWith('data:image/svg+xml;')));
  await click(tree, '刷新配对码'); tree = render();
  const refreshedCode = nodes(tree).find(node => node.type === 'code').children[0];
  assert.notEqual(code, refreshedCode); assert.throws(() => service.pair(code));
  const paired = service.pair(refreshedCode);
  assert.deepEqual(paired.workspaceIds, []);
  await click(tree, '刷新配对状态'); tree = render();
  assert.equal(nodes(tree).some(node => node.props.className === 'vox-pair'), false);
  assert.equal(nodes(tree).filter(node => node.props.type === 'checkbox').length, 0, 'workspace options remain collapsed');
  workspaceTrigger(tree).props.onClick(); tree = render();
  assert.equal(nodes(tree).filter(node => node.props.type === 'checkbox').length, 102);
  searchWorkspaces(' /A ');
  let choices = nodes(tree).filter(node => node.props.type === 'checkbox');
  assert.equal(choices.length, 1); choices[0].props.onChange({ target: { checked: true } }); tree = render();
  searchWorkspaces('work-b');
  choices = nodes(tree).filter(node => node.props.type === 'checkbox');
  assert.equal(choices.length, 1); choices[0].props.onChange({ target: { checked: true } }); tree = render();
  assert.match(label(workspaceTrigger(tree)), /A、B.*已选 2 个/);
  assert.equal(store.bindings(paired.deviceId).length, 0, 'search and selection only edit the draft');
  searchWorkspaces('工作区 99');
  assert.equal(nodes(tree).filter(node => node.props.type === 'checkbox').length, 1, 'names are searchable in a large workspace list');
  searchWorkspaces('does-not-exist');
  assert.equal(nodes(tree).filter(node => node.props.type === 'checkbox').length, 0); assert.match(label(tree), /没有匹配的工作区/);
  assert.match(label(workspaceTrigger(tree)), /已选 2 个/, 'filtering does not remove hidden selections');
  let preventedEnter = false;
  nodes(tree).find(node => node.props['aria-label'] === '搜索可用工作区').props.onKeyDown({ key: 'Enter', preventDefault() { preventedEnter = true; } });
  assert.equal(preventedEnter, true, 'search Enter must not save the form');
  let focusedTrigger = false, stoppedEscape = false;
  nodes(tree).find(node => node.props.className === 'vox-workspace-picker').props.onKeyDown({ key: 'Escape', preventDefault() {},
    stopPropagation() { stoppedEscape = true; }, currentTarget: { querySelector: () => ({ focus() { focusedTrigger = true; } }) } });
  tree = render();
  assert.equal(workspaceTrigger(tree).props['aria-expanded'], false); assert.equal(focusedTrigger && stoppedEscape, true);
  workspaceTrigger(tree).props.onClick(); tree = render();
  assert.equal(nodes(tree).find(node => node.props['aria-label'] === '搜索可用工作区').props.value, '');
  assert.equal(nodes(tree).filter(node => node.props.type === 'checkbox' && node.props.checked).length, 2);
  await submit(tree); tree = render();
  assert.equal(store.bindings(paired.deviceId).length, 2); assert.equal(store.workspaces().length, 2);
  assert.equal(workspaceTrigger(tree).props['aria-expanded'], false);
  assert.ok(commands[2].operations.every(op => op.action === 'bindDevice'));
  const defaultForms = forms(tree).filter(node => !node.props.device);
  defaultForms[0].props.change({ baseUrl: 'http://example.test/v1', model: 'asr' }); tree = render();
  await submit(tree); tree = render();
  assert.match(label(tree), /请填写插件级 TTS/); assert.equal(commands.length, 3);
  forms(tree).find(node => !node.props.device && node.props.kind === 'tts').props.change({ baseUrl: 'http://example.test/v1', model: 'tts' });
  tree = render(); await submit(tree); tree = render();
  assert.ok(store.settings().config.asr); assert.ok(store.settings().config.tts);
  const summary = forms(tree).find(node => !node.props.device && node.props.kind === 'summary');
  summary.props.change({ baseUrl: 'http://example.test/v1', model: 'summary', apiKey: 'summary-secret' });
  tree = render(); await submit(tree); tree = render();
  assert.equal(store.settings().config.summary.model, 'summary');
  assert.equal(view().defaults.summary.apiKey, undefined);
  const summaryForm = (device = false, index = 0) => forms(tree).filter(node => node.props.device === device && node.props.kind === 'summary')[index];
  const switchMode = (mode, device = false, index = 0) => {
    const form = summaryForm(device, index);
    nodes(form.type(form.props)).find(node => node.type === 'select').props.onChange({ target: { value: mode } });
    tree = render();
  };
  for (const form of forms(tree)) {
    assert.doesNotMatch(label(form.type({ ...form.props, value: { ...form.props.value, apiKeySet: true } })), /清除.*密钥/);
  }
  switchMode('inherit'); assert.equal(summaryForm().props.value, null);
  switchMode('custom');
  assert.equal(summaryForm().props.value.baseUrl, 'http://example.test/v1');
  assert.equal(summaryForm().props.value.model, 'summary');
  assert.equal(summaryForm().props.value.apiKeySet, true);
  assert.equal(summaryForm().props.value.apiKey, undefined, 'saved keys stay redacted');
  assert.equal(nodes(tree).find(node => node.type === 'button' && label(node) === '保存配置').props.disabled, true);
  summaryForm().props.change({ ...summaryForm().props.value, model: 'unsaved-summary', apiKey: 'unsaved-secret' }); tree = render();
  switchMode('inherit'); switchMode('custom');
  assert.equal(summaryForm().props.value.model, 'unsaved-summary'); assert.equal(summaryForm().props.value.apiKey, 'unsaved-secret');
  assert.equal(store.settings().config.summary.apiKey, 'summary-secret', 'mode switching does not persist drafts');
  click(tree, '放弃修改'); tree = render();
  switchMode('inherit'); switchMode('custom');
  assert.equal(summaryForm().props.value.model, 'summary'); assert.equal(summaryForm().props.value.apiKey, undefined);
  assert.equal(forms(tree).filter(node => node.props.device).length, 3, 'one model configuration per device regardless of workspace count');
  summaryForm(true).props.change({ baseUrl: 'http://device.test/v1', model: 'device-summary', apiKey: 'device-key' }); tree = render();
  switchMode('inherit', true);
  nodes(tree).find(node => node.props.className === 'vox-card-heading').props.onClick(); tree = render();
  assert.equal(forms(tree).filter(node => node.props.device).length, 0);
  nodes(tree).find(node => node.props.className === 'vox-card-heading').props.onClick(); tree = render();
  switchMode('custom', true);
  assert.equal(summaryForm(true).props.value.model, 'device-summary'); assert.equal(summaryForm(true).props.value.apiKey, 'device-key');
  assert.equal(summaryForm().props.value.model, 'summary');
  click(tree, '放弃修改'); tree = render();
  switchMode('custom', true, 0);
  assert.equal(summaryForm(true, 0).props.value.model, undefined, 'discard clears dormant drafts in other scopes');
  click(tree, '放弃修改'); tree = render();
  const override = forms(tree).find(node => node.props.device && node.props.kind === 'asr');
  override.props.change({ baseUrl: 'http://override.test/v1', model: 'override' });
  tree = render(); await submit(tree); tree = render();
  assert.equal(store.device(paired.deviceId).config.asr.model, 'override');
  assert.deepEqual(Object.keys(store.workspace('work-a')), ['id']);
  click(tree, '＋ 添加音色'); tree = render();
  const voiceInputs = nodes(tree).filter(node => node.type === 'input' && ['例如：温柔女声', '填写 TTS 服务提供的音色 ID'].includes(node.props.placeholder));
  voiceInputs[0].props.onChange({ target: { value: '自然女声' } }); voiceInputs[1].props.onChange({ target: { value: 'alloy' } }); tree = render();
  await submit(tree); tree = render();
  assert.equal(store.voices()[0].value, 'alloy'); assert.equal(store.device(paired.deviceId).voice_id, null);
  service.selectVoice(paired.deviceId, store.voices()[0].id);
  click(tree, '移除音色'); tree = render(); await submit(tree); tree = render();
  assert.equal(store.voices().length, 0); assert.equal(store.device(paired.deviceId).voice_id, null);
  click(tree, '＋ 添加设备'); tree = render(); click(tree, '放弃修改'); tree = render();
  assert.equal(store.devices().length, 1); assert.match(label(tree), /1 台设备/);
  assert.match(label(tree), /手动地址.*已就绪/);
  const pollConnection = timers.find(timer => timer.ms === 3000).fn;
  nodes(tree).find(node => node.props.className === 'vox-card-heading').props.onClick(); tree = render();
  forms(tree).find(form => form.props.device && form.props.kind === 'asr').props.change({ baseUrl: 'https://draft.example.test/v1', model: 'unsaved-device-model' });
  tree = render();
  commandConnectionChange();
  await connection.pending; await pollConnection(); tree = render();
  assert.match(label(tree), /配置或连接地址已变化/);
  assert.equal(forms(tree).find(form => form.props.device && form.props.kind === 'asr').props.value.model, 'unsaved-device-model');
  assert.equal(nodes(tree).filter(node => node.type === 'img').length, 0, 'stale pairing QR must disappear');
  await click(tree, '重新载入'); tree = render();
  assert.equal(store.device(paired.deviceId).paired, null);
  assert.equal(nodes(tree).some(node => node.props.className === 'vox-pair'), true);
  function commandConnectionChange() { service.command({ action: 'configurePairing', origin: 'https://changed.example.test', revision: service.view().revision }); }
  for (const dispose of cleanup.reverse()) dispose?.(); assert.equal(styles.length, 0);
});
