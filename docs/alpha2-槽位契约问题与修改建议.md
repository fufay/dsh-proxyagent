# dsh-proxyagent × DSH 0.2.3（alpha 线）槽位契约问题与修改建议

> 记录时间：2026-11-24。对应插件版本：**0.4.6**（本仓 HEAD，尚未修改）。
> 结论先说：**插件有一个必改的阻塞项**——`lib/client.js` 把 `plugins.item`（list 槽）用 `key:` 注册；
> 真机控制台会抛 `Uncaught Error: list slot "plugins.item" requires options.id`，该入口永远注册不上。
> 这个问题**在 0.2.2-rc.5 上就已存在**（同一套校验代码），不是 alpha.2 引入的回归，只是此前排查
> 文件面板 HTTP 400 / 插件市场 403 时抓 ArkWeb console 才第一次被读到（alpha.2 真机验收，2026-11-24）。

---

## 一、现象与真机证据

Whale（端侧 DSH）换到 `0.2.3-alpha.2` 后，Web 前端 ArkWeb console 的 L4 持续出现：

```
Uncaught Error: list slot "plugins.item" requires options.id
```

- 出现时机：打开「插件」页（Plugins 页挂载 → 槽位被声明 → `slots.inject` 的回调在声明变更时重跑）。
- 后果：`plugins.item` 那一条注册失败（插件在 Plugins 页的卡片/页面没有内容），控制台每次开插件页都报一条。
- **不受影响**：`settings.section`（设置 → 按需代理）与 `plugins.row.config`（插件行的配置页）两处注册：
  它们的写法本来就是对的（list 用 `id`、keyed 用 `key`），不抛错。
- 宿主半边的 `proxy_*` 工具、CLI、订阅/内核逻辑均不受影响（与前端槽位无关）。

## 二、根因：alpha.2 / rc.5 的槽位必填校验

前端槽位系统的 `register()` 对槽位种类做必填校验（代码在 shell 资源 `dsh-web-frontend/dist/assets/index-*.js`，
rc.5 与 alpha.2 **两份实现的这段逐字相同**）：

```js
switch (spec.kind) {
  case "single": /* 不许重复注册 */ break;
  case "keyed": { if (e.key === void 0) throw new Error(`keyed slot "${name}" requires options.key`); ... }
  case "list":  { if (e.id  === void 0) throw new Error(`list slot "${name}" requires options.id`);  ... }
  case "hoc":   { /* 同时要 id + key */ }
  case "chain": { if (e.select === void 0) throw new Error(`chain slot "${name}" requires options.select`); }
}
```

而 **`plugins.item` 是 list 槽**（由 `dsh-client-ui-plugin-manager` 声明，
`children` 里写作 `"plugins.item": { kind: 'list', scope: 'root' }`；rc.5 同样如此）。
官方槽位契约（`packages/client/ui-plugin-manager/src/client/slot-contract.ts`）原文：

> key: `plugins.item`, kind: `list` …
> “One official plugin the Plugins page lists in its Official group after the official bundles:
> **`label` is the card's title and `order` its place.** …
> OCCUPIED by the official settings pages … a bundle's configuration belongs in
> `plugins.bundle.config` or `plugins.row.config` instead.”

本插件当前代码（`lib/client.js:514-520`）：

```js
// ① 插件卡片内（keyed 座位 ⇒ 给 key）
for (const seat of [
  { name: 'plugins.item', key: PKG },              // ← 错：list 槽必须给 id
  { name: 'plugins.row.config', key: ROW_CONFIG_KEY },  // ← 对：keyed 槽给 key
]) {
  registerSeat(ctx, { name: seat.name, key: seat.key, title: () => 'ProxyAgent' }, Panel);
  //                                 ^^^^^^^^^^^^ 循环又把 seat.key 塞回去，
  //                                 ⇒ 即使把数组里改成 id: PKG 也不会生效（2026-11-24 设备上的一次临时改法就栽在这）
}
```

### 为什么错误是「未捕获」而不是被 `registerSeat` 的 try/catch 吞掉

`slots.inject(name, cb)` 的实现（`dsh-client-ui-renderer/lib/client.js`）大致是：

```js
const changed = () => {
  try { reconcile(); }            // reconcile 里跑 ctx.effect(cb)，cb 内会 ctx.slots.register(...)
  catch (error) { ... queueMicrotask(() => { throw failure }); }   // ← 这里把错误抛到微任务，变成 uncaught
};
```

- 槽位**尚未声明**时（刚进入应用、还没开过插件页）`inject` 只是订阅；等「插件」页挂载时声明变更触发
  `changed()`，回调里 `register()` 抛错 → 被 renderer 包成 `queueMicrotask(throw)` ⇒
  **逃出我们 `registerSeat` 外层的 try/catch**，成为 `Uncaught Error`。
- 所以「把注册函数包 try/catch」只能防住同步阶段；真正要防的是**传错 options 形状**。

## 三、修改建议（按优先级）

### 必改①（二选一，推荐 A）

**方案 A —— 最小改动：改成 list 槽的合法形状（保留现有「插件页卡片」行为）**

```js
// ① 两个座位各自按自己的契约注册：
//    plugins.item 是 **list** 槽 ⇒ 必须给 id（可选 label 作为卡片标题、order 作为位置）
//    plugins.row.config 是 **keyed** 槽 ⇒ 给 key
registerSeat(ctx, { name: 'plugins.item', id: PKG, label: () => 'ProxyAgent', order: 100 }, Panel);
registerSeat(ctx, { name: 'plugins.row.config', key: ROW_CONFIG_KEY, title: () => 'ProxyAgent' }, Panel);
```

- `id` 用包名 `dsh-proxyagent` 即可（list 槽的 id 是“自己的槽键”，与别人冲突才会顶替别人；
  复用官方 id 才会替换官方项，此处不会）。
- `label` 建议给函数（渲染时现取，语言/文案可动态）；只给 `id` 不给 `label` 时卡片标题为空。
- alpha.2 与 rc.5 都是 list 槽 ⇒ 这一改动**两版都兼容**（不存在需要按版本分支的问题）。

**方案 B —— 更贴官方契约：删掉 `plugins.item`，只保留另外两处**

官方契约明说该座位属于「官方插件的设置页」，第三方 bundle 的配置应走
`plugins.bundle.config` / `plugins.row.config`。删掉后：Plugins 页不再出现一张内容来自本插件的卡片，
但「设置 → 按需代理」（`settings.section`）与插件行的「配置」（`plugins.row.config`）都还在，
用户可用的入口一个不少；同时彻底避免「占据官方组」的语义问题。

> 建议：**优先 A**（行为与 0.4.6 的设计意图一致、改动 3 行）；如果后续想跟官方契约完全对齐再走 B。

### 必改②：`registerSeat` 内部再兜一层（防御性，避免同类错误再变成 uncaught）

```js
function registerSeat(ctx, seat, component) {
  const doRegister = () => {
    try {
      return ctx.slots.register(seat, component);
    } catch (e) {
      // renderer 会把 inject 回调里的异常 queueMicrotask(throw) 成 uncaught；
      // 这里就地吞掉并打日志，避免一条注册失败污染整个 console（且不再中断同批其它注册）。
      console.warn('[dsh-proxyagent] ' + seat.name + ' 注册失败：' + (e && e.message || e));
      return () => {};
    }
  };
  try {
    if (typeof ctx.slots.inject === 'function') ctx.slots.inject(seat.name, doRegister);
    else doRegister();
  } catch (e) {
    console.warn('[dsh-proxyagent] ' + seat.name + ' 挂载失败', e && e.message || e);
  }
}
```

### 建议③：`settings.section` 的 `order: 25` 与官方项撞位

`lib/client.js:525` 用 `order: 25`（原意：紧跟「技能」17、「Agent 预设」20，排在「备份与迁移」60 之前）。
alpha.2 新增的官方「远程连接」也是 `order: 25`（`settings.section` id `remote-connection`）⇒ 两个节并列，
排序取决于注册顺序，导航里位置不稳定。建议改成 **26**（或在真机确认官方当前顺序后选一个空位）。

### 清理④：`package.json` 的 `dsh.client.inject` 里有一个不存在的模块名

```json
"inject": ["@deepseek-ai/dsh-client-ui-settings", "@deepseek-ai/dsh-client-ui-slots"]
```

`@deepseek-ai/dsh-client-ui-slots` **不是核心树里的 client 模块**（0.2.2-rc.5 / 0.2.3-alpha.2 的
`dist/core` 里都没有这个包；slots 服务由 `@deepseek-ai/dsh-client-ui-renderer` 提供）。
实测 loader 对未知 inject 是**静默忽略**（`for (const packageName of row.inject) { const dep = this.graphRows.get(packageName); if (dep !== undefined) … }`），
所以它既没造成加载失败，也没有任何作用。建议删掉；若要显式声明依赖 slots 服务，写
`@deepseek-ai/dsh-client-ui-renderer`。

### 建议⑤：宿主端点显式声明 `auth: 'required'`

`lib/index.js:113` 注册 `/api/dsh-proxyagent` prefix 路由时没有传 `auth`。alpha.2 起
`webServer.register` 的**默认 auth 变为 `required`**（0.2.2-rc.5 的 webserver 根本没有这一层），
所以现在该端点要求浏览器登录凭据——对本插件是**正确**行为（设置页同源 fetch 默认带 cookie；
且 Whale 现在 Host 绑局域网，这个端点绝不能被匿名访问）。但目前是“靠默认值”，建议显式写：

```js
sctx.webServer.register({
  kind: 'prefix',
  path: '/api/dsh-proxyagent',
  auth: 'required',              // ← 新增：显式依赖浏览器 cookie 栅栏
  handler: async (req, res) => { ... },
});
```

（handler 里已有的 Origin 同源校验保留，二者不冲突。**不要**改成 `anonymous`。）

## 四、改动后的验证清单（真机）

1. 重打包插件（`lib/client.js` 改动即生效，无需改 `cordis.patch.yml`）。
2. 重启应用 → 打开「插件」页 → ArkWeb console（`diag-web-console`）**不应再出现** `requires options.id`。
3. `设置 → 按需代理` 能打开、能读节点区/日志（GET `/api/dsh-proxyagent/nodes`、`/log` 返回 200）。
4. 插件页里本插件的行 → 「配置」能打开同一个面板（`plugins.row.config`）。
5. `proxy_status` / `proxy_run` 等工具仍正常（host 侧逻辑未改）。

## 五、备注：本次不改的部分

- `lib/index.js` 的 `ctx.inject(['webServer'], …)`、监视线程、CLI/工具逻辑与 alpha.2 无冲突。
- 宿主端点返回 JSON 的 CORS/CSRF 处理（Origin 同源校验）保持现状。
- `ROW_CONFIG_KEY = 'dsh-proxyagent#dsh-proxyagent'` 与官方 keyed 槽约定
  「`<package name>#<row id>`」一致（`cordis.patch.yml` 里行 id 就是 `dsh-proxyagent`），**不需要改**。

## 六、历史备注（避免重复踩坑）

2026-11-24 在真机上曾临时把数组里的 `{ name: 'plugins.item', key: PKG }` 改成 `id: PKG`，
但**没改下面循环里 `key: seat.key` 的传参**，所以错误照旧出现——设备端备份文件
`lib/client.js.bak-dshm-20261124` 记录的就是那次半成品改动，**本仓库未做任何修改**（以本文件为准）。
