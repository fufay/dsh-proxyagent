# dsh-proxyagent

**DeepSeek Harness Desktop（DSH）的按需代理插件**：需要时自动走代理，**用完即停**；只服务当前 DSH 会话，**不影响本机其它软件**。

- 只监听 `127.0.0.1`（不建 VPN/tun、不改 DNS、不动系统代理）
- 按**订阅自带的规则表**判定域名该走代理还是直连（GitHub 系走代理，`.cn`/国内站点直连）
- 内核优先**按平台下载预编译版**（多镜像竞速，通常几秒）；取不到才用你机器上的 Go 经 `goproxy.cn` 编译（**不依赖 GitHub**）
- 订阅与节点凭据只落本机数据目录（权限 0600），不上传、不入库

## 平台支持

内核会按 `process.platform` + `process.arch` 自动挑对应资产：

| 平台 | 内核资产 | 设置页 / 测速 / 选节点 / 刷新订阅 | `proxy_run` |
| --- | --- | --- | --- |
| Linux arm64（含 HarmonyOS PC 移植版 DSHM） | `mihomo-linux-arm64.gz` | ✅ | ✅ |
| Linux x86_64 | `mihomo-linux-amd64.gz` | ✅ | ✅ |
| macOS Apple Silicon | `mihomo-darwin-arm64.gz` | ✅ | ✅ |
| macOS Intel | `mihomo-darwin-amd64.gz` | ✅ | ✅ |
| Windows x86_64 | `mihomo-windows-amd64.exe.gz` | ✅ | ✅（经 DSH 的 shell 接缝）|

- **macOS**：若提示"无法验证开发者"，执行 `xattr -d com.apple.quarantine <内核路径>` 即可。
- **Windows**：`proxy_run` 不再依赖 `/bin/sh` —— 命令交给 **DSH 自带的 shell 执行器**（POSIX 上是 `bash -c`、Windows 上是 `pwsh -c`）。
  若某个部署没有挂载该服务，会返回明确提示并给出 `curl` 兜底写法，而不是诡异的空失败。
  另外：命令请求的是**不隔离**模式执行（`sandboxPolicy.mode = danger-full-access`，与接入接缝前 `spawnSync` 的语义一致）——
  否则 Windows 的沙箱会走 **ACL 受限令牌**，Schannel 在该令牌下取不到用户凭证，**一切 HTTPS 都会以
  `SEC_E_NO_CREDENTIALS` 失败**（2026-10-09 实测踩到）。
- **验证程度**：**Linux arm64（HarmonyOS PC 移植版）、macOS（Apple Silicon）、Windows x86_64 均已实机跑通全流程**
  （含 Windows 上的 `proxy_run` + HTTPS）；Linux x86_64 / macOS Intel 为代码审计 + 交叉编译产物核对，欢迎反馈。

### 在 Windows 上写 `proxy_run` 命令的三个注意（实测踩过，都不是缺陷）

1. **用 `curl.exe`，不要写 `curl`** —— PowerShell 里 `curl` 是 `Invoke-WebRequest` 的别名，不认 `-sI` / `-sS` 这类参数，
   会报参数错误（看起来像代理失败，其实不是）。
2. **退出码看 `$LASTEXITCODE`，不是 `$?`** —— 后者是 PowerShell 的**布尔**（成功/失败），不是数字退出码。
   例：`proxy_run: cmd /c exit 3; echo "code=$LASTEXITCODE"` → `code=3`。
3. **`ok` / `exitCode` 反映命令的"最后一条语句"（shell 语义）** ——
   所以 `curl.exe -sI <url>; echo done` 即使 curl 失败也会返回 `exitCode: 0`（最后成功的是 `echo`）。
   POSIX 上同理（`false; echo hi` 也返回 0）。要拿到真实成败，就别在末尾追加恒成功的语句。

## 常见问题

**Q：怎么知道命令走了哪条执行通道？**
返回里的 **`via`** 字段：`"shell"` = 走了 DSH 的 shell 接缝（POSIX `bash` / Windows `pwsh`）、
`"sh"` = 回退到 POSIX `/bin/sh`（附 `shellFallbackReason`）、`"none"` = 两边都不可用（附 `error`）。

**Q：DSH 内置的 `web_fetch` / 网页搜索会走本插件的代理吗？**
不会。它们走的是 DSH 自己的出站策略（由**启动时的 `HTTPS_PROXY` 等环境变量**决定，见内核的 `dsh-http-proxy`），
与本插件的"只注入单条命令"是两套互不干涉的机制。要用代理抓网页，请让 agent 走 `proxy_run`：

```sh
proxy_run: curl -sL <url>          # 或 curl -x http://127.0.0.1:17890 <url>
```

（把 DSH 全局代理指到本插件也可以，但那会让 **所有** DSH 流量——包括 LLM 请求——都走代理，
且要求内核常驻，与"随起随用、用完即停"相悖，因此**不推荐**。）

## 安装（DeepSeek Harness Desktop）

```sh
pnpm add github.com/<owner>/dsh-proxyagent
```

或：设置 → 插件 → 「安装插件」输入框里填 `github.com/<owner>/dsh-proxyagent`。
装完看 **设置 → 按需代理** 有没有出现本插件：有就能直接用（部分版本支持热加载）；**没有的话重启一次应用**即可。

## 配置（**设置 → 按需代理**，也可从「设置 → 插件 → dsh-proxyagent」卡片进入）

两个入口都能改同一份配置：左侧导航的「按需代理」页，与插件卡片里的表单。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `subscriptionUrl` | 空 | **必填**。订阅地址。服务商后台打开开关后通常**只有 10 分钟**可下载 |
| `mixedPort` | 17890 | 本地混合代理端口（HTTP+SOCKS，仅 127.0.0.1）|
| `ctlPort` | 19090 | 内核控制端口（仅 127.0.0.1）|
| `mihomoVersion` | v1.19.32 | 下载不到预编译内核、需要本机 Go 编译时用的版本 |

### 节点：自己测、自己选

插件**不替你选节点**（不做自动测速、不自动换节点、失败也不自动重跑命令）：

1. 填订阅地址 → **点保存就自动拉一次**（也可随时点地址旁的「刷新」）；
2. 点「启动内核」；
3. 点「⚡」测单个节点，或「全部测速」一次测完（170 个节点约 20 秒）；
4. 点「选用」定下要用的节点 —— 会记住，之后 `proxy_run` 一直用它。

（内核只在需要时起、用完即停；设置页里的内核启停是给你手动测速用的。）

## 使用（agent 会自动调，人也可以手动）

**填好订阅地址就够了**：第一次真正用代理时，插件会自动补齐缺的东西
（取订阅 → 取内核），不需要手动先点两个工具。补齐进度会在 `proxy_run` 的返回里写明。

| 工具 | 作用 |
| --- | --- |
| `proxy_status` | 查状态（是否运行 / 就绪与否 / 规则条数 / 订阅已取回多久，未就绪时给 `nextStep`）|
| `proxy_run` | **核心入口**：起代理 → 执行命令 → 立刻关闭（缺订阅/内核会自动补齐）|
| `proxy_setup_core` | 单独准备内核（多通道竞速下载，实测 5–20s；无 Go 也可用）|
| `proxy_fetch_subscription` | 取订阅（严格校验 `proxies:`；403 页面绝不会被当配置）|
| `proxy_rule_query` | 用规则表判断某域名该走代理还是直连 |
| `proxy_start` / `proxy_stop` | 手动启停（一般不需要）|

首次使用：**在设置里填订阅地址 → 直接 `proxy_run`**（内部自动完成取订阅与取内核）。

## 卸载与本地数据（重要）

插件的数据（订阅文件、内核二进制、节点选用记录）放在**本机数据目录** `$DSH_HOME/proxyagent/`，
**不在插件包里** —— 所以**卸载插件不会删除它们**，重装后会沿用上一份订阅与选用记录
（初次使用时会觉得"我刚装怎么就有节点"，就是这个原因）。

想从零开始：**设置 → 按需代理 → 本机数据 →「清除本机数据…」**（可选保留内核，免得重新下载）。

> ⚠️ 订阅文件里含**节点口令**。公共/共享机器上卸载前建议先清除。
> ⚠️ 清掉订阅后需要重新从订阅地址拉取；若你的服务商有"后台开关后 N 分钟窗口"的限制，请在窗口内操作。

## 什么时候不该用

国内镜像与国内站点（npmmirror / goproxy.cn / ohpm / gitee / 百度 / 国内 CDN）、
搜索与网页抓取、本机与局域网地址 —— **直连即可**，走代理反而更慢甚至不通。
拿不准就先 `proxy_rule_query` 问一句。

## 安全边界

- 代理只通过**单条命令的环境变量**生效，不会写入任何系统配置
- 内核配置由订阅裁剪生成：`MATCH,AUTO`（本插件自身的流量全走代理），不含 `tun:`/`dns:`
- 订阅文件权限 0600，位于用户数据目录；请勿提交到任何仓库

## License

MIT（插件本体）。内核 mihomo 为 GPL-3.0，由用户机器本地编译，本插件不分发其二进制。
