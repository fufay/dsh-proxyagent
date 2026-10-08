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
      const [savedUrl, setSavedUrl] = React.useState('');   // 上次落盘的订阅地址（用来判断"地址变了"）
      const [ov, setOv] = React.useState(null);             // 节点区概览
      const [busy, setBusy] = React.useState('');           // '' | 'save' | 'refresh' | 'test' | 'kernel' | 节点名

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

      // silent=true 时不写消息（供"刷新/自动拉取"先静默落盘用）
      const save = async (silent) => {
        if (!silent) { setBusy('save'); setMsg('保存中…'); }
        try {
          const scope = scopeOf();
          const draft = { ...(vals || {}) };
          if (draft.mixedPort != null) draft.mixedPort = Number(draft.mixedPort) || 17890;
          if (draft.ctlPort != null) draft.ctlPort = Number(draft.ctlPort) || 19090;
          if (scope && typeof scope.update === 'function') await scope.update(draft);
          else if (scope && typeof scope.set === 'function') await scope.set(NS, draft);
          else { if (!silent) setMsg('无法保存：设置服务不可用'); return false; }
          setSavedUrl(String(draft.subscriptionUrl || ''));
          if (!silent) setMsg('✅ 已保存');
          return true;
        } catch (e) { if (!silent) setMsg('保存失败：' + (e && e.message || e)); return false; }
        finally { if (!silent) setBusy(''); }
      };

      const api = async (path, body, method) => {
        const r = await fetch('/api/dsh-proxyagent/' + path, method === 'GET'
          ? { method: 'GET' }
          : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
        return await r.json();
      };

      const loadNodes = async () => {
        try { const j = await api('nodes', null, 'GET'); if (j && Array.isArray(j.nodes)) setOv(j); }
        catch (e) { /* 内核/webServer 不可用时静默：字段区照常能用 */ }
      };
      React.useEffect(() => { loadNodes(); }, []);

      // 「刷新」= 让 host 侧重新从订阅地址下载节点与规则表（与内核无关）。
      // 先把表单静默落盘，这样"改完地址直接点刷新"也能用最新 URL。
      const isRefreshing = busy === 'refresh';
      const refresh = async () => {
        setBusy('refresh');
        setMsg('正在从订阅地址重新下载…');
        try {
          await save(true);
          const j = await api('refresh');
          if (j && j.ok) {
            setMsg(`✅ 已刷新：${j.nodes} 个节点 / ${j.rules} 条规则 / ${(j.elapsedMs / 1000).toFixed(1)}s`
              + (j.restarted ? '（内核已重启，新节点已生效）' : ''));
            await loadNodes();
          } else setMsg('刷新失败：' + ((j && j.error) || '未知错误'));
        } catch (e) { setMsg('刷新失败：' + ((e && e.message) || e)); }
        finally { setBusy(''); }
      };

      const kernel = async (action) => {
        setBusy('kernel');
        setMsg(action === 'start' ? '正在启动内核…' : '正在停止内核…');
        try {
          const j = await api('kernel', { action });
          if (j && j.ok) setMsg(action === 'start' ? '✅ 内核已启动（可以去测速了）' : '✅ 内核已停止');
          else setMsg('失败：' + ((j && j.error) || '未知错误'));
          await loadNodes();
        } catch (e) { setMsg('失败：' + ((e && e.message) || e)); }
        finally { setBusy(''); }
      };

      // 测速：names 为空 = 测全部（会跑一会儿）
      const test = async (names) => {
        const one = names && names.length === 1 ? names[0] : '';
        setBusy(one || 'test');
        setMsg(one ? `正在测「${one}」…` : '正在测全部节点（大订阅可能要几十秒）…');
        try {
          const j = await api('test', { names: names || [] });
          if (j && j.ok) {
            const good = (j.results || []).filter((r) => r.ok).length;
            setMsg(`✅ 测速完成：${good}/${j.tested} 个可用 / ${(j.elapsedMs / 1000).toFixed(1)}s（点「选用」决定用哪个）`);
            await loadNodes();
          } else setMsg('测速失败：' + ((j && j.error) || '未知错误'));
        } catch (e) { setMsg('测速失败：' + ((e && e.message) || e)); }
        finally { setBusy(''); }
      };

      const choose = async (name) => {
        setBusy(name);
        try {
          const j = await api('select', { name });
          if (j && j.ok) {
            setMsg(`✅ 已选用「${name}」` + (j.running ? '（内核在跑，已立即生效）' : '（下次起内核时生效）'));
            await loadNodes();
          } else setMsg('选用失败：' + ((j && j.error) || '未知错误'));
        } catch (e) { setMsg('选用失败：' + ((e && e.message) || e)); }
        finally { setBusy(''); }
      };

      // 清除本机数据：数据目录在插件包之外，**卸载插件不会删它** ⇒
      // 重装后会"继承"上一份订阅（含节点口令）与选用记录 —— 这里给它一个正解入口。
      const [confirmClear, setConfirmClear] = React.useState(false);
      const clearData = async (keepCore) => {
        setBusy('clear');
        setMsg('正在清除本机数据…');
        try {
          const j = await api('clear', { keepCore });
          if (j && j.ok) {
            setMsg(`✅ 已清除：${(j.removed || []).join('、') || '（本来就没有）'}` + (keepCore ? '（内核已保留）' : ''));
            setConfirmClear(false);
            setVals((d) => ({ ...(d || {}), subscriptionUrl: '' }));
            await save(true);
            await loadNodes();
          } else setMsg('清除失败：' + ((j && j.error) || '未知错误'));
        } catch (e) { setMsg('清除失败：' + ((e && e.message) || e)); }
        finally { setBusy(''); }
      };

      if (status === 'unavailable') {
        return React.createElement('div', { style: { padding: 12, opacity: .65 } },
          '设置服务暂不可用（插件前半已运行，可让 agent 直接用 proxy_fetch_subscription 传 URL）');
      }
      if (status === 'loading' || !vals) {
        return React.createElement('div', { style: { padding: 12, opacity: .65 } }, '加载中…');
      }

      const btnStyle = (primary) => ({
        padding: '7px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap',
        border: '1px solid rgba(255,255,255,0.18)',
        background: primary ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.08)',
        color: 'inherit',
      });

      const row = (f) => React.createElement('div', { key: f.key, style: { marginBottom: 12 } },
        React.createElement('div', { style: { fontSize: 13, marginBottom: 4 } }, f.label),
        React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
          React.createElement('input', {
            type: f.type === 'number' ? 'number' : 'text',
            value: vals[f.key] == null ? '' : String(vals[f.key]),
            placeholder: f.placeholder || '',
            onChange: (ev) => setVals((d) => ({ ...(d || {}), [f.key]: ev.target.value })),
            style: {
              flex: 1, boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.16)', background: 'rgba(255,255,255,0.04)',
              color: 'inherit', fontSize: 13, outline: 'none',
            },
          }),
          // ★ 订阅地址旁边的「刷新」：订阅里的节点/规则会变，什么时候变只有你知道
          f.key === 'subscriptionUrl'
            ? React.createElement('button', {
                onClick: refresh, disabled: isRefreshing, title: '重新从订阅地址下载节点与规则表（与内核无关）',
                style: { ...btnStyle(false), cursor: isRefreshing ? 'default' : 'pointer', opacity: isRefreshing ? .6 : 1 },
              }, isRefreshing ? '刷新中…' : '刷新')
            : null
        ),
        f.hint ? React.createElement('div', { style: { fontSize: 11, opacity: .55, marginTop: 4 } }, f.hint) : null
      );

      const delays = (ov && ov.delays) || {};
      const nodeList = (ov && ov.nodes) || [];
      const selected = (ov && ov.selected) || null;
      const running = !!(ov && ov.running);

      const nodeRow = (name) => {
        const d = delays[name];
        const isSel = name === selected;
        const hasDelay = d && typeof d.delay === 'number';
        const delayText = !d ? '未测' : (hasDelay ? d.delay + 'ms' : (d.error || 'timeout'));
        const delayColor = hasDelay ? (d.delay < 300 ? '#4ade80' : d.delay < 800 ? '#fbbf24' : '#f87171') : 'rgba(255,255,255,0.35)';
        return React.createElement('div', {
          key: name,
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderRadius: 6, background: isSel ? 'rgba(96,165,250,0.16)' : 'transparent' },
        },
          React.createElement('button', {
            onClick: () => choose(name), disabled: busy === name, title: '选用这个节点',
            style: { ...btnStyle(isSel), padding: '3px 10px', fontSize: 12, minWidth: 52 },
          }, isSel ? '已选' : '选用'),
          React.createElement('span', {
            style: { flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: name,
          }, name),
          React.createElement('span', { style: { fontSize: 12, color: delayColor, minWidth: 58, textAlign: 'right' } }, delayText),
          React.createElement('button', {
            onClick: () => test([name]), disabled: !!busy || !running,
            title: running ? '只测这一个' : '测速需要内核在跑：先点上面的「启动内核」',
            style: { ...btnStyle(false), padding: '3px 8px', fontSize: 12, opacity: running ? 1 : .45 },
          }, busy === name ? '…' : '⚡')
        );
      };

      // 保存：地址变了就**立刻拉一次订阅**（ClashBox 也是这个行为：填完就开始拉数据）
      const saveAndMaybeFetch = async () => {
        const before = savedUrl;
        if (!await save(false)) return;
        const now = String((vals || {}).subscriptionUrl || '').trim();
        if (now && now !== before) await refresh();
      };

      return React.createElement('div', { style: { padding: '4px 2px' } },
        React.createElement('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 10 } }, 'ProxyAgent（按需代理）'),
        React.createElement('div', { style: { fontSize: 11, opacity: .55, marginBottom: 14 } },
          '默认直连；仅 GitHub 系或直连失败时才走代理，用完即停，只影响本会话。'),
        FIELDS.map(row),
        React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 } },
          React.createElement('button', { onClick: saveAndMaybeFetch, disabled: busy === 'save', style: btnStyle(true) }, busy === 'save' ? '保存中…' : '保存'),
          msg ? React.createElement('span', { style: { fontSize: 12, opacity: .7 } }, msg) : null
        ),

        // ── 节点区：测速与选择都由用户自己点（插件不做任何自动判断）──────────────
        React.createElement('div', { style: { marginTop: 20, borderTop: '1px solid rgba(255,255,255,0.10)', paddingTop: 14 } },
          React.createElement('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 6 } }, '节点（自己测、自己选）'),
          React.createElement('div', { style: { fontSize: 11, opacity: .55, marginBottom: 10 } },
            '插件不替你选节点：点 ⚡ 测速，再点「选用」定下来。选定的节点会被记住，之后 proxy_run 一直用它。'),
          React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 } },
            React.createElement('span', { style: { fontSize: 12, opacity: .85 } }, running ? '🟢 内核运行中' : '⚪ 内核未运行'),
            React.createElement('button', {
              onClick: () => kernel(running ? 'stop' : 'start'), disabled: !!busy, style: { ...btnStyle(false), padding: '5px 12px', fontSize: 12 },
            }, running ? '停止内核' : '启动内核（测速前需要）'),
            React.createElement('button', {
              onClick: () => test([]), disabled: !!busy || !running,
              style: { ...btnStyle(false), padding: '5px 12px', fontSize: 12, opacity: running ? 1 : .5 },
            }, busy === 'test' ? '测速中…' : '全部测速'),
            React.createElement('span', { style: { fontSize: 12, opacity: .7 } },
              `共 ${nodeList.length} 个节点` + (selected ? ` ｜ 当前选用：${selected}` : ' ｜ 尚未选用（默认用列表第一个）'))
          ),
          nodeList.length
            ? React.createElement('div', {
                style: { maxHeight: 300, overflowY: 'auto', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 8, padding: 4 },
              }, nodeList.map(nodeRow))
            : React.createElement('div', { style: { fontSize: 12, opacity: .6 } },
                '还没有节点：在上面填订阅地址并保存（保存后会自动拉取），或点「刷新」。')
        ),

        // ── 本机数据：卸载插件不会删数据目录 ⇒ 这里如实摊开，并给一个从零开始的入口 ──
        React.createElement('div', { style: { marginTop: 18, borderTop: '1px solid rgba(255,255,255,0.10)', paddingTop: 14 } },
          React.createElement('div', { style: { fontSize: 14, fontWeight: 600, marginBottom: 6 } }, '本机数据'),
          React.createElement('div', { style: { fontSize: 11, opacity: .55, marginBottom: 8 } },
            '订阅、内核、节点选用都放在本机数据目录里，**不在插件包内 —— 卸载插件不会删除它**，'
            + '所以重装后会沿用上一份数据（包括订阅里的节点口令）。想从零开始，用下面的清除。'),
          React.createElement('div', { style: { fontSize: 12, opacity: .82, marginBottom: 8 } },
            (() => {
              const d = (ov && ov.data) || null;
              const parts = [];
              if (d && d.configBytes) parts.push(`订阅 ${(d.configBytes / 1024).toFixed(0)} KB`
                + (d.subscriptionAgeDays != null ? `（${d.subscriptionAgeDays} 天前取回）` : ''));
              if (d && d.coreBytes) parts.push(`内核 ${(d.coreBytes / 1048576).toFixed(1)} MB`);
              if (d && d.selected) parts.push(`已选 ${d.selected}`);
              if (d && d.delays) parts.push(`测速记录 ${d.delays} 条`);
              return parts.length ? parts.join(' ｜ ') : '（干净：没有订阅、没有内核、没有选用记录）';
            })()),
          confirmClear
            ? React.createElement('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
                React.createElement('span', { style: { fontSize: 12, opacity: .8 } }, '确认清除？'),
                React.createElement('button', { onClick: () => clearData(false), disabled: busy === 'clear', style: { ...btnStyle(true), padding: '5px 12px', fontSize: 12 } }, '全部清除（含内核）'),
                React.createElement('button', { onClick: () => clearData(true), disabled: busy === 'clear', style: { ...btnStyle(false), padding: '5px 12px', fontSize: 12 } }, '只清订阅与选择'),
                React.createElement('button', { onClick: () => setConfirmClear(false), style: { ...btnStyle(false), padding: '5px 12px', fontSize: 12 } }, '取消'),
                React.createElement('div', { style: { fontSize: 11, opacity: .6, width: '100%' } },
                  '⚠️ 清掉订阅后要重新从订阅地址拉取；若服务商只在后台开关后的 10 分钟窗口内可下载，请在窗口内操作。')
              )
            : React.createElement('button', { onClick: () => setConfirmClear(true), style: { ...btnStyle(false), padding: '5px 12px', fontSize: 12 } }, '清除本机数据…')
        )
      );
    }

    // 设置左侧导航里那一页的注册身份（settings.section 是 list 座位 ⇒ 认 id，不认 key）
    const SECTION_ID = 'proxyagent';

    // 导航文字自己判语言，省掉多注入一个 locale 服务（少一个加载失败点）
    const navLabel = () => {
      try { return /^zh/i.test((typeof navigator !== 'undefined' && navigator.language) || '') ? '按需代理' : 'On-demand proxy'; }
      catch (e) { return 'ProxyAgent'; }
    };

    /** 统一注册：座位已声明就立即挂，尚未声明就用 slots.inject 等它（座位名不存在时永不执行，安全） */
    function registerSeat(ctx, seat, component) {
      const doRegister = () => ctx.slots.register(seat, component);
      try {
        if (typeof ctx.slots.inject === 'function') ctx.slots.inject(seat.name, doRegister);
        else doRegister();
      } catch (e) {
        console.warn('[dsh-proxyagent] ' + seat.name + ' 注册失败', e && e.message || e);
      }
    }

    module.exports.inject = ['slots', 'configForms'];

    module.exports.apply = function apply(ctx) {
      _ctx = ctx;
      if (!ctx || !ctx.slots) return module.exports;

      // ① 插件卡片内（keyed 座位 ⇒ 给 key）
      for (const seat of [
        { name: 'plugins.item', key: PKG },
        { name: 'plugins.row.config', key: ROW_CONFIG_KEY },
      ]) {
        registerSeat(ctx, { name: seat.name, key: seat.key, title: () => 'ProxyAgent' }, Panel);
      }

      // ② ★ 在「设置」左侧导航挂一页 —— 技能 / Agent 预设 / 备份与迁移 / 侧边卡片都是走这个座位。
      //    这样装完直接在「设置」里就能看到「按需代理」，不必先翻「插件」列表。
      //    order 25：紧跟「技能」(17)、「Agent 预设」(20)，排在「备份与迁移」(60) 之前。
      registerSeat(ctx, { name: 'settings.section', id: SECTION_ID, order: 25, label: navLabel }, Panel);

      return module.exports;
    };

    return module.exports;
  },
});
