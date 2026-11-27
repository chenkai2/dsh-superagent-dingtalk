# Changelog

All notable changes to `@chenkai114/dsh-superagent-dingtalk`. This project publishes from a GitHub Release,
so a version here without a link is one whose release was superseded before publishing.

## 0.0.36 — 2026-11-27

### Fixed

- **取消工单后没有任何回音**：真机事故——人在群里派工单、worker 提问、人回「取消这个需求吧」，工单以 `dropped` 结束但群里一条消息都没有。
  引擎现在在 `dropped` 结束时补一条通知（起始会话、幂等、引 summary 首行、语言跟随请求），并收窄主会话的 `orchestrator_reply`
  描述：dropped 的结束已经说过，除非有实质不同的信息否则不要再发；worker 侧不再被要求做它没有能力做的事。

- **停机时在跑的工单没人管**：正常退出只走重启后的 `resume()`，停机路径没有处理，用户看到的是消息发出去了、没有下文。
  现在停机即把仍在跑的 assignment 标为中断，在工单起始会话回一条通知（内容：被主机重启打断、本次没有产出、重启后自动继续、
  需要停止就回复「取消」），并对已提问的工单补发一次该问题（幂等，重启多次也只到人一次）。见 PR #2。
- **执行器读不到 profile 配置**：`worker-mcp` 用 `process.env.DSH_PROFILE_DIR` 取 profile，而守护进程托管的 host
  没有这个变量 —— 面板列得出 7 个 MCP、worker 一个都挂不上，还每次会话新增 7 条假错误。改用 `installedProfileDir()`
  （从包自身安装位置推断），与面板路由同一口径。
- **执行器提示词承诺它没有的 MCP 能力**：DSH 的 systemPrompt 同名段按「最近作用域」继承，profile 全局挂的 mcp-client 段
  被每个 Session 继承，而工具不落到 worker。现在在 worker 作用域遮蔽这些段（worker 自己挂上的不遮蔽），主会话不受影响。
- **挂载失败静默**：插件/MCP 挂不上只写日志。现在记入执行页，含原因、失败次数与相对时间；`command-missing` /
  `unavailable` / `refused` 三态区分「命令不在这台机器或 Host 的 PATH 上」「激活了但没有工具」「被拒」。
- **脱敏**：失败原因里的凭据（URL query/userinfo/fragment、`Authorization`、`--api-key`、`key=value`、JSON 形态）
  在写日志与上屏前统一替换，日志与面板同源。
- 文案插值 bug：`{{count}}` 写成 `{count}`，面板显示成「已过滤 {1} 个」。

## 0.0.35 — 2026-11-26

### Fixed

- 答案投给了线程上所有工单：上一版只放开了「歧义」闸，投递仍遍历每个跟帖工单。现在只投给提问的那一张，并补测试。

## 0.0.34 — 2026-11-26

### Fixed

- 未 @ 的回答到不了工单：线程上挂着多张工单时，未 @ 的人消息被判「有歧义」挂起交给评估，评估再忽略它。
  现在若线程上恰有一张工单在等你回答，消息直接投给它。

## 0.0.33 — 2026-11-26

### Fixed

- 启动/关闭窗口内到达的消息被永久丢弃：`source_not_installed` 被当作终态过滤。该 reason 是窗口不是判断，
  现在把消息交还 Source（`SourceNotReady`），轮询不推进游标、下次重投。

## 0.0.32 — 2026-11-26

### Fixed

- MCP 行存的是绝对命令路径，升级搬迁后指向不存在的文件，服务器静默起不来。设置列表现在标出「命令不存在」。

## 0.0.31 — 2026-11-26

### Changed

- 路由工具的描述明确：被 @ 的消息是请求，`ignore` 只用于未 @ 的消息。

## 0.0.30 — 2026-11-26

### Added

- 执行器能读别的会话：worker preset 带上会话查询工具（`session_search` / `session_trace` / `session_event_read`）。

## 0.0.29 — 2026-11-26

### Fixed

- 全选会把本插件自己挂进执行器（等于在 worker 里再起一个编排器、去锁同一个 stateDir）。现在从可选项过滤并说明原因。

## 0.0.28 — 2026-11-26

### Fixed

- 通过反向代理访问面板全部 403：管理路由把 Host 硬编码为回环地址。改为与宿主一致的同源判定
  （回环不看端口；有 Origin 时必须与所服务 Host 一致），认证在 handler 之前已完成。

## 0.0.23 — 2026-11-26

### Fixed

- 插件列表混进残留备份目录（`dsh-genui.bak-0.10.0` 等）。要求清单里的名字与目录名一致。

## 0.0.22 — 2026-11-26

### Fixed

- 两个空列表共用一句提示，MCP 那个说「先装插件」，而 MCP 来自 `cordis.patch.yml` 的 `mcp-client` 行。

## 0.0.21 — 2026-11-26

### Fixed

- 两个列表都是空的：宿主进程只导出 `DSH_HOME`、没有 `DSH_PROFILE_DIR`；扫描 `node_modules` 时跳过 `@scope/` 子包。

## 0.0.20 — 2026-11-26

### Changed

- 执行器的两个集成设置改成可选列表（带全选），插件显示版本与描述，MCP 显示传输与端点（不显示含 key 的查询串）。

## 0.0.19 — 2026-11-26

### Added

- 按名单把**整个插件**挂进执行器会话（不只是 MCP 配置）：插件自带 MCP、服务与后台工作，挂在哪个 ctx 就作用于哪个 ctx。

## 0.0.17 — 2026-11-26

### Added

- 「执行器可用的 MCP」：设置只存 serverName，传输与凭据留在 profile，公开包里没有地址。

### Fixed

- profile 组合文件解析失败时静默返回空列表，改为明确报错。

## 0.0.16 — 2026-11-26

### Fixed

- 讨论消息的「差点抵达」工单记在模型里（`TriggerDisposition.deferred`），便于判断归属。

## 0.0.15 — 2026-11-26

### Added

- 群可配置「每条 @ 新建工单」：`ScopeResult.fresh` 让被 @ 的消息成为独立请求，而不是并进已有工单。

## 0.0.14 — 2026-11-26

### Added

- 婉拒（`decline`）：明确不做某请求时，在提出请求的会话回一句理由，不需要工单，幂等只发一次。

## 0.0.11 — 2026-11-26

### Added

- 通道健康按能力解耦：`dws` 收、回帖机器人发，谁通了都不影响其它功能。

## 0.0.9 — 2026-11-26

### Fixed

- 不再要求手填 conversationId（群名自动刷新）；`choose` 字段在标签为空时不退化成手填输入框。

## 0.0.7 — 2026-11-26

### Fixed

- 后续轮次再次回复同一段文字被当作重复丢弃：回复 id 带上 attempt（assignment）标识。

## 0.0.4 — 2026-11-26

### Changed

- 群机器人只需 token（加签）。

## 0.0.2 — 2026-11-25

### Changed

- 改为 GitHub Release + OIDC 发布（Trusted Publishing），无需 token。