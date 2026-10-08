// lib/client.js —— dsh-proxyagent 的客户端半边（提供"设置 → 插件"里的配置表单）
// 依据已装插件的实际写法：inject ['slots','configForms'] + 往 plugins.row.config 座位注册组件
window.__ModuleLoader__.load({
  id: 'dsh-proxyagent',
  factory: (require) => {
    var module = { exports: {} };
    const React = require('react');

    const NS = 'dsh-proxyagent';                 // 设置命名空间 = cordis.patch.yml 里的 entry id
    const PKG = 'dsh-proxyagent';
    const ROW_CONFIG_KEY = PKG + '#' + NS;

    let _ctx = null;                             // apply 时捕获（不依赖 props，稳妥）

    const FIELDS = [
      { key: 'subscriptionUrl', label: '订阅地址', type: 'text',
        placeholder: 'https://…/ems/get?token=…',
        hint: '服务商后台打开开关后通常只有 10 分钟可下载；填好后让 agent 执行 proxy_fetch_subscription' },
      { key: 'mixedPort', label: '本地代理端口', type: 'number',
        hint: 'HTTP+SOCKS 混合端口，仅监听 127.0.0.1（默认 17890）' },
      { key: 'ctlPort', label: '内核控制端口', type: 'number',
        hint: '仅监听 127.0.0.1（默认 19090）' },
      { key: 'mihomoVersion', label: '内核版本', type: 'text',
        hint: '首次准备内核时使用（默认 v1.19.32）' },
    ];

    function scopeOf() {
      try {
        const s = (_ctx && (_ctx.configForms || (_ctx.get && _ctx.get('configForms')))) || null;
        return s && typeof s.get === 'function' ? s.get(NS) : null;
      } catch (e) { return null; }
    }

    function Panel() {
      const [vals, setVals] = React.useState(null);
      const [status, setStatus] = React.useState('loading');
      const [msg, setMsg] = React.useState('');

      React.useEffect(() => {
        let alive = true; let unsub = null;
        const load = () => {
          try {
            const scope = scopeOf();
            if (!scope) { setStatus('unavailable'); return; }
            const snap = typeof scope.getSnapshot === 'function' ? scope.getSnapshot() : null;
            if (snap && snap.status === 'loading') { setStatus('loading'); return; }
            if (snap && snap.status === 'unavailable') { setStatus('unavailable'); return; }
            const v = snap && snap.values ? snap.values : (snap || {});
            if (alive) { setVals((d) => ({ ...(d || {}), ...v })); setStatus('ready'); }
          } catch (e) { if (alive) setStatus('unavailable'); }
        };
        load();
        try { const s = scopeOf(); if (s && typeof s.subscribe === 'function') unsub = s.subscribe(load); } catch (e) {}
        return () => { alive = false; if (typeof unsub === 'function') unsub(); };
      }, []);

      const save = async () => {
        setMsg('保存中…');
        try {
          const scope = scopeOf();
          const draft = { ...(vals || {}) };
          if (draft.mixedPort != null) draft.mixedPort = Number(draft.mixedPort) || 17890;
          if (draft.ctlPort != null) draft.ctlPort = Number(draft.ctlPort) || 19090;
          if (scope && typeof scope.update === 'function') await scope.update(draft);
          else if (scope && typeof scope.set === 'function') await scope.set(NS, draft);
          else { setMsg('无法保存：设置服务不可用'); return; }
          setMsg('✅ 已保存');
        } catch (e) { setMsg('保存失败：' + (e && e.message || e)); }
      };

      if (status === 'unavailable') {
        return React.createElement('div', { style: { padding: 12, opacity: .65 } },
          '设置服务暂不可用（插件前半已运行，可让 agent 直接用 proxy_fetch_subscription 传 URL）');
      }
      if (status === 'loading' || !vals) {
        return React.createElement('div', { style: { padding: 12, opacity: .65 } }, '加载中…');
      }

      const row = (f) => React.createElement('div', { key: f.key, style: { marginBottom: 12 } },
        React.createElement('div', { style: { fontSize: 13, marginBottom: 4 } }, f.label),
        React.createElement('input', {
          type: f.type === 'number' ? 'number' : 'text',
          value: vals[f.key] == null ? '' : String(vals[f.key]),
          placeholder: f.placeholder || '',
          onChange: (ev) => setVals((d) => ({ ...(d || {}), [f.key]: ev.target.value })),
          style: {
            width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8,
            border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(255,255,255,0.04)',
            color: 'inherit', fontSize: 13, outline: 'none',
          },
        }),
        f.hint ? React.createElement('div', { style: { fontSize: 11, opacity: .55, marginTop: 4 } }, f.hint) : null
      );

      return React.createElement('div', { style: { padding: '4px 2px' } },
        React.createElement('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 10 } }, 'ProxyAgent（按需代理）'),
        React.createElement('div', { style: { fontSize: 11, opacity: .55, marginBottom: 14 } },
          '默认直连；仅 GitHub 系或直连失败时才走代理，用完即停，只影响本会话。'),
        FIELDS.map(row),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 } },
          React.createElement('button', {
            onClick: save,
            style: {
              padding: '7px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
              border: '1px solid rgba(255,255,255,0.18)', background: 'rgba(255,255,255,0.08)', color: 'inherit',
            },
          }, '保存'),
          msg ? React.createElement('span', { style: { fontSize: 12, opacity: .7 } }, msg) : null
        )
      );
    }

    module.exports.inject = ['slots', 'configForms'];

    module.exports.apply = function apply(ctx) {
      _ctx = ctx;
      if (!ctx || !ctx.slots) return module.exports;
      for (const seat of [
        { name: 'plugins.item', key: PKG },
        { name: 'plugins.row.config', key: ROW_CONFIG_KEY },
      ]) {
        const doRegister = () => ctx.slots.register({
          name: seat.name, key: seat.key, title: () => 'ProxyAgent',
        }, Panel);
        try {
          if (typeof ctx.slots.inject === 'function') ctx.slots.inject(seat.name, doRegister);
          else doRegister();
        } catch (e) {
          console.warn('[dsh-proxyagent] ' + seat.name + ' 注册失败', e && e.message || e);
        }
      }
      return module.exports;
    };

    return module.exports;
  },
});
