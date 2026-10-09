// lib/core.js —— ProxyAgent 引擎（纯 JS，自包含，不依赖任何工作区路径）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * 本机平台 → 内核资产/文件名。跨平台要点（2026-10-08 加的）：
 *   · **本机（社区版 DSHM for HarmonyOS）`process.platform === 'openharmony'`**，
 *     不是 'linux' ⇒ 必须显式映射，否则任何按 'linux' 判断的写法在这台机器上都会判错；
 *   · Node 的 arch 是 'x64'，Go 的是 'amd64' ⇒ 要做映射；
 *   · Windows 的可执行文件要带 `.exe`。
 * 返回 { os, arch, ext }，例：{ os:'linux', arch:'arm64', ext:'' }
 */
export function platformTarget(p = process.platform, a = process.arch) {
  // ★ process.platform 在 Windows 上是 'win32'（不是 'windows'）；本机是 'openharmony'（不是 'linux'）
  const osName = p === 'openharmony' ? 'linux' : p === 'win32' ? 'windows' : p;
  const arch = a === 'x64' ? 'amd64' : a === 'ia32' ? '386' : a;    // Node → Go 的架构命名
  const ext = osName === 'windows' ? '.exe' : '';
  return { os: osName, arch, ext };
}

/** 数据目录：优先 $DSH_HOME/proxyagent，退回 ~/dsh/home/proxyagent */
export function dataDir() {
  const home = process.env.DSH_HOME
    || (fs.existsSync(path.join(os.homedir(), 'dsh', 'home')) ? path.join(os.homedir(), 'dsh', 'home') : null)
    || path.join(os.homedir(), '.dsh');
  return path.join(home, 'proxyagent');
}

export function paths(cfg = {}) {
  const d = cfg.dataDir || dataDir();
  return {
    dir: d,
    bin: path.join(d, 'bin', 'mihomo' + platformTarget().ext),   // Windows 上是 mihomo.exe
    config: path.join(d, 'config.yaml'),      // 订阅原件（含口令 ⇒ 600）
    runtime: path.join(d, 'runtime.yaml'),    // 生成的运行配置
    pid: path.join(d, 'mihomo.pid'),
    log: path.join(d, 'mihomo.log'),
    gomod: path.join(d, 'gomodcache'),
    gocache: path.join(d, 'gocache'),
  };
}

export function portOpen(port, host = '127.0.0.1', timeout = 700) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const fin = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(timeout);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    s.connect(port, host);
  });
}

function readPid(p) {
  try {
    const n = parseInt(fs.readFileSync(p, 'utf8').trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 状态：{ running, pid, mixedPort, corePresent, subscriptionPresent, rules, ready, nextStep } */
export async function status(cfg = {}) {
  const p = paths(cfg);
  const mixed = cfg.mixedPort || 17890;
  const pid = readPid(p.pid);
  const running = await portOpen(mixed);
  let rules = 0;
  let fetchedAtMs = null;
  try {
    const t = fs.readFileSync(p.config, 'utf8');
    fetchedAtMs = fs.statSync(p.config).mtimeMs;
    const m = t.match(/^rules:[ \t]*\r?\n([\s\S]*?)(?=^[A-Za-z][\w-]*[ \t]*:|$(?![\s\S]))/m);
    if (m) rules = m[1].split('\n').filter((l) => l.trim().startsWith('-')).length;
  } catch { /* 未取订阅 */ }
  const corePresent = fs.existsSync(p.bin);
  const subscriptionPresent = fetchedAtMs !== null;
  // 订阅新鲜度：节点/规则会变，agent 据此决定要不要重取（见 refreshAfterDays 策略）
  const subscriptionAgeDays = fetchedAtMs === null ? null : +((Date.now() - fetchedAtMs) / 86400000).toFixed(1);
  const ready = corePresent && subscriptionPresent;
  // 未就绪时给 agent 一句"下一步该干什么"，避免它只会说"不可用"
  const nextStep = ready
    ? null
    : (!subscriptionPresent
      ? '在「设置 → 按需代理」填入订阅地址，然后执行 proxy_fetch_subscription 取回节点与规则表'
      : '还没有内核：执行 proxy_setup_core（多镜像下载，失败才用本机 Go 编译）');
  return {
    running: !!running,
    pid: alive(pid) ? pid : null,
    mixedPort: mixed,
    ctlPort: cfg.ctlPort || 19090,
    corePresent,
    subscriptionPresent,
    subscriptionFetchedAt: fetchedAtMs === null ? null : new Date(fetchedAtMs).toISOString(),
    subscriptionAgeDays,
    rules,
    ready,
    nextStep,
    // 用户在设置页选定的节点；**没选过也要说清**（不是错误：内核会用列表第一个）
    ...(() => {
      const s = readState(cfg);
      if (s && s.node) return { selectedNode: s.node, nodeSelectedAt: s.selectedAt || null };
      return subscriptionPresent
        ? { selectedNode: null, nodeNote: '尚未选用节点：内核会用订阅列表第一个；可在设置页点 ⚡ 测速后点「选用」' }
        : {};
    })(),
    dir: p.dir,
  };
}

/** 取订阅（严格校验：必须出现 proxies: 才落盘） */
export async function fetchSubscription(url, cfg = {}) {
  if (!url) throw new Error('未配置订阅 URL：请在「设置 → 按需代理」填入订阅地址，或调用 proxy_fetch_subscription 时临时传 url');
  const p = paths(cfg);
  await fsp.mkdir(p.dir, { recursive: true });
  const UAS = ['mihomo/v1.19.32', 'ClashMetaForAndroid/2.11.6', 'clash'];
  // ★ 必须带超时：不然"连上了但半天不响应"会把工具调用一直挂住（每个 UA 最多等 30s）
  const TIMEOUT_MS = Number(cfg.fetchTimeoutMs) > 0 ? Number(cfg.fetchTimeoutMs) : 30000;
  let lastErr = '';
  for (const ua of UAS) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': ua }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
      const text = await r.text();
      if (r.status !== 200) { lastErr = `HTTP ${r.status}`; continue; }
      if (!/proxies:/.test(text)) { lastErr = '响应中没有 proxies:（可能是 403 页面）'; continue; }
      const n = (text.match(/^\s*-\s*\{?\s*name:/gm) || []).length;
      await fsp.writeFile(p.config, text, { mode: 0o600 });
      await fsp.chmod(p.config, 0o600).catch(() => {});
      logUsage(cfg, { kind: 'fetch', by: cfg.by || 'tool', session: cfg.session || null, nodes: n, bytes: Buffer.byteLength(text), ua });
      return { ok: true, bytes: Buffer.byteLength(text), nodes: n, ua, file: p.config, fetchedAt: new Date().toISOString() };
    } catch (e) { lastErr = String(e && e.message || e); }
  }
  throw new Error(`取订阅失败（${lastErr}）。若为 403：订阅通常只在后台开关打开后的 10 分钟窗口内可下载。`);
}

/** 从订阅里解析候选节点名（保留给 generateRuntimeConfig 用；现在=全部节点） */
export async function candidateNodes(cfg = {}) {
  const { all } = await listNodes(cfg);
  return { all, names: all };
}

/**
 * 由订阅生成"自包含最小运行配置"：全部 proxies + 一个 select 组 + MATCH 全走代理
 * （不依赖 GeoIP/GeoSite，内核启动不会去下载 MMDB）。
 *
 * 为什么是 select 而不是 url-test 自动选优（2026-10-08 用户拍板"别让系统做太多判断"）：
 *   ① url-test 有**异步窗口**：内核刚起来时它还没测完，实测此刻组里报的是"节点列表第一个"；
 *   ② 每次 proxy_run 都重起内核，url-test 就要把上百个节点全测一遍（实测 ~30s）；
 *   ③ **选哪个节点由用户在设置页自己测、自己选**（像 ClashBox 那样），插件不替他决定；
 *      select 组支持 PUT /proxies/PIN 手动指定，url-test 不支持。
 *   ⇒ 内核起来后只是把 PIN 指到"用户选过的那个节点"（没选过就用列表第一个）。
 */
export async function generateRuntimeConfig(cfg = {}) {
  const p = paths(cfg);
  const src = await fsp.readFile(p.config, 'utf8');
  const m = src.match(/^proxies:[ \t]*\r?\n([\s\S]*?)(?=^[A-Za-z][\w-]*[ \t]*:|$(?![\s\S]))/m);
  if (!m) throw new Error('订阅文件里找不到 proxies: 段');
  const proxies = m[1].replace(/\s+$/, '');
  const { all: allNames, names } = await candidateNodes(cfg);
  if (!names.length) throw new Error('订阅里没有解析出任何节点');
  const q = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const mixed = cfg.mixedPort || 17890;
  const ctl = cfg.ctlPort || 19090;
  const out = `# dsh-proxyagent 运行配置（自动生成，勿手改）
# 节点：全部 ${allNames.length} 个都放进组里；用哪个由用户在设置页自己测、自己选
mixed-port: ${mixed}
allow-lan: false
bind-address: 127.0.0.1
mode: rule
log-level: warning
ipv6: false
external-controller: '127.0.0.1:${ctl}'
unified-delay: true
tcp-concurrent: true

proxies:
${proxies}

proxy-groups:
  # 只有一个组，由插件通过控制器 PUT /proxies/PIN 指定用哪个节点
  # （select 组不做后台测速 ⇒ 内核起得快、也不白跑流量）
  - name: PIN
    type: select
    proxies:
${names.map((n) => '      - ' + q(n)).join('\n')}

rules:
  - MATCH,PIN
`;
  await fsp.writeFile(p.runtime, out, { mode: 0o600 });
  return { ok: true, nodes: names.length, file: p.runtime, mixedPort: mixed, ctlPort: ctl };
}

/* ────────────────── 节点测速与选择：**由用户在设置页决定**，插件不替他选 ────────────────── */

const CTL_PROBE_URL = 'https://www.gstatic.com/generate_204';

function ctlBase(cfg = {}) {
  return `http://127.0.0.1:${cfg.ctlPort || 19090}`;
}

function statePath(cfg = {}) {
  return path.join(paths(cfg).dir, 'state.json');
}

/** 上次选中的节点（存盘，供下次"沿用"） */
export function readState(cfg = {}) {
  try { return JSON.parse(fs.readFileSync(statePath(cfg), 'utf8')); } catch { return null; }
}

function writeState(cfg, data) {
  try {
    fs.mkdirSync(paths(cfg).dir, { recursive: true });
    fs.writeFileSync(statePath(cfg), JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.chmodSync(statePath(cfg), 0o600);
  } catch { /* 记账失败不影响主流程 */ }
}

/** 把 PIN 组指到某个节点（select 组支持；url-test 不支持 —— 这就是改成 select 的原因） */
export async function setPin(node, cfg = {}) {
  const r = await fetch(`${ctlBase(cfg)}/proxies/PIN`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: node }),
    signal: AbortSignal.timeout(5000),
  });
  return r.status === 204 || r.ok;
}

/** 测单个节点的延迟（内核自己发起，返回 delay 或超时） */
export async function testNode(node, cfg = {}, timeoutMs) {
  const to = Number(timeoutMs) > 0 ? Number(timeoutMs) : 3000;
  const url = `${ctlBase(cfg)}/proxies/${encodeURIComponent(node)}/delay`
    + `?timeout=${to}&url=${encodeURIComponent(CTL_PROBE_URL)}`;
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(to + 2500) });
    const body = await r.json().catch(() => null);
    if (r.ok && body && typeof body.delay === 'number' && body.delay > 0) {
      return { ok: true, node, delay: body.delay, ms: Date.now() - t0 };
    }
    return { ok: false, node, error: (body && body.message) || `HTTP ${r.status}`, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, node, error: String((e && e.message) || e).slice(0, 60), ms: Date.now() - t0 };
  }
}

/** 并发测一批节点，按延迟升序返回（只保留通的） */
export async function testNodes(nodes, cfg = {}, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 3000;
  const concurrency = Number(opts.concurrency) > 0 ? Number(opts.concurrency) : 16;
  const out = [];
  let i = 0;
  const worker = async () => {
    while (i < nodes.length) {
      const n = nodes[i++];
      out.push(await testNode(n, cfg, timeoutMs));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, nodes.length) }, worker));
  return out.sort((a, b) => (a.ok === b.ok ? (a.delay || 0) - (b.delay || 0) : (a.ok ? -1 : 1)));
}

/**
 * 列出租订阅里的**全部**节点（不替用户砍：选哪个由用户在设置页决定）。
 * 返回 { all } —— all 为节点名数组，顺序 = 订阅里的顺序。
 */
export async function listNodes(cfg = {}) {
  const src = await fsp.readFile(paths(cfg).config, 'utf8');
  const m = src.match(/^proxies:[ \t]*\r?\n([\s\S]*?)(?=^[A-Za-z][\w-]*[ \t]*:|$(?![\s\S]))/m);
  if (!m) throw new Error('订阅文件里找不到 proxies: 段');
  const all = [...m[1].matchAll(/^\s*-\s*\{?\s*name:\s*["']?([^"',}\n]+)/gm)].map((x) => x[1].trim());
  return { all };
}

/** 用户手动选定的节点（存在 state.json；没选过就是 null）—— 系统不替他选 */
export function getSelectedNode(cfg = {}) {
  const s = readState(cfg);
  return s && s.node ? s.node : null;
}

/** 用户在设置页点选了某个节点 ⇒ 存盘；内核若在跑就立刻生效 */
export async function selectNode(node, cfg = {}) {
  const { all } = await listNodes(cfg);
  if (!all.includes(node)) throw new Error(`订阅里没有这个节点：${node}`);
  writeState(cfg, { ...(readState(cfg) || {}), node, selectedAt: new Date().toISOString() });
  const st = await status(cfg);
  const applied = st.running ? await setPin(node, cfg) : false;
  return { ok: true, node, applied, running: st.running };
}

/** 内核起来后把 PIN 指到"用户选定的节点"；没选过就不动（= 候选第一个） */
export async function applySelection(cfg = {}) {
  const node = getSelectedNode(cfg);
  if (!node) return { applied: false, node: null, reason: '还没选过节点（内核会用列表第一个；可在设置→按需代理 里选）' };
  const ok = await setPin(node, cfg);
  return { applied: ok, node };
}

/** 把一批测速结果记账（供设置页下次打开时显示上次的延迟） */
export function saveDelays(results, cfg = {}) {
  const delays = { ...((readState(cfg) || {}).delays || {}) };
  const at = new Date().toISOString();
  for (const r of results || []) {
    delays[r.node] = r.ok ? { delay: r.delay, at } : { delay: null, error: r.error || 'timeout', at };
  }
  writeState(cfg, { ...(readState(cfg) || {}), delays });
  return delays;
}

/**
 * 本机数据目录概况 —— 让"**刚装的插件怎么已经有节点了**"这件事可见。
 *
 * 根因（2026-10-08 用户实测发现）：订阅/内核/选用记录都放在 `$DSH_HOME/proxyagent/`，
 * 那是**插件包之外**的目录 ⇒ 卸载插件（pnpm remove）**不会**删它。
 * 于是"卸载 → 重装"之后，新装的插件会直接读到上一份订阅（含节点口令）与选用记录。
 * 这里把这份数据"有几个、多久了"如实报出来，并提供清空入口（clearLocalData）。
 */
export async function localDataSummary(cfg = {}) {
  const p = paths(cfg);
  const st = await status(cfg);
  let configBytes = 0; let configFetchedAt = null;
  try { const s = fs.statSync(p.config); configBytes = s.size; configFetchedAt = s.mtime.toISOString(); } catch { /* 没订阅 */ }
  let coreBytes = 0;
  try { coreBytes = fs.statSync(p.bin).size; } catch { /* 没内核 */ }
  const state = readState(cfg) || {};
  return {
    dir: p.dir,
    configBytes,
    configFetchedAt,
    subscriptionAgeDays: st.subscriptionAgeDays,
    coreBytes,
    hasRuntime: fs.existsSync(p.runtime),
    selected: state.node || null,
    delays: Object.keys(state.delays || {}).length,
    // 干净 = 没订阅、没内核、没选用（真·新装就该是这样）
    pristine: configBytes === 0 && coreBytes === 0 && !state.node,
  };
}

/**
 * 清除本机数据 —— 「新装却有数据」的正解入口（设置页按钮）。
 * keepCore=true 时保留内核二进制（省一次十几 MB 下载）。
 * ⚠️ 删订阅前请确认还能重新取到：有些服务商只在后台开关打开后的 10 分钟窗口内可下载。
 */
export async function clearLocalData(cfg = {}, opts = {}) {
  const p = paths(cfg);
  const removed = [];
  try { await stop(cfg); } catch { /* 没在跑就算了 */ }
  const targets = [p.config, p.runtime, p.pid, statePath(cfg)];
  if (opts.keepCore !== true) targets.push(p.bin);
  for (const f of targets) {
    try { if (fs.existsSync(f)) { fs.rmSync(f, { force: true }); removed.push(path.basename(f)); } } catch { /* 单个失败不阻塞 */ }
  }
  return { ok: true, removed, keepCore: opts.keepCore === true, ...(await localDataSummary(cfg)) };
}

/** 设置页节点区要的全部信息：内核状态 / 已选节点 / 节点列表 / 上次测速结果 / 本机数据概况 */
export async function nodesOverview(cfg = {}) {
  const st = await status(cfg);
  let all = [];
  let error = null;
  try { all = (await listNodes(cfg)).all; } catch (e) {
    // ★ 没有订阅时 listNodes 必然 ENOENT —— 那是"还没填订阅"的正常新装状态，
    //   不是错误（以前会把 ENOENT 当 error 回给设置页，容易误导）。只有"订阅在但读不出来"
    //   才值得报错。
    if (st.subscriptionPresent) error = String((e && e.message) || e);
  }
  const s = readState(cfg) || {};
  return {
    ok: true,
    running: st.running,
    selected: s.node || null,
    selectedAt: s.selectedAt || null,
    nodes: all,
    nodeCount: all.length,
    delays: s.delays || {},
    kernelPresent: st.corePresent,
    mixedPort: st.mixedPort,
    ctlPort: st.ctlPort,
    subscriptionPresent: st.subscriptionPresent,
    data: await localDataSummary(cfg),
    ...(error ? { error } : {}),
  };
}

/* ───────────────────────── 使用日志（设置页「日志」标签页） ─────────────────────────
 * 设计约束（用户 2026-10-09 明确要求）：**不能让插件本身的效率降低**。
 *   · 热路径只多一次 appendFileSync（约 200 B）+ 一次 statSync（约 0.1–0.3 ms），无定时器、无后台 I/O；
 *   · 读日志只在打开「日志」标签页时发生；
 *   · 文件超过 USAGE_MAX_BYTES 就裁剪到最近 USAGE_KEEP_LINES 行，不会无限增长；
 *   · 任何异常都被吞掉 —— **记账绝不能影响代理功能**。
 */

const USAGE_MAX_BYTES = 512 * 1024;
const USAGE_KEEP_LINES = 2000;

export function usagePath(cfg = {}) {
  return path.join(paths(cfg).dir, 'usage.jsonl');
}

/** 追加一条使用记录（JSONL）。失败静默 —— 记账不是主功能。 */
export function logUsage(cfg = {}, entry = {}) {
  try {
    const p = usagePath(cfg);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
    if (fs.statSync(p).size > USAGE_MAX_BYTES) {
      const lines = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(p, lines.slice(-USAGE_KEEP_LINES).join('\n') + '\n', { mode: 0o600 });
    }
  } catch { /* 忽略：日志失败不影响代理 */ }
}

/** 读使用日志：最新的在前 + 汇总统计（统计基于**当前保留的**记录窗口） */
export function readUsage(cfg = {}, opts = {}) {
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 200;
  let lines = [];
  try { lines = fs.readFileSync(usagePath(cfg), 'utf8').split('\n').filter(Boolean); } catch { /* 还没日志 */ }
  const all = [];
  for (const l of lines) { try { const o = JSON.parse(l); if (o && typeof o === 'object') all.push(o); } catch { /* 跳过坏行 */ } }

  const stats = { events: all.length, runs: 0, okRuns: 0, failRuns: 0, proxyMs: 0, firstAt: null, lastAt: null, bySession: {} };
  for (const e of all) {
    if (!stats.firstAt) stats.firstAt = e.t || null;
    stats.lastAt = e.t || stats.lastAt;
    if (e.kind === 'run') {
      stats.runs++;
      if (e.ok) stats.okRuns++; else stats.failRuns++;
      if (Number(e.ms) > 0) stats.proxyMs += Number(e.ms);
      const key = e.session || '(未知会话)';
      const s = stats.bySession[key] || (stats.bySession[key] = { runs: 0, ms: 0, lastAt: null, title: e.title || null });
      s.runs++; s.ms += Number(e.ms) || 0; s.lastAt = e.t || s.lastAt;
      if (!s.title && e.title) s.title = e.title;
    }
  }
  const entries = all.slice(-limit).reverse().map((e) => ({ ...e, title: e.title || sessionTitle(e.session) }));
  return { entries, stats, path: usagePath(cfg), retained: all.length };
}

/**
 * 会话标题：从端侧**会话缓存**里取（`storages/session_projcache/sessions/<id>.json` 的
 * `record.rows.title.val`）。只在读日志时调用 ⇒ 热路径零成本；读不到就返回 null。
 */
export function sessionTitle(id) {
  if (!id || typeof id !== 'string') return null;
  try {
    const base = path.join(dataDir(), '..', 'storages', 'session_projcache', 'sessions');
    const f = path.join(base, `${id}.json`);
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const t = j && j.record && j.record.rows && j.record.rows.title && j.record.rows.title.val;
    return typeof t === 'string' && t ? t.slice(0, 80) : null;
  } catch { return null; }
}

/**
 * 从命令里提取所有目标站点（给使用日志的 `host` / `hosts` 用）。
 *
 * ★ 取反类必须排掉 **shell 元字符**（`;` `&` `|` `(` `)` `<` `>` 反引号 反斜杠），
 *   否则 `https://a.com; echo x` 会把分号吃进 host
 *   （2026-10-09 用户测试报告 §7.1，已定位到原正则 `[^/\s'"]+` 漏了 `;`）。
 * ★ 用 matchAll 取**全部**目标，不再像原来那样只记第一个（报告 §7.2）。
 */
export function extractHosts(command, max = 8) {
  try {
    const found = [...String(command || '').matchAll(/https?:\/\/([^/\s'";&|()<>`\\]+)/g)]
      .map((m) => m[1]).filter(Boolean);
    return [...new Set(found)].slice(0, max);
  } catch { return []; }
}

/**
 * 首次使用自动补齐 —— 让新用户**只需填一个订阅地址**，不必手动点两个工具。
 *   缺订阅 ⇒ 用设置里的 subscriptionUrl 自动取回
 *   缺内核 ⇒ 自动取内核（多通道竞速下载；没有 Go 工具链也能用）
 * 幂等：都齐了就什么都不做。`cfg.autoPrepare === false` 可关掉。
 */
export async function ensureReady(cfg = {}) {
  const prepared = [];
  if (cfg.autoPrepare === false) return { prepared, ...(await status(cfg)) };
  let st = await status(cfg);
  if (!st.subscriptionPresent) {
    if (!cfg.subscriptionUrl) {
      throw new Error('未配置订阅地址：请在「设置 → 按需代理」填入订阅地址（subscriptionUrl）后重试');
    }
    const t0 = Date.now();
    const r = await fetchSubscription(cfg.subscriptionUrl, cfg);
    prepared.push(`已自动取回订阅：${r.nodes} 个节点 / ${(r.bytes / 1024).toFixed(0)} KB / ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    st = await status(cfg);
  }
  if (!st.corePresent) {
    const t0 = Date.now();
    const r = await setupCore(cfg);
    const took = ((Date.now() - t0) / 1000).toFixed(1);
    prepared.push(r.downloaded
      ? `已自动准备内核：经 ${r.from} 下载 ${r.sizeMB} MB / ${took}s`
      : `已自动编译内核：${r.sizeMB} MB / ${took}s（本机 Go 经 goproxy.cn 取源码）`);
    st = await status(cfg);
  }
  if (!st.ready) throw new Error('自动补齐后仍未就绪（内核或订阅缺失），请执行 proxy_status 查看 nextStep');
  return { prepared, ...st };
}

/** 启动内核（幂等；缺订阅/缺内核时自动补齐；起来后套用用户选过的节点） */
export async function start(cfg = {}, opts = {}) {
  const p = paths(cfg);
  const st = await status(cfg);
  if (st.running) return { ok: true, already: true, prepared: [], selected: getSelectedNode(cfg), ...st };
  const tStart = Date.now();
  let prepared = [];
  if (!fs.existsSync(p.bin) || !fs.existsSync(p.config)) {
    // ★ 首次使用自动补齐：不必先手动 proxy_fetch_subscription + proxy_setup_core
    const e = await ensureReady(cfg);
    prepared = e.prepared;
  }
  if (!fs.existsSync(p.bin)) throw new Error(`内核不存在：${p.bin}（可执行 proxy_setup_core，或把 autoPrepare 打开）`);
  if (!fs.existsSync(p.config)) throw new Error('还没有订阅配置：请先在「设置 → 按需代理」填订阅地址，再执行 proxy_fetch_subscription');
  await generateRuntimeConfig(cfg);
  await fsp.mkdir(p.dir, { recursive: true });
  const out = fs.openSync(p.log, 'a');
  const child = spawn(p.bin, ['-d', p.dir, '-f', p.runtime], {
    detached: true, stdio: ['ignore', out, out], cwd: p.dir, env: { ...process.env },
  });
  child.unref();
  await fsp.writeFile(p.pid, String(child.pid), { mode: 0o600 });
  for (let i = 0; i < 40; i++) {
    if (await portOpen(cfg.mixedPort || 17890)) {
      // 端口通了就完事：只把 PIN 指到"用户选过的节点"（没选过就保持列表第一个）。
      // ★ 这里**不做任何测速/自动判断** —— 选哪个节点由用户在设置页决定。
      const sel = await applySelection(cfg);
      logUsage(cfg, {
        kind: 'start', by: opts.by || 'tool',
        session: opts.session || null, cwd: opts.sessionCwd || null,
        pid: child.pid, node: sel.node || null, ms: Date.now() - tStart,
        prepared: prepared.length,
      });
      return { ok: true, started: true, pid: child.pid, prepared, selected: sel.node, selection: sel, ...(await status(cfg)) };
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`启动后 ${(40 * 0.3).toFixed(0)}s 内端口未就绪，看日志：${p.log}`);
}

/** 关闭内核 */
export async function stop(cfg = {}, opts = {}) {
  const p = paths(cfg);
  const port = cfg.mixedPort || 17890;
  const pid = readPid(p.pid);
  const tStop = Date.now();
  if (pid && alive(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 250));
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
  }
  await fsp.rm(p.pid, { force: true }).catch(() => {});
  // ★ 等端口**真的**释放再回报（2026-10-09 用户实测：原来 SIGTERM 后立刻查端口，
  //   会返回 running:true 这种"还没落定"的中间态，调用方会误判成没停掉）
  for (let i = 0; i < 25; i++) {
    if (!(await portOpen(port, '127.0.0.1', 300))) {
      logUsage(cfg, { kind: 'stop', by: opts.by || 'tool', session: opts.session || null, ms: Date.now() - tStop });
      return { ok: true, running: false };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { ok: true, running: await portOpen(port) };
}

/**
 * 手动刷新订阅 —— 设置界面「刷新」按钮背后的动作（也可被工具调用）。
 * 重新下载节点与规则表；**与内核无关**（换内核版本走 proxy_setup_core）。
 * 若内核正在运行（且是我们自己起的），重启它，让新节点立刻生效。
 */
export async function refreshSubscription(cfg = {}) {
  if (!cfg.subscriptionUrl) throw new Error('未配置订阅地址：请先在「设置 → 按需代理」填入 subscriptionUrl');
  const t0 = Date.now();
  const before = await status(cfg);
  const r = await fetchSubscription(cfg.subscriptionUrl, cfg);
  let restarted = false;
  if (before.running && before.pid) {
    // 只重启"我们自己起的"那个实例：靠 pid 文件认领，不去动别人的进程
    await stop(cfg);
    await start(cfg);
    restarted = true;
  }
  const st = await status(cfg);
  return {
    ok: true,
    nodes: r.nodes,
    bytes: r.bytes,
    rules: st.rules,
    fetchedAt: st.subscriptionFetchedAt,
    elapsedMs: Date.now() - t0,
    restarted,
    ua: r.ua,
  };
}

/**
 * 执行一条命令 —— **优先走 DSH 自己的 shell 接缝**（`ctx.shell`），拿不到才退回 POSIX `/bin/sh`。
 *
 * 为什么要接缝（2026-10-09 用户在 Windows 上实测暴露）：
 *   原来硬编码 `/bin/sh -c`，而 **Windows 上没有 `/bin/sh`** ⇒ `proxy_run` 在 Windows 上不可用。
 *   DSH 自己按平台挑执行器（POSIX→bash、Windows→pwsh），接口是
 *   `ctx.shell.resolve(request)` → `ctx.shell.execute(spec)` → `.result()`；
 *   `ShellExecRequest.env` 正好用来注入代理环境变量 —— 我们只管塞 env，平台差异交给它。
 *
 * ★ 接缝失败**绝不能**把原本能跑的 POSIX 路径弄坏 ⇒ 出错就记下原因、走 `spawnSync('/bin/sh')` 回退，
 *   并在返回值里带 `shellFallbackReason`（这样"新接缝有没有真的生效"一眼可见）。
 */
export async function execInShell(command, env, opts = {}, shell = null) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 600000;
  const stdoutMaxBytes = Number(opts.stdoutMaxBytes) > 0 ? Number(opts.stdoutMaxBytes) : (8 << 20);
  let shellFailure = null;

  if (shell && typeof shell.execute === 'function') {
    try {
      const request = {
        command,
        timeoutMs,
        onExpiry: 'kill',
        stdoutMaxBytes,
        env,
        /*
         * ★ 显式请求"不隔离"（2026-10-09 用户 Windows 实测逼出来的修复）
         *
         * 症状：Windows 上 `proxy_run` 只能跑明文 HTTP；任何 HTTPS 都报
         *   `curl: (35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`
         *   而且 `--noproxy "*"` 绕过代理后**照样失败**、同一个 curl.exe 在普通 pwsh 里却正常
         *   ⇒ 与代理无关，是**接缝进程的沙箱上下文**问题。
         *
         * 根因：profile 挂在 `ctx.shell` 后面的是**沙箱执行器**（`bash-sandbox` / `pwsh-sandbox`）；
         *   不指定策略时 `resolve()` 会采用 `ctx.sandboxPolicy.resolve()`（取决于会话策略），
         *   受限模式在 Windows 上走 **ACL 受限令牌**（每个会话一个随机 SID + 私有临时目录）
         *   ⇒ Schannel/SSPI 在该令牌下取不到用户凭证 ⇒ TLS 全废。
         *   而 `dsh-pwsh-sandbox` 的文档写明：`danger-full-access` =「**不作限制；绝不咨询提供方**」。
         *
         * 为什么这里要 full-access 是合理的：本插件的活就是"把用户/agent 给的这条命令跑起来"，
         *   与 `bash` 工具同级；而且**改动之前它就是 `spawnSync('/bin/sh')` 完全不隔离**——
         *   显式声明只是把既有语义写清楚，顺带让行为不再随会话策略漂移。
         *   不想这样的话把 opts.sandboxMode 传成别的模式即可。
         */
        sandboxPolicy: {
          mode: opts.sandboxMode || 'danger-full-access',
          workspaceRoot: opts.workdir || process.cwd(),
        },
        ...(opts.workdir ? { workdir: opts.workdir } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      };
      const spec = typeof shell.resolve === 'function' ? shell.resolve(request) : request;
      const handle = await shell.execute(spec);
      const r = typeof handle?.result === 'function' ? await handle.result() : handle;
      const textOf = (o) => (o && typeof o === 'object' && typeof o.text === 'string' ? o.text : (typeof o === 'string' ? o : ''));
      return {
        exitCode: r && r.exitCode !== null && r.exitCode !== undefined ? r.exitCode : 1,
        stdout: textOf(r && r.stdout),
        stderr: textOf(r && r.stderr),
        timedOut: !!(r && r.timedOut),
        via: 'shell',
      };
    } catch (e) {
      shellFailure = String((e && e.message) || e).slice(0, 200);
    }
  }

  if (process.platform === 'win32') {
    return {
      exitCode: null, stdout: '', stderr: '', via: 'none',
      error: 'Windows 上拿不到 DSH 的 shell 接缝（ctx.shell），无法执行命令。'
        + `可临时用系统 curl 并自带代理：set HTTPS_PROXY=http://127.0.0.1:${(opts.mixedPort || 17890)} && curl <url>`
        + (shellFailure ? `（接缝报错：${shellFailure}）` : '（ctx.shell 未挂载）'),
    };
  }
  const r = spawnSync('/bin/sh', ['-c', command], { env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 << 20 });
  return {
    exitCode: r.status, stdout: (r.stdout || ''), stderr: (r.stderr || ''), via: 'sh',
    ...(shellFailure ? { shellFallbackReason: shellFailure } : {}),
  };
}

/**
 * 一条命令搞定：起 → 跑 → 立刻停（本来就开着则借用、不关）。
 *
 * ★ 刻意**不做**自动判断（2026-10-08 用户定案："一切交给用户，系统别做那么多判断"）：
 *   · 不测速、不自动换节点、不因为失败就重跑命令、也不自作主张改走直连；
 *   · 用哪个节点 = 用户在设置页选的那个（没选过就是列表第一个）；
 *   · 命令失败就如实交给调用方（要不要重试由 agent/用户决定 —— 自动重跑有副作用风险，
 *     比如 git push 会被跑两遍）。
 */
export async function runWithProxy(command, cfg = {}, opts = {}) {
  const t0 = Date.now();
  const wasRunning = (await status(cfg)).running;
  let startedHere = false;
  let prepared = [];
  let selected = getSelectedNode(cfg);
  if (!wasRunning) { const s = await start(cfg); prepared = s.prepared || []; selected = s.selected ?? selected; startedHere = true; }

  // 「没选过节点」不是错误，但要**说出来**：否则调用方只看到 node:null，不知道实际走了哪个节点。
  // （插件不会自动测速也不会自动换节点 —— 见本节顶部注释。）
  let nodeInfo;
  if (selected) {
    nodeInfo = { node: selected };
  } else {
    let first = null;
    try { first = (await listNodes(cfg)).all[0] || null; } catch { /* 没订阅就算了 */ }
    nodeInfo = {
      node: null,
      nodeNote: (first
        ? `尚未选用节点：本次走的是订阅列表第一个（${first}）`
        : '尚未选用节点，也没有订阅节点')
        + '。可在「设置 → 按需代理」点 ⚡ 测速后点「选用」把它固定下来。',
    };
  }

  const proxyUrl = `http://127.0.0.1:${cfg.mixedPort || 17890}`;
  const env = {
    ...process.env,
    https_proxy: proxyUrl, http_proxy: proxyUrl, all_proxy: proxyUrl,
    HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, ALL_PROXY: proxyUrl,
    no_proxy: '127.0.0.1,localhost,::1', NO_PROXY: '127.0.0.1,localhost,::1',
  };
  try {
    // 优先 DSH 的 shell 接缝（平台无关），拿不到才回退 POSIX /bin/sh
    const r = await execInShell(command, env, { ...opts, mixedPort: cfg.mixedPort || 17890 }, opts.shell);
    // 记一条使用日志（热路径只多这一次小追加；失败不影响功能）
    const cmdRaw = String(command);
    const cmd = cmdRaw.length > 512 ? cmdRaw.slice(0, 512) + '…' : cmdRaw;
    // ★ host 提取：见 extractHosts() 的注释（修报告 §7.1 的尾随分号 + §7.2 的多目标）
    const hosts = extractHosts(cmdRaw);
    logUsage(cfg, {
      kind: 'run',
      by: opts.by || 'tool',
      session: opts.session || null, cwd: opts.sessionCwd || null, origin: opts.sessionOrigin || null,
      cmd,
      ...(cmdRaw.length > 512 ? { cmdTruncated: true } : {}),
      host: hosts[0] || null,
      ...(hosts.length > 1 ? { hosts } : {}),
      node: selected || null,
      ms: Date.now() - t0,            // 本次占用代理的总时长（起→跑→停）
      ok: r.exitCode === 0, exitCode: r.exitCode, via: r.via, startedHere,
    });
    return {
      ok: r.exitCode === 0, exitCode: r.exitCode,
      stdout: (r.stdout || '').slice(0, 20000), stderr: (r.stderr || '').slice(0, 4000),
      startedHere, stoppedAfter: startedHere,
      via: r.via,                      // 'shell' = 走了 DSH 接缝；'sh' = 回退；'none' = 两边都没有
      ...(r.timedOut ? { timedOut: true } : {}),
      ...(r.shellFallbackReason ? { shellFallbackReason: r.shellFallbackReason } : {}),
      ...(r.error ? { error: r.error } : {}),
      ...nodeInfo,                     // node=用户选定的；没选过则 node:null + nodeNote 说明实际走哪个
      ...(prepared.length ? { prepared } : {}),
    };
  } finally {
    if (startedHere && opts.keep !== true) await stop(cfg);
  }
}

/** 内核可用性验证：跑 `mihomo -v`（能拦住 EACCES 这类"装上了但跑不了"） */
export function verifyCore(bin) {
  if (!fs.existsSync(bin)) return { ok: false, error: '文件不存在' };
  const r = spawnSync(bin, ['-v'], { encoding: 'utf8', timeout: 20000 });
  if (r.error) return { ok: false, error: String(r.error.message || r.error) };
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (r.status === 0 && /mihomo|clash/i.test(out)) return { ok: true, version: out.split('\n')[0].slice(0, 120) };
  return { ok: false, error: out.slice(0, 200) || `exit ${r.status}` };
}

/** 预编译内核的候选地址：国内加速镜像优先，直连 GitHub 兜底 */
export function coreUrls(cfg = {}) {
  if (Array.isArray(cfg.coreUrls) && cfg.coreUrls.length) return cfg.coreUrls;
  const base = (cfg.coreBaseUrl || 'https://github.com/fufay/dsh-proxyagent/releases/latest/download').replace(/\/$/, '');
  // 按**本机平台**挑资产（macOS / Windows / Linux-x86 用户各取各的；本机 openharmony 用 linux-arm64）
  const t = platformTarget();
  const asset = cfg.coreAsset || `mihomo-${t.os}-${t.arch}${t.ext}.gz`;
  const mirrors = [
    (u) => `https://ghproxy.net/${u}`,
    (u) => `https://gh-proxy.com/${u}`,
    (u) => `https://ghfast.top/${u}`,
    (u) => u,
  ];
  const direct = `${base}/${asset}`;
  // 若配置了 jsdelivr/CDN 通道（把 .gz 放到一个专门放二进制的仓库里），排在镜像之前
  const cdn = cfg.coreCdnUrl ? [() => String(cfg.coreCdnUrl)] : [];
  return [...cdn.map((m) => m(direct)), ...mirrors.map((m) => m(direct))];
}

const UA_CORE = 'dsh-proxyagent';

/**
 * 通道竞速：并发给每家发一个"只要头几个字节"的小请求，谁先**真正拿到数据**就用谁。
 *
 * 为什么必须竞速：原来按固定顺序**串行**试，只要第一家"慢而不死"（实测正是这种形态：
 * 连接活着、数据细水长流），后面再快的镜像也永远轮不到 —— 16.7 MB 就这样耗掉 461 秒。
 * 注意：只比 TTFB 不够，还要把那一小段读出来，才算"这条通道现在真的能给数据"。
 */
export async function probeChannels(urls, opts = {}) {
  const timeoutMs = opts.timeoutMs || 8000;
  const probeBytes = opts.probeBytes || 16384;
  // 拿到第一个能用的通道后再宽限 graceMs 等更快的；之后不再等死通道
  // （否则 github.com 直连这种"必然超时"的通道会把每次探测都拖满 probeTimeout）
  const graceMs = opts.graceMs === undefined ? 400 : opts.graceMs;
  const out = [];
  let firstOkAt = 0;
  let stopped = false;
  const controllers = urls.map(() => new AbortController());

  const stopWaiting = () => {
    stopped = true;
    for (const ac of controllers) { try { ac.abort(); } catch { /* ignore */ } }
  };

  const settled = Promise.all(urls.map(async (url, i) => {
    const host = url.replace(/^https?:\/\//, '').split('/')[0];
    const t0 = Date.now();
    const ac = controllers[i];
    const timer = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } }, timeoutMs);
    try {
      const r = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': UA_CORE, range: `bytes=0-${probeBytes - 1}` },
        signal: ac.signal,
      });
      if (!r.ok && r.status !== 206) { out.push({ url, host, ok: false, error: `HTTP ${r.status}` }); return; }
      const head = Buffer.from(await r.arrayBuffer());
      if (!head.length) { out.push({ url, host, ok: false, error: '空响应' }); return; }
      const cr = r.headers.get('content-range') || '';
      const total = Number((cr.split('/')[1]) || r.headers.get('content-length') || 0) || 0;
      out.push({ url, host, ok: true, ms: Date.now() - t0, rangeOK: r.status === 206, total });
      if (!firstOkAt) {
        firstOkAt = Date.now();
        setTimeout(stopWaiting, graceMs);   // 宽限期内别人若能更快就让它赢
      }
    } catch (e) {
      // 区分"真的不通"与"我们不等它了"（后者不是故障，别写进报告误导人）
      out.push({ url, host, ok: false, error: stopped ? '跳过（已有更快的通道）' : String((e && e.message) || e).slice(0, 80) });
    } finally {
      clearTimeout(timer);
    }
  }));

  // 有通道可用就不等死通道；全军覆没时才等到自然结束
  const waiter = new Promise((resolve) => {
    const iv = setInterval(() => {
      if (firstOkAt && Date.now() - firstOkAt >= graceMs) { clearInterval(iv); resolve(); }
    }, 60);
    settled.then(() => { clearInterval(iv); resolve(); });
  });
  await waiter;
  out.sort((a, b) => (a.ok === b.ok ? (a.ms || 0) - (b.ms || 0) : (a.ok ? -1 : 1)));
  return out;
}

/** 分段并发下载（服务器支持 Range 时用；任一段失败就抛，交给调用方退回单流） */
async function fetchChunked(url, total, parts, timeoutMs) {
  const size = Math.ceil(total / parts);
  const bufs = await Promise.all(Array.from({ length: parts }, async (_, i) => {
    const from = i * size;
    const to = Math.min(total, from + size) - 1;
    if (from >= total) return Buffer.alloc(0);
    const r = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': UA_CORE, range: `bytes=${from}-${to}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.status !== 206) throw new Error(`分段 ${i} 未返回 206（HTTP ${r.status}）`);
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length !== to - from + 1) throw new Error(`分段 ${i} 长度不符（${b.length} ≠ ${to - from + 1}）`);
    return b;
  }));
  return Buffer.concat(bufs);
}

/** 取预编译内核（纯 HTTP + zlib 解压，**不需要任何工具链**） */
export async function downloadCore(cfg = {}) {
  const t0 = Date.now();
  const p = paths(cfg);
  await fsp.mkdir(path.dirname(p.bin), { recursive: true });
  const tried = [];
  // 整体时限：16.7 MB 实测最快通道 ~18s；给足 15 分钟，但**必须有上限**
  const DL_TIMEOUT_MS = Number(cfg.downloadTimeoutMs) > 0 ? Number(cfg.downloadTimeoutMs) : 900000;
  const all = coreUrls(cfg);

  // ① 竞速挑出"现在真的快"的通道；探测失败的排到最后（仍给一次机会）
  const probed = await probeChannels(all, { timeoutMs: Number(cfg.probeTimeoutMs) > 0 ? Number(cfg.probeTimeoutMs) : 8000 });
  const order = [...probed.filter((x) => x.ok).map((x) => x.url), ...all.filter((u) => !probed.some((x) => x.url === u && x.ok))];
  const probeInfo = probed.map((x) => `${x.host}: ${x.ok ? `通 ${x.ms}ms${x.rangeOK ? ' 支持分段' : ''}` : `不通(${x.error})`}`);

  for (const url of order) {
    const host = url.replace(/^https?:\/\//, '').split('/')[0];
    const meta = probed.find((x) => x.url === url) || {};
    try {
      let buf;
      // ② 支持 Range 且文件够大 ⇒ 分 4 段并发（实测单流 ~985 KB/s ⇒ 并发可再快数倍）
      const parts = Number(cfg.downloadParts) >= 0 ? Number(cfg.downloadParts) : 4;
      if (meta.rangeOK && meta.total > 4_000_000 && parts > 1) {
        try {
          buf = await fetchChunked(url, meta.total, parts, DL_TIMEOUT_MS);
        } catch (e) {
          tried.push(`${host}: 分段下载失败(${String(e.message).slice(0, 60)}) ⇒ 退回单流`);
          buf = null;
        }
      }
      if (!buf) {
        const r = await fetch(url, {
          redirect: 'follow', headers: { 'user-agent': UA_CORE },
          signal: AbortSignal.timeout(DL_TIMEOUT_MS),
        });
        if (!r.ok) { tried.push(`${host}: HTTP ${r.status}`); continue; }
        buf = Buffer.from(await r.arrayBuffer());
      }
      let bin;
      if (buf[0] === 0x1f && buf[1] === 0x8b) {
        const { gunzipSync } = await import('node:zlib');
        try { bin = gunzipSync(buf); }              // gzip CRC 会校验完整性 ⇒ 分段拼错必炸
        catch (e) { tried.push(`${host}: 解压失败(${String(e.message).slice(0, 60)})`); continue; }
      } else {
        bin = buf; // 未压缩也接受
      }
      if (bin.length < 5_000_000) { tried.push(`${host}: 内容过小(${bin.length}B)`); continue; }
      await fsp.writeFile(p.bin, bin, { mode: 0o755 });
      await fsp.chmod(p.bin, 0o755).catch(() => {});
      const v = verifyCore(p.bin);
      if (v.ok) {
        return {
          ok: true, downloaded: true, from: host, sizeMB: +(bin.length / 1048576).toFixed(1),
          bin: p.bin, version: v.version, probe: probeInfo,
          elapsedMs: Date.now() - t0,     // t0 在函数开头取（原来是 cfg._t0，从没赋值过 ⇒ 恒为 0）
        };
      }
      tried.push(`${host}: 下载成功但无法执行(${v.error})`);
      await fsp.rm(p.bin, { force: true }).catch(() => {});
    } catch (e) {
      tried.push(`${host}: ${e?.message || e}`);
    }
  }
  return { ok: false, tried, probe: probeInfo };
}

/** 内置 mihomo：优先用本机 Go 经 goproxy.cn 镜像编译（不依赖 GitHub） */
export async function setupCore(cfg = {}) {
  const p = paths(cfg);
  fs.mkdirSync(path.dirname(p.bin), { recursive: true });
  if (fs.existsSync(p.bin)) {
    const v = verifyCore(p.bin);
    if (v.ok) return { ok: true, already: true, bin: p.bin, version: v.version };
    await fsp.rm(p.bin, { force: true }).catch(() => {});   // 存在但跑不了（如 EACCES）⇒ 换通道重取
  }

  // ① 预编译内核：多镜像下载 + 验跑（**不需要任何工具链**）
  if (cfg.allowDownload !== false) {
    const tCore = Date.now();
    const d = await downloadCore(cfg);
    if (d.ok) {
      logUsage(cfg, { kind: 'core', by: cfg.by || 'tool', session: cfg.session || null, from: d.from, sizeMB: d.sizeMB, ms: Date.now() - tCore });
      return d;
    }
    cfg = { ...cfg, _downloadTried: d.tried };
  }

  // ② 本机 Go 编译（平台完全匹配的兜底）
  const ver = cfg.mihomoVersion || 'v1.19.32';
  const go = findGo();
  if (!go) {
    const tried = Array.isArray(cfg._downloadTried) ? cfg._downloadTried.join('；') : '（未尝试或全部失败）';
    const t = platformTarget();
    throw new Error(
      `取内核失败：预编译下载通道都不通（本平台要的资产是 mihomo-${t.os}-${t.arch}${t.ext}.gz），且本机没有 Go 工具链。\n` +
      `  已尝试的下载通道：${tried}\n` +
      '  两种解决办法（任选其一）：\n' +
      '    a) 让网络能访问 GitHub 或其加速镜像后重试（本插件会竞速试 ghproxy.net / gh-proxy.com / ghfast.top / 直连）；\n' +
      '    b) 安装 Go 后重试（本插件会用 Go 经 goproxy.cn 源码编译，无需 GitHub）：\n' +
      '       macOS：brew install go    ｜    Windows：https://go.dev/dl/ 装完重开 DSH    ｜    或从 go.dev 下载对应版本'
    );
  }
  const env = {
    ...process.env,
    PATH: `${path.dirname(go)}${path.delimiter}${process.env.PATH || ''}`,
    GOFLAGS: '-mod=mod', GOPROXY: 'https://goproxy.cn,direct', GOSUMDB: 'sum.golang.google.cn',
    GOCACHE: p.gocache, GOMODCACHE: p.gomod, GOTOOLCHAIN: 'local', CGO_ENABLED: '0',
  };
  fs.mkdirSync(p.gocache, { recursive: true });
  fs.mkdirSync(p.gomod, { recursive: true });
  const dl = spawnSync(go, ['mod', 'download', `github.com/metacubex/mihomo@${ver}`], { env, encoding: 'utf8', timeout: 1200000 });
  const modSrc = findModuleSrc(p.gomod, `mihomo@${ver}`);
  if (!modSrc) throw new Error(`镜像未取到源码（${dl.stderr || ''}）`);
  const srcDir = path.join(p.dir, 'src', 'mihomo');
  fs.rmSync(srcDir, { recursive: true, force: true });
  fs.mkdirSync(srcDir, { recursive: true });
  // ★ 这里原来用 `/bin/sh -c "cp -r … / chmod -R u+w …"` —— Windows 上没有 /bin/sh，
  //   改用 Node 原生 fs（跨平台，且不依赖任何外部命令）
  fs.cpSync(modSrc, srcDir, { recursive: true, force: true });
  makeWritable(srcDir);
  const b = spawnSync(go, ['build', '-trimpath', '-ldflags', `-s -w -X "github.com/metacubex/mihomo/constant.Version=${ver}"`, '-o', p.bin, '.'], { cwd: srcDir, env, encoding: 'utf8', timeout: 3600000 });
  if (b.status !== 0 || !fs.existsSync(p.bin)) throw new Error(`编译失败：${(b.stderr || '').slice(0, 800)}`);
  try { fs.chmodSync(p.bin, 0o755); } catch { /* Windows 上 chmod 基本是 no-op，忽略 */ }
  const vb = verifyCore(p.bin);
  return { ok: vb.ok, built: true, bin: p.bin, sizeMB: +(fs.statSync(p.bin).size / 1048576).toFixed(1), version: vb.version, verifyError: vb.ok ? undefined : vb.error };
}

/** 递归补写权限（替代 `chmod -R u+w`；Windows 上静默跳过） */
function makeWritable(dir) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) makeWritable(full);
    try { fs.chmodSync(full, 0o644); } catch { /* Windows / 只读介质：忽略 */ }
  }
}

function findGo() {
  // 常见安装位置：本机（HarmonyOS brew）/ macOS（Apple Silicon + Intel）/ Windows
  const cands = [
    '/storage/Users/currentUser/.harmonybrew/opt/go/bin/go',
    '/opt/homebrew/bin/go',            // macOS Apple Silicon
    '/usr/local/bin/go',               // macOS Intel / Linux 手装
    '/usr/bin/go',
    'C:\\Program Files\\Go\\bin\\go.exe',
    'C:\\Go\\bin\\go.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Go', 'bin', 'go.exe') : null,
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* ignore */ } }
  // 兜底：交给 PATH（本机 go 在 $HOME/bin 垫片里；Windows 上 Node 会按 PATHEXT 找到 go.exe）
  try {
    const r = spawnSync('go', ['version'], { encoding: 'utf8', timeout: 15000 });
    if (r.status === 0 && /go version/i.test(String(r.stdout || ''))) return 'go';
  } catch { /* ignore */ }
  return null;
}

function findModuleSrc(gomod, dir) {
  const stack = [gomod];
  while (stack.length) {
    const d = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const full = path.join(d, e.name);
      if (e.name === dir) return full;
      stack.push(full);
    }
  }
  return null;
}

/** 用订阅里的规则表判断域名该走代理还是直连（Clash 语义：自上而下首条命中） */
export async function ruleQuery(hostOrUrl, cfg = {}) {
  const p = paths(cfg);
  let t;
  try {
    t = await fsp.readFile(p.config, 'utf8');
  } catch {
    return {
      ok: false,
      error: '还没有订阅配置，无法按规则表判定',
      nextStep: '在「设置 → 按需代理」填入订阅地址，再执行 proxy_fetch_subscription',
    };
  }
  const m = t.match(/^rules:[ \t]*\r?\n([\s\S]*?)(?=^[A-Za-z][\w-]*[ \t]*:|$(?![\s\S]))/m);
  const rules = (m ? m[1] : '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('-'))
    .map((l) => l.slice(1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')));
  let host = String(hostOrUrl).trim();
  const mm = host.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/);
  if (mm) host = mm[1];
  host = host.split('/')[0].split('?')[0].split('@').pop().toLowerCase().replace(/\.$/, '');

  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  // 需要"解析后的 IP / GeoIP 库"才能评估的规则：本插件没有 GeoIP 库（这正是运行配置里
  // 只用 MATCH,AUTO 的原因），遇到它们**不能假装命中**，只能跳过并如实记账。
  const skipped = new Set();

  for (const parts of rules) {
    if (parts.length < 2) continue;
    const type = (parts[0] || '').toUpperCase();
    const val = (parts[1] || '').toLowerCase();
    const pol = parts[parts.length - 1];
    if (type === 'DOMAIN' && host === val) return { host, verdict: 'matched', policy: pol, rule: `DOMAIN,${parts[1]}`, viaProxy: !/^DIRECT$/i.test(pol) };
    if (type === 'DOMAIN-SUFFIX' && (host === val || host.endsWith('.' + val))) return { host, verdict: 'matched', policy: pol, rule: `DOMAIN-SUFFIX,${parts[1]}`, viaProxy: !/^DIRECT$/i.test(pol) };
    if (type === 'DOMAIN-KEYWORD' && host.includes(val)) return { host, verdict: 'matched', policy: pol, rule: `DOMAIN-KEYWORD,${parts[1]}`, viaProxy: !/^DIRECT$/i.test(pol) };
    // ★ 修 bug：这里原来是 `return DIRECT`（无条件当成命中）。真实 Clash 里 GEOIP,CN 只对
    //   **解析到国内 IP** 的域名命中，境外域名不命中、继续往下走 MATCH。原写法把"没被显式
    //   规则覆盖的站点"一律报成已命中 DIRECT ⇒ 而纪律是"判直连就不走代理" ⇒ 会漏用代理。
    //   但我们也没有 GeoIP 库/DNS，**没法反过来断言"表说走代理"**，所以只能如实记"跳过"。
    if (type === 'GEOIP') { skipped.add(`GEOIP,${parts[1]}`); continue; }
    if (type === 'IP-CIDR' || type === 'IP-CIDR6') { skipped.add(type); continue; }
    if (type === 'MATCH') {
      const polDirect = /^DIRECT$/i.test(pol);
      // 没有任何"需要 IP 的规则"被跳过 ⇒ 结论是确定的，照规则表说
      if (!skipped.size) return { host, verdict: 'matched', policy: pol, rule: 'MATCH(兜底)', viaProxy: !polDirect };
      // 有跳过（GEOIP / IP-CIDR）⇒ 判定实际取决于解析后的 IP，这里给不出确定结论
      return {
        host,
        verdict: 'undetermined',
        policy: `待定（需 IP 才能定；规则表兜底是 ${pol}）`,
        rule: 'MATCH(兜底)',
        viaProxy: null,
        skippedRules: [...skipped],
        note: `本插件没有 GeoIP 库、也不做 DNS 解析，因此跳过了 ${[...skipped].join('、')} 这些需要"解析后 IP"才能评估的规则`
          + (isIp ? '；而且输入本身就是 IP 字面量，这些规则在真实 Clash 里本可命中 ⇒ 结论偏差可能较大。'
                  : '；若该域名解析到国内 IP，真实 Clash 会命中 GEOIP,CN 而走去直连。'),
        recommendation: '先直连试（国内站点走代理明显更慢，实测 gitee/ohpm 走代理会直接不通）；直连失败或超时，再用 proxy_run。',
      };
    }
  }
  return { host, verdict: 'unknown', policy: 'UNKNOWN', rule: '无命中', viaProxy: null, note: '规则表里没有 MATCH 兜底行 ⇒ 无法判定', recommendation: '先直连，失败再用 proxy_run' };
}
