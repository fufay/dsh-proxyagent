// lib/tools.js —— 向 agent 注册的工具
import * as core from './core.js';

export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  additionalProperties: true,
};

/** DSH 要求 output.render 返回 ContentBlock[] */
export const renderOutput = (_args, result) => [
  { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) },
];

export function registerTools(ctx, { getConfig, getShell } = {}) {
  if (!ctx?.tools?.register) return;
  const cfg = () => {
    try { return (typeof getConfig === 'function' ? getConfig() : null) || {}; } catch { return {}; }
  };
  // DSH 的 shell 接缝（POSIX→bash、Windows→pwsh）。拿不到就传 null，由 core 回退 /bin/sh。
  const shell = () => {
    try { return (typeof getShell === 'function' ? getShell() : null) || null; } catch { return null; }
  };
  /**
   * 「哪个会话在用代理」—— 从工具执行上下文里取（`exec.agent.session.header`）。
   * 用途：设置页「日志」标签页按会话归集（标题在读日志时才解析 ⇒ 热路径零成本）。
   */
  const who = (exec) => {
    try {
      const h = exec && exec.agent && exec.agent.session && exec.agent.session.header;
      if (!h) return {};
      return { session: h.id ? String(h.id) : null, sessionCwd: h.cwd || null, sessionOrigin: h.origin || null };
    } catch { return {}; }
  };
  const out = { schema: OUTPUT_SCHEMA, render: renderOutput };

  // ── 1. 状态 ────────────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'proxy_status',
    description: '查询按需代理状态：是否运行、端口、内核与订阅是否就绪、规则条数、订阅已取回多久。'
      + '未就绪时返回值里的 nextStep 会说明下一步该做什么。默认不开代理；本插件只在需要时用、用完即停。',
    parameters: { type: 'object', properties: {} },
    output: out,
    execute: async () => ({ ok: true, ...(await core.status(cfg())) }),
  });

  // ── 2. 该不该走代理（依据订阅里的规则表）────────────────────────────────────
  ctx.tools.register({
    name: 'proxy_rule_query',
    description: '用订阅里的规则表（Clash 语义，自上而下首条命中）判断某域名/URL 该走代理还是直连。'
      + '判定为直连的一律不要走代理（国内站点经代理反而更慢甚至不通）。'
      + '返回的 verdict 有三种：matched（命中了显式域名规则 / 表尾的 MATCH 且无需 IP ⇒ 按 viaProxy 执行）；'
      + 'undetermined（判定取决于解析后的 IP —— GEOIP,IP-CIDR 这类规则本插件没 GeoIP 库、不做 DNS 解析，'
      + '会在 skippedRules 里列明 ⇒ 此时按 recommendation 办：**先直连，直连失败或超时再用 proxy_run**）；'
      + 'unknown（规则表里连 MATCH 兜底都没有）。',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '域名或完整 URL，例如 github.com 或 https://api.github.com/rate_limit' },
      },
      required: ['target'],
    },
    output: out,
    execute: async (params) => ({ ok: true, ...(await core.ruleQuery(params.target, cfg())) }),
  });

  // ── 3. 取订阅（含 10 分钟窗口的提示）────────────────────────────────────────
  ctx.tools.register({
    name: 'proxy_fetch_subscription',
    description: '按配置里的订阅 URL 取回节点与规则表（严格校验：必须含 proxies: 才落盘）。订阅通常只在服务商后台开关打开后的 10 分钟窗口内可下载。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '可选：临时覆盖配置里的订阅 URL' } },
    },
    output: out,
    execute: async (params, exec) => ({ ok: true, ...(await core.fetchSubscription((params && params.url) || cfg().subscriptionUrl, { ...cfg(), by: 'tool', ...who(exec) })) }),
  });

  // ── 4. 准备内核（首次使用需编译，约 5–20 分钟）──────────────────────────────
  ctx.tools.register({
    name: 'proxy_setup_core',
    description: '准备内置 mihomo 内核：多通道竞速下载预编译版（通常 5–20 秒），失败才用本机 Go 经 goproxy.cn 编译（5–20 分钟）。'
      + '一般不用手动调 —— proxy_run 发现缺内核会自己补。',
    parameters: { type: 'object', properties: {} },
    output: out,
    execute: async (_params, exec) => await core.setupCore({ ...cfg(), by: 'tool', ...who(exec) }),
  });

  // ── 5. 手动启停 ────────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'proxy_start',
    description: '手动启动代理（仅监听 127.0.0.1，不影响本机其它软件）。一般不需要手动调——用 proxy_run 会自动起停。',
    parameters: { type: 'object', properties: {} },
    output: out,
    execute: async (_params, exec) => ({ ok: true, ...(await core.start(cfg(), { by: 'tool', ...who(exec) })) }),
  });

  ctx.tools.register({
    name: 'proxy_stop',
    description: '手动关闭代理。设计原则是"用完即停"，所以除非你刻意保留，一般不需要调用。',
    parameters: { type: 'object', properties: {} },
    output: out,
    execute: async (_params, exec) => ({ ok: true, ...(await core.stop(cfg(), { by: 'tool', ...who(exec) })) }),
  });

  // ── 6. 一条命令：起代理 → 执行 → 立刻关闭（核心入口）────────────────────────
  ctx.tools.register({
    name: 'proxy_run',
    description:
      '在代理环境下执行一条 shell 命令：若代理未开则自动启动，命令结束后自动关闭（本来就开着则借用且不关）。' +
      '首次使用时会**自动补齐**缺失的订阅与内核（无需先手动调 proxy_fetch_subscription / proxy_setup_core），' +
      '这几步耗时会计入本次调用，并在返回值的 prepared 里逐条说明。' +
      '用的是用户在「设置 → 按需代理」里**自己选定**的那个节点（没选过就是节点列表第一个）；' +
      '插件**不会**自动测速、自动换节点，也不会因为命令失败就重跑（重跑与否由你判断）。' +
      '适用：GitHub 系操作（clone/下载 release/API）、直连超时或 "SSL_read: unexpected eof" 的重试。' +
      '不适用：国内镜像与国内站点、搜索/网页抓取、本机与局域网地址——这些直连即可，走代理反而更慢或不通。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令（交给 DSH 的 shell 执行器：POSIX 上是 bash -c，Windows 上是 pwsh -c）' },
        keep: { type: 'boolean', description: 'true = 跑完不关闭（调试用，默认 false）' },
        timeoutMs: { type: 'number', description: '超时毫秒，默认 600000' },
      },
      required: ['command'],
    },
    output: out,
    execute: async (params, exec) => core.runWithProxy(params.command, cfg(), {
      keep: params.keep === true,
      timeoutMs: params.timeoutMs,
      shell: shell(),                 // ★ 交给 DSH 的 shell 接缝 ⇒ Windows 也能跑
      by: 'tool',
      ...who(exec),                   // 记下是哪个会话在用（设置页日志标签页）
    }),
  });
}
