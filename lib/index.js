// lib/index.js —— dsh-proxyagent 插件入口（cordis）
import z from '@deepseek-ai/schemastery';
import { registerTools } from './tools.js';

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

  if (ctx.tools) registerTools(ctx, { getConfig: () => readConfig() });
  ctx.logger?.info?.('dsh-proxyagent: ready');
}

export default { name, inject, Config, apply, plainConfig };
