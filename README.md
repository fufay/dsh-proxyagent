# dsh-proxyagent

**按需代理插件**：需要时自动走代理，**用完即停**；只服务当前 DSH 会话，**不影响本机其它软件**。

- 只监听 `127.0.0.1`（不建 VPN/tun、不改 DNS、不动系统代理）
- 按**订阅自带的规则表**判定域名该走代理还是直连（GitHub 系走代理，`.cn`/国内站点直连）
- 内置 mihomo 内核：首次使用时用你机器上的 Go 经 `goproxy.cn` 编译（**不依赖 GitHub**）
- 订阅与节点凭据只落本机数据目录（权限 0600），不上传、不入库

## 安装（DSH Desktop）

```sh
pnpm add github.com/<owner>/dsh-proxyagent
```

或：设置 → 插件 → 「安装插件」输入框里填 `github.com/<owner>/dsh-proxyagent`。
安装后**需要重启 DSHM 应用**才会挂载（重启前看不到该插件属正常）。

## 配置（设置 → 插件 → dsh-proxyagent）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `subscriptionUrl` | 空 | **必填**。订阅地址。服务商后台打开开关后通常**只有 10 分钟**可下载 |
| `mixedPort` | 17890 | 本地混合代理端口（HTTP+SOCKS，仅 127.0.0.1）|
| `ctlPort` | 19090 | 内核控制端口（仅 127.0.0.1）|
| `mihomoVersion` | v1.19.32 | 首次准备内核时编译的版本 |

## 使用（agent 会自动调，人也可以手动）

| 工具 | 作用 |
| --- | --- |
| `proxy_status` | 查状态（是否运行 / 内核与订阅是否就绪 / 规则条数）|
| `proxy_setup_core` | 首次准备内核（编译，约 5–20 分钟）|
| `proxy_fetch_subscription` | 取订阅（严格校验 `proxies:`；403 页面绝不会被当配置）|
| `proxy_rule_query` | 用规则表判断某域名该走代理还是直连 |
| `proxy_run` | **核心入口**：起代理 → 执行命令 → 立刻关闭 |
| `proxy_start` / `proxy_stop` | 手动启停（一般不需要）|

首次使用顺序：`proxy_setup_core` → `proxy_fetch_subscription` →（之后随时）`proxy_run`。

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
