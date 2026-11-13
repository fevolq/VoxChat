export async function mountPanel(React, ctx, css) {
  await ctx.remote.$mount(REMOTE);
  await ctx.inject(['remote.voxchat'], scope => {
    const h = React.createElement;
    scope.effect(() => {
      const style = document.createElement('style'); style.textContent = css; document.head.append(style);
      return () => style.remove();
    });
    // DSH 0.2.1-rc.2 hard-codes nav icons by section id; scope this override to our settings entry.
    scope.effect(() => {
      const marker = 'data-voxchat-settings-icon';
      const syncIcon = () => {
        for (const row of document.querySelectorAll('[role="dialog"] nav button')) {
          row.toggleAttribute(marker, row.textContent.trim() === '语音交互');
        }
      };
      const observer = new MutationObserver(syncIcon);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      syncIcon();
      return () => {
        observer.disconnect();
        for (const row of document.querySelectorAll('[' + marker + ']')) row.removeAttribute(marker);
      };
    });
    const kinds = ['asr', 'tts', 'summary'];
    const titles = { asr: '语音识别 ASR', tts: '语音合成 TTS', summary: '播报总结模型' };
    const button = (label, action, disabled = false, className = '') => h('button', { type: 'button', onClick: action, disabled, className }, label);
    function ModelFields({ kind, device, value, change, changeMode, disabled }) {
      const selectable = device || kind === 'summary', inherited = device ? '继承插件配置' : '继承当前会话模型';
      const update = (key, fieldValue) => change({ ...(value ?? {}), [key]: fieldValue });
      const field = (key, label, { type = 'text', placeholder = '', wide = false, required = false } = {}) => h('label', { className: 'vox-field' + (wide ? ' vox-wide' : ''), key },
        h('span', null, label, required && h('span', { className: 'vox-required' }, ' *')),
        h('input', { type, value: value?.[key] ?? '', placeholder, disabled, required, 'aria-required': required,
          autoComplete: type === 'password' ? 'new-password' : 'off', ...(type === 'number' ? { min: 0.25, max: 4, step: 0.05 } : {}),
          onChange: event => {
            if (type === 'number' && event.target.value === '') { const next = { ...value }; delete next[key]; change(next); }
            else update(key, type === 'number' ? Number(event.target.value) : event.target.value);
          } }));
      return h('details', { className: 'vox-model' },
        h('summary', null, titles[kind], !device && h('span', { className: 'vox-required' }, ' *')),
        h('div', { className: 'vox-model-body' },
          selectable && h('label', { className: 'vox-field' }, '配置方式', h('select', { value: value ? 'custom' : 'inherit', disabled,
            onChange: event => changeMode(event.target.value) },
            h('option', { value: 'inherit' }, inherited), h('option', { value: 'custom' }, '独立配置'))),
          (!selectable || value) && h('div', { className: 'vox-grid' },
            field('baseUrl', 'API 基础地址', { type: 'url', placeholder: 'https://example.com/v1', wide: true, required: true }),
            field('model', '模型名称', { placeholder: '填写服务提供的模型名称', required: true }),
            field('apiKey', 'API Key', { type: 'password', placeholder: value?.apiKeySet ? '已保存，未编辑时保留' : '无需认证的服务可留空' }),
            kind === 'asr' && field('language', '识别语言', { placeholder: '可选，例如 zh' }),
            kind === 'tts' && [field('speed', '语速', { type: 'number', placeholder: '默认 1' }),
              h('label', { key: 'format', className: 'vox-field' }, '音频格式', h('select', { value: value?.format ?? 'mp3', disabled,
                onChange: event => update('format', event.target.value) },
                ...['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'].map(format => h('option', { key: format, value: format }, format))))])));
    }
    function Panel() {
      const [view, setView] = React.useState(null), [draft, setDraft] = React.useState(null);
      const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [stale, setStale] = React.useState(false);
      const [expanded, setExpanded] = React.useState(null), [pairings, setPairings] = React.useState([]);
      const [qrPreview, setQrPreview] = React.useState(null);
      const [workspacePicker, setWorkspacePicker] = React.useState(null);
      const [now, setNow] = React.useState(Date.now);
      const generation = React.useRef(0), active = React.useRef(false), localId = React.useRef(0);
      const customDrafts = React.useRef(new Map());
      const latest = React.useRef(null), polling = React.useRef(false);
      latest.current = { view, draft };
      const accept = value => { customDrafts.current.clear(); setWorkspacePicker(null); setView(value); setDraft(createDraft(value)); setStale(false); setError(''); };
      const refresh = async () => {
        if (active.current) return;
        const version = ++generation.current;
        try {
          const response = await scope.remote.voxchat.view();
          if (!response.ok) throw new Error(response.error?.message || '读取配置失败');
          if (version === generation.current) accept(response.value);
        } catch (error) { if (version === generation.current) { setError(error.message); setStale(true); } }
      };
      React.useEffect(() => {
        void refresh();
        const dispose = scope.on('connection/reset', () => {
          generation.current++; setStale(true); setError('连接已重置，请重新载入配置后再保存。');
        });
        const timer = setInterval(() => setNow(Date.now()), 1000);
        const statusTimer = setInterval(async () => {
          if (active.current || polling.current || !latest.current.view) return;
          polling.current = true; const version = generation.current;
          try {
            const response = await scope.remote.voxchat.view();
            if (!response.ok) throw new Error(response.error?.message || '读取连接状态失败');
            if (version !== generation.current || active.current) return;
            const current = latest.current;
            if (response.value.revision !== current.view.revision) {
              setPairings([]);
              if (JSON.stringify(current.draft) !== JSON.stringify(createDraft(current.view))) {
                setView(old => ({ ...old, connection: response.value.connection }));
                setStale(true); setError('配置或连接地址已变化，请重新载入后再保存。');
              } else accept(response.value);
            } else if (JSON.stringify(response.value.connection) !== JSON.stringify(current.view.connection)) {
              setView(old => ({ ...old, connection: response.value.connection }));
            }
          } catch (error) { if (version === generation.current) { setError(error.message); setStale(true); } }
          finally { polling.current = false; }
        }, 3000);
        return () => { generation.current++; clearInterval(timer); clearInterval(statusTimer); dispose(); };
      }, []);
      if (!view || !draft) return h('div', { className: 'vox-panel' }, h('p', { role: 'status' }, error || '正在加载语音交互…'), button('重新加载', refresh));
      const dirty = JSON.stringify(draft) !== JSON.stringify(createDraft(view));
      const disabled = busy || stale || !view.writable;
      const addDevice = () => {
        const deviceId = 'new-device-' + ++localId.current;
        setDraft(old => ({ ...old, devices: [...old.devices, { id: deviceId, name: '', saved: false, workspaceIds: [], config: {} }] }));
        setWorkspacePicker(null); setExpanded(deviceId); setError('');
      };
      const setWorkspace = (deviceId, workspaceId, checked) => setDraft(old => ({ ...old,
        devices: old.devices.map(device => device.id === deviceId ? { ...device,
          workspaceIds: checked ? [...new Set([...device.workspaceIds, workspaceId])] : device.workspaceIds.filter(id => id !== workspaceId) } : device),
      }));
      const updateDevice = (deviceId, kind, value) => setDraft(old => ({ ...old,
        devices: old.devices.map(row => row.id === deviceId ? { ...row, config: { ...row.config, [kind]: value } } : row) }));
      const commandAction = async (action, deviceId) => {
        if (active.current || disabled || dirty) return;
        active.current = true; setBusy(true); setError(''); const version = generation.current;
        let received = false;
        try {
          const response = await scope.remote.voxchat.command({ action, ...(deviceId ? { deviceId } : {}), revision: view.revision });
          received = true;
          if (version !== generation.current) return;
          if (!response.ok) { setStale(true); throw new Error(response.error?.message || '刷新结果未确认，请重新载入'); }
          if (!response.value.accepted) {
            if (response.value.error.code === 'REVISION_CONFLICT') setStale(true);
            throw new Error(response.value.error.message);
          }
          accept(response.value.view); setNow(Date.now());
          if (action === 'refreshPairing') setPairings(old => [...old.filter(item => item.id !== deviceId), response.value.result]);
        } catch (error) { if (version === generation.current) { setError(error.message); if (!received) setStale(true); } }
        finally { active.current = false; setBusy(false); }
      };
      const save = async event => {
        event.preventDefault();
        if (active.current || disabled || !dirty) return;
        let operations;
        try { operations = buildOperations(view, draft); } catch (error) { setError(error.message); return; }
        if (!operations.length) { setDraft(createDraft(view)); return; }
        active.current = true; setBusy(true); setError(''); const version = generation.current;
        let responseReceived = false;
        try {
          const response = await scope.remote.voxchat.command({ action: 'batch', revision: view.revision, operations });
          responseReceived = true;
          if (version !== generation.current) return;
          if (!response.ok) { setStale(true); throw new Error(response.error?.message || '保存结果未确认，请重新载入'); }
          if (!response.value.accepted) {
            if (response.value.error.code === 'REVISION_CONFLICT') setStale(true);
            throw new Error(response.value.error.message);
          }
          const created = response.value.result.filter(row => row.action === 'addDevice').map(row => row.result);
          const newIndex = draft.devices.filter(device => !device.saved).findIndex(device => device.id === expanded);
          accept(response.value.view); setExpanded(newIndex >= 0 ? created[newIndex]?.id ?? null : expanded);
          setPairings(old => [...old, ...created]);
        } catch (error) { if (version === generation.current) { setError(error.message); if (!responseReceived) setStale(true); } }
        finally { active.current = false; setBusy(false); }
      };
      const modelFields = (config, deviceId, change) => kinds.map(kind => h(ModelFields, { key: kind, kind, device: deviceId !== null,
        value: config[kind], change: value => change(kind, value), disabled,
        changeMode: mode => {
          const key = JSON.stringify([deviceId, kind]);
          if (mode === 'inherit') {
            if (config[kind]) customDrafts.current.set(key, structuredClone(config[kind]));
            change(kind, null);
          } else {
            const value = customDrafts.current.has(key) ? structuredClone(customDrafts.current.get(key)) : kind === 'tts' ? { format: 'mp3', speed: 1 } : {};
            change(kind, value);
          }
        } }));
      const cards = draft.devices.map(device => {
        const open = expanded === device.id, pairing = pairings.find(item => item.id === device.id && item.expires === device.expires);
        const valid = !device.paired && pairing && pairing.expires > now;
        let qrImage, qrError;
        if (open && valid && !stale && view.connection?.status === 'ready') {
          try {
            const link = pairingLink(view.connection.origin, pairing.code);
            qrImage = pairingImage(link, qrcode);
          }
          catch (error) { qrError = error.message; }
        }
        const missing = device.workspaceIds.filter(id => !view.available.some(row => row.id === id)).map(id => ({ id, title: '工作区已不可用', path: id }));
        const workspaces = [...view.available, ...missing], pickerOpen = workspacePicker?.deviceId === device.id;
        const query = pickerOpen ? workspacePicker.query.trim().toLocaleLowerCase() : '';
        const matches = workspaces.filter(workspace => [workspace.title, workspace.path, workspace.id].join(' ').toLocaleLowerCase().includes(query));
        const selectedNames = workspaces.filter(workspace => device.workspaceIds.includes(workspace.id)).map(workspace => workspace.title || workspace.id).join('、');
        return h('section', { className: 'vox-card', key: device.id },
          h('button', { type: 'button', className: 'vox-card-heading', 'aria-expanded': open, 'aria-controls': 'vox-body-' + device.id,
            onClick: () => { setWorkspacePicker(null); setExpanded(open ? null : device.id); } },
            h('strong', null, device.name || '新设备'),
            h('span', { 'aria-hidden': true }, open ? '⌃' : '⌄')),
          open && h('div', { className: 'vox-card-body', id: 'vox-body-' + device.id },
            !device.saved && h('label', { className: 'vox-field' }, h('span', null, '设备名称', h('span', { className: 'vox-required' }, ' *')),
              h('input', { value: device.name, placeholder: '例如：我的 iPhone', disabled, maxLength: 80, required: true,
                onChange: event => setDraft(old => ({ ...old, devices: old.devices.map(item => item.id === device.id ? { ...item, name: event.target.value } : item) })) })),
            device.saved && !device.paired && h('div', { className: 'vox-pair' },
              h('div', { className: 'vox-pair-content' }, h('div', null,
                h('div', { className: 'vox-pair-heading' }, h('span', null, '配对码'),
                  valid && !stale && h('small', null, '有效期至 ' + new Date(pairing.expires).toLocaleTimeString() + '（5 分钟）')),
                valid && !stale ? h('code', null, pairing.code)
                  : !(device.expires && device.expires <= now) && h('p', { className: 'vox-help' }, '点击刷新配对码，生成新的配对码和二维码。'),
                h('div', { className: 'vox-pair-actions' }, button('刷新配对码', () => commandAction('refreshPairing', device.id), disabled || dirty || view.connection?.status !== 'ready', 'vox-small'),
                  button('刷新配对状态', refresh, busy || dirty, 'vox-small'))),
                qrImage && h('button', { type: 'button', className: 'vox-qr-trigger', 'aria-label': '放大配对二维码', 'aria-haspopup': 'dialog',
                  onClick: () => setQrPreview({ deviceId: device.id, code: pairing.code }) },
                  h('img', { className: 'vox-qr', src: qrImage, alt: '使用 VoxChat 客户端扫描绑定设备', width: 128, height: 128 })),
                qrImage && qrPreview?.deviceId === device.id && qrPreview.code === pairing.code && h('dialog', {
                  className: 'vox-qr-dialog', 'aria-label': '配对二维码',
                  ref: node => { if (node && !node.open) node.showModal(); },
                  onClose: () => setQrPreview(null),
                  onCancel: event => event.stopPropagation(),
                  onKeyDown: event => { if (event.key === 'Escape') event.stopPropagation(); },
                  onClick: event => { if (event.target === event.currentTarget) event.currentTarget.close(); },
                }, h('div', { className: 'vox-qr-dialog-body' },
                  h('div', { className: 'vox-qr-dialog-heading' }, h('h3', null, '配对二维码'),
                    h('button', { type: 'button', className: 'vox-qr-close', 'aria-label': '关闭二维码大图', autoFocus: true,
                      onClick: event => event.currentTarget.closest('dialog').close() }, '×')),
                  h('img', { className: 'vox-qr-large', src: qrImage, alt: '放大的配对二维码', width: 320, height: 320 }),
                  h('code', null, pairing.code),
                  h('small', { className: 'vox-help' }, '有效期至 ' + new Date(pairing.expires).toLocaleTimeString() + '（5 分钟）')))),
              qrError && h('p', { className: 'vox-help' }, qrError),
              view.connection?.status !== 'ready' && h('p', { className: 'vox-help' }, '连接入口尚未就绪，请查看配对设置。'),
              dirty && h('p', { className: 'vox-help' }, '请先保存或放弃修改，再刷新配对码。')),
            h('h4', null, '可用工作区'),
            !device.saved ? h('p', { className: 'vox-help' }, '先保存设备并完成配对，再为设备配置可用工作区。')
              : h('div', { className: 'vox-workspace-picker',
                onBlur: event => { if (!event.currentTarget.contains(event.relatedTarget)) setWorkspacePicker(null); },
                onKeyDown: event => {
                  if (event.key === 'Escape' && pickerOpen) {
                    event.preventDefault(); event.stopPropagation(); setWorkspacePicker(null);
                    event.currentTarget.querySelector('button').focus();
                  }
                } },
                h('button', { type: 'button', className: 'vox-workspace-trigger', disabled, 'aria-label': '选择可用工作区',
                  'aria-expanded': pickerOpen, 'aria-controls': 'vox-workspaces-' + device.id,
                  onClick: () => setWorkspacePicker(pickerOpen ? null : { deviceId: device.id, query: '' }) },
                  h('span', { className: selectedNames ? 'vox-workspace-selection' : 'vox-workspace-selection vox-help', title: selectedNames }, selectedNames || '请选择工作区'),
                  device.workspaceIds.length > 0 && h('span', { className: 'vox-workspace-count' }, `已选 ${device.workspaceIds.length} 个`),
                  h('svg', { className: 'vox-workspace-chevron', viewBox: '0 0 16 16', 'aria-hidden': true, focusable: false },
                    h('path', { d: 'M4 6 L8 10 L12 6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))),
                pickerOpen && h('div', { className: 'vox-workspace-menu', id: 'vox-workspaces-' + device.id },
                  h('div', { className: 'vox-workspace-search' }, h('input', { type: 'search', placeholder: '搜索工作区名称或路径',
                    'aria-label': '搜索可用工作区', value: workspacePicker.query, disabled, autoFocus: true,
                    onKeyDown: event => { if (event.key === 'Enter') event.preventDefault(); },
                    onChange: event => setWorkspacePicker({ deviceId: device.id, query: event.target.value }) })),
                  h('div', { className: 'vox-workspace-options', role: 'group', 'aria-label': '可用工作区列表' },
                    ...matches.map(workspace => h('label', { className: 'vox-workspace-option', key: workspace.id },
                      h('input', { type: 'checkbox', checked: device.workspaceIds.includes(workspace.id), disabled,
                        onChange: event => setWorkspace(device.id, workspace.id, event.target.checked) }),
                      h('span', null, h('strong', null, workspace.title || workspace.id), h('small', null, workspace.path)))),
                    !matches.length && h('p', { className: 'vox-help', role: 'status' }, workspaces.length ? '没有匹配的工作区' : '请先在 DSH 中创建工作区。')))),
            device.saved && h('details', { className: 'vox-device-config' }, h('summary', null, '设备模型配置'),
              ...modelFields(device.config, device.id, (kind, value) => updateDevice(device.id, kind, value))),
            button('移除设备', () => setDraft(old => ({ ...old, devices: old.devices.filter(row => row.id !== device.id) })), disabled, 'vox-danger vox-remove'),
            device.saved && h('p', { className: 'vox-help' }, '移除设备会撤销其凭证和全部工作区授权，保存后生效。')));
      });
      return h('form', { className: 'vox-panel', onSubmit: save, noValidate: true },
        h('header', null, h('h2', null, '语音交互'), h('span', { className: 'vox-help' }, `${draft.devices.length} 台设备`)),
        h('div', { className: 'vox-body' },
          h('div', { className: 'vox-section-heading' }, h('h3', null, '设备配置'), button('＋ 添加设备', addDevice, disabled)),
          cards.length ? cards : h('div', { className: 'vox-empty' }, h('span', { 'aria-hidden': true }, '⇄'), h('strong', null, '还没有绑定设备'),
            button('添加第一台设备', addDevice, disabled, 'vox-primary')),
          h('details', { className: 'vox-defaults' }, h('summary', null, '音色管理'),
            ...draft.voices.map(voice => h('div', { className: 'vox-voice-row', key: voice.id },
              h('div', { className: 'vox-grid' }, ...[['name', '音色名称', '例如：温柔女声'], ['value', '音色 ID', '填写 TTS 服务提供的音色 ID']].map(([key, title, placeholder]) =>
                h('label', { className: 'vox-field', key }, title, h('input', { value: voice[key], placeholder, disabled, required: true, maxLength: key === 'name' ? 80 : 200,
                  onChange: event => setDraft(old => ({ ...old, voices: old.voices.map(row => row.id === voice.id ? { ...row, [key]: event.target.value } : row) })) })))),
              button('移除音色', () => setDraft(old => ({ ...old, voices: old.voices.filter(row => row.id !== voice.id) })), disabled, 'vox-small vox-danger'))),
            !draft.voices.length && h('p', { className: 'vox-help' }, '统一添加音色后，在客户端选择使用。'),
            button('＋ 添加音色', () => setDraft(old => ({ ...old, voices: [...old.voices, { id: 'voice-' + Date.now().toString(36) + '-' + ++localId.current, name: '', value: '' }] })), disabled),
            draft.voices.length > 0 && h('p', { className: 'vox-help' }, '音色 ID 需受所用 TTS 服务支持。移除音色后，使用它的设备需重新选择。')),
          h('details', { className: 'vox-defaults' }, h('summary', null, '配对设置'),
            h('div', { className: 'vox-field' },
              h('div', { className: 'vox-field-heading' }, h('label', { htmlFor: 'vox-pairing-origin' }, 'DSH 访问地址'),
                h('span', { className: 'vox-tip' },
                  h('button', { type: 'button', className: 'vox-tip-trigger', 'aria-label': 'DSH 访问地址说明', 'aria-describedby': 'vox-pairing-origin-tip' }, '?'),
                  h('span', { className: 'vox-tip-content', id: 'vox-pairing-origin-tip', role: 'tooltip' },
                    '填写时使用此地址；留空自动启动公网隧道。实际地址变化后，所有设备需重新配对，原配置和授权保留。'))),
              h('input', { id: 'vox-pairing-origin', type: 'url', value: draft.pairingOrigin, disabled,
              placeholder: '留空自动启动公网隧道',
              onChange: event => setDraft(old => ({ ...old, pairingOrigin: event.target.value })) })),
            h('p', { className: 'vox-help', role: 'status' }, `${view.connection?.mode === 'manual' ? '手动地址' : '自动隧道'} · ${{ starting: '正在连接…', ready: '已就绪', error: '连接失败', stopped: '已停止' }[view.connection?.status] || '正在读取状态…'}`),
            view.connection?.origin && h('label', { className: 'vox-field' }, '当前连接地址', h('input', { value: view.connection.origin, readOnly: true })),
            view.connection?.error && h('p', { className: 'vox-error', role: 'alert' }, view.connection.error),
            view.connection?.mode === 'tunnel' && view.connection.status === 'error' && button('重试隧道', () => commandAction('retryTunnel'), disabled || dirty, 'vox-small')),
          h('details', { className: 'vox-defaults' }, h('summary', null, '插件模型配置'),
            ...modelFields(draft.defaults, null, (kind, value) => setDraft(old => ({ ...old, defaults: { ...old.defaults, [kind]: value } })))),
          !view.writable && h('p', { className: 'vox-error', role: 'alert' }, '当前 DSH 设置为只读。')),
        h('footer', null,
          h('span', { className: error ? 'vox-error' : 'vox-help', role: error ? 'alert' : 'status' }, error || (busy ? '正在保存…' : dirty ? '有未保存的修改' : '')),
          h('div', { className: 'vox-actions' }, stale && button('重新载入', refresh, busy),
            button('放弃修改', () => { customDrafts.current.clear(); setWorkspacePicker(null); setDraft(createDraft(view)); setError(''); }, busy || !dirty),
            h('button', { type: 'submit', className: 'vox-primary', disabled: disabled || !dirty }, busy ? '保存中…' : '保存配置'))));
    }
    scope.slots.inject('settings.section', () => scope.slots.register({ name: 'settings.section', id: 'voxchat', order: 55,
      label: () => '语音交互', inject: () => ({}) }, Panel));
  }).await();
}
