// lib/core.js —— ProxyAgent 引擎（纯 JS，自包含，不依赖任何工作区路径）
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

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
    bin: path.join(d, 'bin', 'mihomo'),
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

/** 状态：{ running, pid, mixedPort, corePresent, subscriptionPresent, rules } */
export async function status(cfg = {}) {
  const p = paths(cfg);
  const mixed = cfg.mixedPort || 17890;
  const pid = readPid(p.pid);
  const running = (await portOpen(mixed)) || (alive(pid) && await portOpen(mixed));
  let rules = 0;
  try {
    const t = fs.readFileSync(p.config, 'utf8');
    const m = t.match(/^rules:[ \t]*\r?\n([\s\S]*?)(?=^[A-Za-z][\w-]*[ \t]*:|$(?![\s\S]))/m);
    if (m) rules = m[1].split('\n').filter((l) => l.trim().startsWith('-')).length;
  } catch { /* 未取订阅 */ }
  return {
    running: !!running,
    pid: alive(pid) ? pid : null,
    mixedPort: mixed,
    ctlPort: cfg.ctlPort || 19090,
    corePresent: fs.existsSync(p.bin),
    subscriptionPresent: fs.existsSync(p.config),
    rules,
    dir: p.dir,
  };
}

/** 取订阅（严格校验：必须出现 proxies: 才落盘） */
export async function fetchSubscription(url, cfg = {}) {
  if (!url) throw new Error('未配置订阅 URL（请在插件设置里填写 subscriptionUrl）');
  const p = paths(cfg);
  await fsp.mkdir(p.dir, { recursive: true });
  const UAS = ['mihomo/v1.19.32', 'ClashMetaForAndroid/2.11.6', 'clash'];
  let lastErr = '';
  for (const ua of UAS) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': ua }, redirect: 'follow' });
      const text = await r.text();
      if (r.status !== 200) { lastErr = `HTTP ${r.status}`; continue; }
      if (!/proxies:/.test(text)) { lastErr = '响应中没有 proxies:（可能是 403 页面）'; continue; }
      const n = (text.match(/^\s*-\s*\{?\s*name:/gm) || []).length;
      await fsp.writeFile(p.config, text, { mode: 0o600 });
      await fsp.chmod(p.config, 0o600).catch(() => {});
      return { ok: true, bytes: Buffer.byteLength(text), nodes: n, ua, file: p.config };
    } catch (e) { lastErr = String(e && e.message || e); }
  }
  throw new Error(`取订阅失败（${lastErr}）。若为 403：订阅通常只在后台开关打开后的 10 分钟窗口内可下载。`);
}

/** 由订阅生成"自包含最小运行配置"：只取 proxies + url-test 组 + MATCH 全走代理（不依赖 GeoIP） */
export async function generateRuntimeConfig(cfg = {}) {
  const p = paths(cfg);
  const src = await fsp.readFile(p.config, 'utf8');
  const m = src.match(/^proxies:[ \t]*\r?\n([\s\S]*?)(?=^[A-Za-z][\w-]*[ \t]*:|$(?![\s\S]))/m);
  if (!m) throw new Error('订阅文件里找不到 proxies: 段');
  const proxies = m[1].replace(/\s+$/, '');
  const names = [...proxies.matchAll(/^\s*-\s*\{?\s*name:\s*["']?([^"',}\n]+)/gm)].map((x) => x[1].trim());
  const q = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  const mixed = cfg.mixedPort || 17890;
  const ctl = cfg.ctlPort || 19090;
  const out = `# dsh-proxyagent 运行配置（自动生成，勿手改）
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
  - name: AUTO
    type: url-test
    url: https://www.gstatic.com/generate_204
    interval: 300
    tolerance: 50
    lazy: false
    proxies:
${names.map((n) => '      - ' + q(n)).join('\n')}
  - name: MANUAL
    type: select
    proxies:
      - AUTO
${names.map((n) => '      - ' + q(n)).join('\n')}

rules:
  - MATCH,AUTO
`;
  await fsp.writeFile(p.runtime, out, { mode: 0o600 });
  return { ok: true, nodes: names.length, file: p.runtime, mixedPort: mixed, ctlPort: ctl };
}

/** 启动内核（幂等） */
export async function start(cfg = {}) {
  const p = paths(cfg);
  const st = await status(cfg);
  if (st.running) return { ok: true, already: true, ...st };
  if (!fs.existsSync(p.bin)) throw new Error(`内核不存在：${p.bin}（请先执行 proxy_setup_core）`);
  if (!fs.existsSync(p.config)) throw new Error('还没有订阅配置（请先执行 proxy_fetch_subscription）');
  await generateRuntimeConfig(cfg);
  await fsp.mkdir(p.dir, { recursive: true });
  const out = fs.openSync(p.log, 'a');
  const child = spawn(p.bin, ['-d', p.dir, '-f', p.runtime], {
    detached: true, stdio: ['ignore', out, out], cwd: p.dir, env: { ...process.env },
  });
  child.unref();
  await fsp.writeFile(p.pid, String(child.pid), { mode: 0o600 });
  for (let i = 0; i < 40; i++) {
    if (await portOpen(cfg.mixedPort || 17890)) return { ok: true, started: true, pid: child.pid, ...(await status(cfg)) };
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`启动后 ${(40 * 0.3).toFixed(0)}s 内端口未就绪，看日志：${p.log}`);
}

/** 关闭内核 */
export async function stop(cfg = {}) {
  const p = paths(cfg);
  const pid = readPid(p.pid);
  if (pid && alive(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
    for (let i = 0; i < 20 && alive(pid); i++) await new Promise((r) => setTimeout(r, 250));
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
  }
  await fsp.rm(p.pid, { force: true }).catch(() => {});
  return { ok: true, running: await portOpen(cfg.mixedPort || 17890) };
}

/** 一条命令搞定：起 → 跑 → 立刻停（本来就开着则借用、不关） */
export async function runWithProxy(command, cfg = {}, opts = {}) {
  const wasRunning = (await status(cfg)).running;
  let startedHere = false;
  if (!wasRunning) { await start(cfg); startedHere = true; }
  const env = {
    ...process.env,
    https_proxy: `http://127.0.0.1:${cfg.mixedPort || 17890}`,
    http_proxy: `http://127.0.0.1:${cfg.mixedPort || 17890}`,
    all_proxy: `http://127.0.0.1:${cfg.mixedPort || 17890}`,
    HTTPS_PROXY: `http://127.0.0.1:${cfg.mixedPort || 17890}`,
    HTTP_PROXY: `http://127.0.0.1:${cfg.mixedPort || 17890}`,
    ALL_PROXY: `http://127.0.0.1:${cfg.mixedPort || 17890}`,
    no_proxy: '127.0.0.1,localhost,::1', NO_PROXY: '127.0.0.1,localhost,::1',
  };
  try {
    const r = spawnSync('/bin/sh', ['-c', command], { env, encoding: 'utf8', timeout: opts.timeoutMs || 600000, maxBuffer: 8 << 20 });
    return {
      ok: r.status === 0, exitCode: r.status,
      stdout: (r.stdout || '').slice(0, 20000), stderr: (r.stderr || '').slice(0, 4000),
      startedHere, stoppedAfter: startedHere,
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
  const asset = cfg.coreAsset || `mihomo-linux-arm64.gz`;
  const mirrors = [
    (u) => `https://ghproxy.net/${u}`,
    (u) => `https://gh-proxy.com/${u}`,
    (u) => `https://ghfast.top/${u}`,
    (u) => u,
  ];
  const direct = `${base}/${asset}`;
  return mirrors.map((m) => m(direct));
}

/** 取预编译内核（纯 HTTP + zlib 解压，**不需要任何工具链**） */
export async function downloadCore(cfg = {}) {
  const p = paths(cfg);
  await fsp.mkdir(path.dirname(p.bin), { recursive: true });
  const tried = [];
  for (const url of coreUrls(cfg)) {
    const host = url.replace(/^https?:\/\//, '').split('/')[0];
    try {
      const r = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'dsh-proxyagent' } });
      if (!r.ok) { tried.push(`${host}: HTTP ${r.status}`); continue; }
      const buf = Buffer.from(await r.arrayBuffer());
      let bin;
      if (buf[0] === 0x1f && buf[1] === 0x8b) {
        const { gunzipSync } = await import('node:zlib');
        bin = gunzipSync(buf);
      } else {
        bin = buf; // 未压缩也接受
      }
      if (bin.length < 5_000_000) { tried.push(`${host}: 内容过小(${bin.length}B)`); continue; }
      await fsp.writeFile(p.bin, bin, { mode: 0o755 });
      await fsp.chmod(p.bin, 0o755).catch(() => {});
      const v = verifyCore(p.bin);
      if (v.ok) return { ok: true, downloaded: true, from: host, sizeMB: +(bin.length / 1048576).toFixed(1), bin: p.bin, version: v.version };
      tried.push(`${host}: 下载成功但无法执行(${v.error})`);
      await fsp.rm(p.bin, { force: true }).catch(() => {});
    } catch (e) {
      tried.push(`${host}: ${e?.message || e}`);
    }
  }
  return { ok: false, tried };
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
    const d = await downloadCore(cfg);
    if (d.ok) return d;
    cfg = { ...cfg, _downloadTried: d.tried };
  }

  // ② 本机 Go 编译（平台完全匹配的兜底）
  const ver = cfg.mihomoVersion || 'v1.19.32';
  const go = findGo();
  if (!go) {
    const tried = Array.isArray(cfg._downloadTried) ? cfg._downloadTried.join('；') : '（未尝试或全部失败）';
    throw new Error(
      '取内核失败：预编译下载通道都不通，且本机没有 Go 工具链。\n' +
      `  已尝试的下载通道：${tried}\n` +
      '  两种解决办法（任选其一）：\n' +
      '    a) 让网络能访问 GitHub 或其加速镜像后重试（本插件会依次试 ghproxy.net / gh-proxy.com / ghfast.top / 直连）；\n' +
      '    b) 安装 Go 后重试（本插件会用 Go 经 goproxy.cn 源码编译，无需 GitHub）：\n' +
      '       有 brew：brew install go    ｜   或从 https://go.dev/dl/ 下载 arm64 版'
    );
  }
  const env = {
    ...process.env, PATH: `${path.dirname(go)}:${process.env.PATH || ''}`,
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
  spawnSync('/bin/sh', ['-c', `cp -r "${modSrc}/." "${srcDir}/"`], { encoding: 'utf8' });
  spawnSync('/bin/sh', ['-c', `chmod -R u+w "${srcDir}"`]);
  const b = spawnSync(go, ['build', '-trimpath', '-ldflags', `-s -w -X "github.com/metacubex/mihomo/constant.Version=${ver}"`, '-o', p.bin, '.'], { cwd: srcDir, env, encoding: 'utf8', timeout: 3600000 });
  if (b.status !== 0 || !fs.existsSync(p.bin)) throw new Error(`编译失败：${(b.stderr || '').slice(0, 800)}`);
  fs.chmodSync(p.bin, 0o755);
  const vb = verifyCore(p.bin);
  return { ok: vb.ok, built: true, bin: p.bin, sizeMB: +(fs.statSync(p.bin).size / 1048576).toFixed(1), version: vb.version, verifyError: vb.ok ? undefined : vb.error };
}

function findGo() {
  const cands = ['/storage/Users/currentUser/.harmonybrew/opt/go/bin/go', '/opt/homebrew/bin/go', '/usr/local/bin/go', '/usr/bin/go'];
  for (const c of cands) if (fs.existsSync(c)) return c;
  const w = spawnSync('/bin/sh', ['-c', 'command -v go'], { encoding: 'utf8' });
  const p = (w.stdout || '').trim();
  return p || null;
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
  const t = await fsp.readFile(p.config, 'utf8');
  const m = t.match(/^rules:[ \t]*\r?\n([\s\S]*?)(?=^[A-Za-z][\w-]*[ \t]*:|$(?![\s\S]))/m);
  const rules = (m ? m[1] : '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('-'))
    .map((l) => l.slice(1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')));
  let host = String(hostOrUrl).trim();
  const mm = host.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/);
  if (mm) host = mm[1];
  host = host.split('/')[0].split('?')[0].split('@').pop().toLowerCase().replace(/\.$/, '');
  for (const parts of rules) {
    if (parts.length < 2) continue;
    const type = (parts[0] || '').toUpperCase();
    const val = (parts[1] || '').toLowerCase();
    const pol = parts[parts.length - 1];
    if (type === 'DOMAIN' && host === val) return { host, policy: pol, rule: `DOMAIN,${parts[1]}`, viaProxy: !/^DIRECT$/i.test(pol) };
    if (type === 'DOMAIN-SUFFIX' && (host === val || host.endsWith('.' + val))) return { host, policy: pol, rule: `DOMAIN-SUFFIX,${parts[1]}`, viaProxy: !/^DIRECT$/i.test(pol) };
    if (type === 'DOMAIN-KEYWORD' && host.includes(val)) return { host, policy: pol, rule: `DOMAIN-KEYWORD,${parts[1]}`, viaProxy: !/^DIRECT$/i.test(pol) };
    if (type === 'GEOIP') return { host, policy: 'DIRECT', rule: `GEOIP,${parts[1]}`, viaProxy: false, note: '需 GeoIP 库，按国内直连推定' };
    if (type === 'MATCH') return { host, policy: pol, rule: 'MATCH(兜底)', viaProxy: !/^DIRECT$/i.test(pol) };
  }
  return { host, policy: 'UNKNOWN', rule: '无命中', viaProxy: false };
}
