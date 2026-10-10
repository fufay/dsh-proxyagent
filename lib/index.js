// lib/index.js —— dsh-proxyagent 插件入口（cordis）
import z from '@deepseek-ai/schemastery';
import { registerTools } from './tools.js';
import * as core from './core.js';

export const name = 'dsh-proxyagent';
export const inject = ['tools', 'settings'];

/** 设置界面由 volatile 字段生成 —— 用户只需填订阅 URL */
export const Config = z.object({
  subscriptionUrl: z.string().default('')
    .volatile()
    .description('订阅地址。服务商后台打开开关后通常只有 10 分钟可下载，填好后执行 proxy_fetch_subscription。'),
  mixedPort: z.number().default(17890)
    .volatile()
    .description('本地混合代理端口（HTTP+SOCKS）。仅监听 127.0.0.1，不影响本机其它软件。'),
  ctlPort: z.number().default(19090)
    .volatile()
    .description('内核控制端口（仅 127.0.0.1），用于查询状态与切换节点。'),
  mihomoVersion: z.string().default('v1.19.32')
    .volatile()
    .description('内置内核版本。首次 proxy_setup_core 时经 goproxy.cn 镜像取源码编译，不依赖 GitHub。'),
  idleSeconds: z.number().default(5)
    .volatile()
    .description('空闲自动关闭（秒）：这么久没人使用（无命令在跑、内核无活动连接）就自动关内核；0 = 不自动关（常驻）。默认 5 秒。'),
});

/** 设置命名空间 = cordis.patch.yml 里的 entry id（不是包名） */
const NS = 'dsh-proxyagent';

export function plainConfig(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(plainConfig);
  if (typeof value.get === 'function') return plainConfig(value.get());
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plainConfig(v)]));
}

export function apply(ctx, config) {
  let readConfig = () => plainConfig(Config(ctx.fiber?.config ?? config));

  ctx.inject(['settings'], (sctx) => {
    if (!sctx?.settings) return;
    try {
      if (typeof sctx.settings.configure === 'function') sctx.settings.configure({ auto: false }, ctx.fiber);
    } catch (e) {
      ctx.logger?.warn?.('dsh-proxyagent: settings configure failed: ' + (e?.message || e));
    }
    const readLive = () => {
      try {
        if (typeof sctx.settings.describe === 'function') {
          const row = sctx.settings.describe()?.find?.((r) => r.ns === NS);
          if (row?.value && typeof row.value === 'object') return plainConfig(Config(row.value));
        } else if (typeof sctx.settings.get === 'function') {
          const v = sctx.settings.get(NS);
          if (v && typeof v === 'object') return plainConfig(Config(v));
        }
      } catch (e) {
        ctx.logger?.debug?.('dsh-proxyagent: read settings failed', e);
      }
      return null;
    };
    readConfig = () => readLive() ?? plainConfig(Config(ctx.fiber?.config ?? config));
  });

  // ── 执行通道：DSH 的 shell 接缝（平台无关）──────────────────────────────────
  // 用**可选注入**：拿不到就返回 null，由 core 回退 POSIX `/bin/sh`（绝不让缺服务变成加载失败）。
  // POSIX 上它是 bash 执行器、Windows 上是 pwsh ⇒ `proxy_run` 不再依赖 `/bin/sh`（Windows 修复的关键）。
  let shellRef = null;
  ctx.inject(['shell'], (sctx) => {
    try {
      shellRef = sctx?.shell || null;
      if (shellRef) ctx.logger?.info?.('dsh-proxyagent: 已接入 DSH 的 shell 接缝（proxy_run 可跨平台执行）');
    } catch (e) {
      ctx.logger?.debug?.('dsh-proxyagent: 取 shell 接缝失败（将回退 /bin/sh）', e);
    }
  });

  if (ctx.tools) registerTools(ctx, { getConfig: () => readConfig(), getShell: () => shellRef });

  // ── 监视线程（v0.4.0）：没人用满 idleSeconds 秒就关内核 ─────────────────────
  // 用户 2026-10-10 定的方案：一条时间线取代"谁起的谁关"（那会掐断并发的其它使用者）。
  // 单例 + 整 tick try/catch ⇒ 重复 apply 不会起两个，异常也不会把定时器带走。
  try {
    core.startWatchdog(() => readConfig());
    ctx.logger?.info?.(`dsh-proxyagent: 监视线程已启动（空闲 ${core.idleSeconds(readConfig())} 秒自动关内核；0=常驻）`);
  } catch (e) {
    ctx.logger?.warn?.('dsh-proxyagent: 监视线程启动失败（不影响其它功能）', e && e.message || e);
  }
  if (typeof ctx.on === 'function') {
    try { ctx.on('dispose', () => { try { core.stopWatchdog(); } catch { /* ignore */ } }); } catch { /* ignore */ }
  }

  // ── 设置页的宿主后端：/api/dsh-proxyagent/* ─────────────────────────────────
  // 客户端半边跑在浏览器里、碰不到文件系统/内核，所以这些都必须是 host 侧的活。
  // webServer 是可选的（无 Web 的部署照常工作）⇒ 用 ctx.inject 等它，缺了也不报错。
  ctx.inject(['webServer'], (sctx) => {
    try {
      if (!sctx?.webServer?.register) return;
      const json = (res, code, body) => {
        res.writeHead(code, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify(body));
      };
      const readBody = (req) => new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => { raw += c; if (raw.length > 1 << 20) req.destroy(); });
        req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); } });
        req.on('error', () => resolve({}));
      });

      sctx.webServer.register({
        kind: 'prefix',
        path: '/api/dsh-proxyagent',
        handler: async (req, res) => {
          // 同源校验：浏览器发起的跨站请求必然带 Origin，用它挡住 CSRF（无 Origin 的非浏览器调用放行）
          const origin = req.headers && req.headers.origin;
          if (origin) {
            try {
              if (new URL(origin).host !== (req.headers.host || '')) return json(res, 403, { ok: false, error: 'cross-origin denied' });
            } catch { return json(res, 403, { ok: false, error: 'bad origin' }); }
          }
          const pathname = new URL(req.url, 'http://localhost').pathname.replace(/\/+$/, '');
          const cfg = { ...readConfig(), by: 'settings' };   // 设置页发起的动作 ⇒ 日志里标 by:'settings'
          try {
            // 读：节点区要的全部信息
            if (req.method === 'GET' && pathname === '/api/dsh-proxyagent/nodes') {
              return json(res, 200, await core.nodesOverview(cfg));
            }
            // 读：使用日志（设置页「日志」标签页）。★ 只在打开该页时读一次，热路径零成本。
            if (req.method === 'GET' && pathname === '/api/dsh-proxyagent/log') {
              const limit = Number(new URL(req.url, 'http://localhost').searchParams.get('limit')) || 200;
              const r = core.readUsage(cfg, { limit });
              return json(res, 200, { ok: true, ...r, now: new Date().toISOString() });
            }
            if (req.method !== 'POST') return json(res, 405, { ok: false, error: '请用 POST' });
            const body = await readBody(req);

            // 重新取订阅（订阅地址旁的「刷新」按钮）
            if (pathname === '/api/dsh-proxyagent/refresh') {
              const r = await core.refreshSubscription(cfg);
              ctx.logger?.info?.(`dsh-proxyagent: 订阅已刷新（${r.nodes} 节点 / ${r.rules} 规则 / ${r.elapsedMs}ms）`);
              return json(res, 200, r);
            }

            // 测速：测指定节点（不给就测全部）。需要内核在跑。
            if (pathname === '/api/dsh-proxyagent/test') {
              const st = await core.status(cfg);
              if (!st.running) return json(res, 200, { ok: false, error: '内核未运行：先点「启动内核」再测速' });
              const all = (await core.listNodes(cfg)).all;
              const want = Array.isArray(body.names) && body.names.length ? body.names.filter((n) => all.includes(n)) : all;
              if (!want.length) return json(res, 200, { ok: false, error: '没有可测的节点' });
              const t0 = Date.now();
              const results = await core.testNodes(want, cfg, {
                timeoutMs: Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : 3000,
                concurrency: Number(body.concurrency) > 0 ? Number(body.concurrency) : 16,
              });
              core.saveDelays(results, cfg);
              return json(res, 200, {
                ok: true, elapsedMs: Date.now() - t0, tested: results.length,
                results: results.map((r) => ({ node: r.node, ok: r.ok, delay: r.delay ?? null, error: r.error || null })),
              });
            }

            // 选定节点（用户点的那一下）
            if (pathname === '/api/dsh-proxyagent/select') {
              if (!body.name) return json(res, 200, { ok: false, error: '缺少 name' });
              return json(res, 200, await core.selectNode(String(body.name), cfg));
            }

            // 清除本机数据（订阅 / 选用 / 测速记录 / 运行时；keepCore=true 则保留内核二进制）
            // 为什么需要它：数据目录在插件包之外，卸载插件不会删 ⇒ 重装后会"继承"上一份订阅
            if (pathname === '/api/dsh-proxyagent/clear') {
              const r = await core.clearLocalData(cfg, { keepCore: body.keepCore === true });
              ctx.logger?.warn?.(`dsh-proxyagent: 已清除本机数据 [${(r.removed || []).join(', ')}] keepCore=${r.keepCore}`);
              return json(res, 200, r);
            }

            // 内核启停（节点页上的按钮）
            if (pathname === '/api/dsh-proxyagent/kernel') {
              if (body.action === 'stop') return json(res, 200, { ok: true, ...(await core.stop(cfg)) });
              if (body.action === 'start') {
                // 手动启动 ⇒ 钉住：监视线程不会自动关它（否则用户正在测速/选节点时内核会消失）
                const s = await core.start(cfg, { by: 'settings', pinned: true });
                return json(res, 200, { ok: true, running: true, selected: s.selected ?? core.getSelectedNode(cfg), prepared: s.prepared || [] });
              }
              return json(res, 200, { ok: false, error: 'action 只能是 start / stop' });
            }
            return json(res, 404, { ok: false, error: 'not found' });
          } catch (e) {
            // 失败也用 200 + ok:false 回，前端好统一展示（含 403 的"10 分钟窗口"提示）
            return json(res, 200, { ok: false, error: String((e && e.message) || e) });
          }
        },
      });
      ctx.logger?.info?.('dsh-proxyagent: 已挂 /api/dsh-proxyagent/*（设置页：刷新 / 节点列表 / 测速 / 选节点 / 内核启停）');
    } catch (e) {
      ctx.logger?.warn?.('dsh-proxyagent: 注册设置页路由失败: ' + ((e && e.message) || e));
    }
  });

  ctx.logger?.info?.('dsh-proxyagent: ready');
}

export default { name, inject, Config, apply, plainConfig };
