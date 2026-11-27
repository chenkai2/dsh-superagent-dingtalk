# 009 — Project-scoped execution

Status: 设计稿 v2，待评审（2026-11-27）。v1 经设计评审退回：8 处事实错误、7 条阻断项，本稿按评审结论重写。
Related: [003-execution](003-execution.md), [006-deployment](006-deployment.md), [007-architecture](007-architecture.md)

## 问题

工单在 `executionRoot` 下新造一个目录当会话工作区，worker 起来后靠绝对路径自己找项目。

实测（2026-11-27）：

```
executor.directory = '' 时 executionRoot = <stateDir>/work；本机当前为 <work root>
工单目录 = <executionRoot>/<worktree_name>-<ticket id 前 12 位>   (dsh.ts:58)
例：<work root>/rename-join-button-93b99a661c8d   ← 实测空目录
```

后果只有一条是真实的、值得修的：**worker 不知道自己属于哪个项目**。昨夜一个「改按钮文案」的工单跑了 1508 个事件、翻遍 152 个仓库才确认文案不存在；如果它一开始就在 `portal.example.com` 里，几分钟就能得出同样结论。

⚠️ 更正一个常见误解：工作根里现在有 **168 个 checkout**（含 55 个 `.tap-wt-*` 隐藏目录、2 个 `dsh-superagent-dingtalk` 的 worktree），那是操作者自己的东西；工单造成的空目录只有 1 个。**本设计不承诺「让工作根变干净」**。

## 目标与非目标

目标：

- 工单在**正确项目的隔离工作树**里运行。
- 项目归属在派活时判定，且判定**可复盘**（依据由代码算出，不是模型自述）。
- 判不出来时，让「改错仓库」成为**物理上做不到**，而不是靠 worker 自觉。

非目标：

- 不在项目主目录里跑（会把 worker 的改动与操作者未提交的改动混在一起）。
- 不把 OpenViking 当「请求 → 路径」的判定源（它的代码仓库实体只有 3 个，工作根有 152 个仓库）。
- 不承诺工作根变干净（见上）。
- 工作树**不是安全边界**：它隔离工作树、index、HEAD；`stash`、`refs`、`config`、`gc` 是同一仓库共享的（与 [003](003-execution.md) 的口径一致）。

## 设计

### 1. 项目索引：只产事实，用一次 git 调用

```
<stateDir>/projects.json
{ "generatedAt": "…", "root": "<work root>", "skipped": [{ "path": "…", "why": "…" }],
  "projects": [{ "name": "portal.example.com", "path": "…", "commonDir": "…/.git", "remote": "…", "head": "…", "committedAt": "…" }] }
```

- **一次调用取全部事实**：`git -C <dir> rev-parse --git-common-dir --abbrev-ref HEAD HEAD`（实测一层 153 个仓库：4 次调用 14.2 s，压成 1 次 2.6 s）。
- **必须支持 `.git` 文件**（本机有 2 个：worktree 形式）。bare 仓库**不收录**（没有工作区，无法 checkout）。
- **按 `commonDir` 去重**：同一仓库的多个 worktree 只能出一条索引项，否则 `indexed` 判定会常态性歧义。子模块（本机 6 个 `.gitmodules`）的 `.git` 也是文件，按 commonDir 归并后跳过。
- **别名表独立、可编辑（已定）**：`<stateDir>/projects-aliases.json`，形如
  ```json
  { "趋势互动": "portal.example.com", "购物车": "shop.example.com" }
  ```
  扫描只产事实，别名只产 hint，二者合并成 `projects.json`。放在 stateDir 的理由：可 review、可 diff、可随备份迁移、不随重新扫描丢失；命中别名只给 `indexed` 级依据，多条命中仍必须留空。
- **启动不阻塞**：索引在后台生成，`ready` 不等它；面板显示「索引生成中 / 上次生成时间 / 跳过的条目」。首次使用时若索引缺失，判定直接留空（见 §3），不现场扫。
- **面板不要比「项目数 vs 目录数」**：本机 153 gitdir + 2 gitfile + 37 非 git + 55 隐藏项，没有唯一的「实际数」。改为展示 `skipped` 明细与「与上次快照的差异」。

### 2. 工单记录项目（字段可选）

```ts
interface Ticket {
  /** The project this ticket works in: the repository the Executor's work root holds, and how code resolved it. */
  project?: { name: string; path: string; commonDir: string; remote?: string; basis: 'named' | 'indexed' | 'alias' }
  /** Set when a person said the project was wrong: what it was, what they said instead, and which message said it. */
  projectCorrection?: { from: string; to: string; by: string; at: string }
}
```

- `Execution` **不加字段**（`Execution = { name, directory, assignment }` 保持不变，`dsh.ts` 构造点无需改形状）。
- 可选：旧库行读作 `undefined`，行为与今天一致。`SCHEMA_VERSION` **不动**；将来若为面板按 project 过滤加生成列，走 `store.addColumns`，仍然不动 `SCHEMA_VERSION`。

### 3. 判定：代码解析，模型只给名字

`orchestrator_route` 的 accept 与 `orchestrator_eval_decide` 的 accept 各加一个可选 `project: string`（项目名或别名，**不是路径**）。

**`basis` 由代码算，不接受模型自述。** 理由是本仓已有的原则（`main.ts:133-135`）：模型判断不能替代「关于消息的事实」。判定顺序：

1. 模型给了 `project`，索引里能解析 → `named`（消息原文确实包含该名字/别名时）或 `indexed`（解析到但与原文措辞无关）。
2. 模型没给 → `alias` 表在请求原文里唯一命中 → `alias`。
3. 解析不到 / 多条命中 → **留空**，不猜。

留空时走 §4 的中立目录：worker 与今天一样自己找项目，**但拿不到项目工作树**，于是「改错仓库」无从发生。

新增只读工具 `orchestrator_projects`（读索引，按关键词过滤，返回 name/path/remote/commonDir/命中原因/别名），让主 Session 有据可依。

### 4. 有项目：隔离工作树；无项目：中立目录

有 `project`：

```
git -C <project.path> worktree add --detach <stateDir>/worktrees/<execution.name> <project.head>
```

- 目录在 `<stateDir>/worktrees/`，**不进工作根**。
- `--detach` 的真正理由是**硬约束**：分支若已在主工作区检出，非 detach 直接失败（实测 `fatal: 'master' 已经被工作区使用`）。
- **分支↔MR 绑定是契约**：PR 归属只认「分支末段 === `ticket.execution.name`」（`github-pull.ts:26-28`）。所以 worker 开工第一步必须

  ```
  git switch -c agent/$DSH_SUPERAGENT_NAME
  ```

  这句话要同时出现在 worker prompt（`prompts/`）与 per-ticket assignment 里。理由：`docs/003` 明写「ready 但没有 PR 时工单结束为 completed」——worker 忘了建分支还报 ready，工单会**静默判完成**，提交只留在 detached worktree 里。

无 `project`（含所有旧工单）：目录 = `<stateDir>/worktrees/<execution.name>`，空目录，行为与今天等价（除了不再落在工作根）。

**失败不回退**：工作树建不出来（路径已被注册但无效、分支不存在、磁盘满）→ 工单 `failed` 并在会话里说明原因。不退回空目录。

### 5. 工作树的生命周期（v1 完全缺失）

- **创建前自愈**：同路径已注册但无效（目录被手工删过）→ `git worktree prune` 实测**不认**这种残留，所以要显式 `git worktree remove --force <path>` 后再 add。
- **清理 owner 与时机**（工单结束时）：
  - 无 open PR → `git worktree remove --force <path>` 后 `git -C <project> worktree prune`；
  - 有 open PR → 保留，等到 merged/closed 再清（`docs/003` 的 PR 终态通知处顺带清）。
- **失败路径不要用 `rmdir`**：现在 `prepareDirectory` 的清理是 `rmdir`（`dsh.ts:270`），对已 checkout 的目录必然失败，会留下「半成品目录 + 无效注册」。改成 `worktree remove --force`，并保证 `.git/worktrees/<name>` 注册一起消失。
- **重试**：同路径 add 必撞 `already exists`（实测）。重试路径要先走上面的自愈。

### 6. prepare 契约变更（必须写进 003）

`prepare` 在 `dirname(directory)` 里跑（`dsh.ts:262,267`），`docs/003:53` 写的是「in the execution root」。目录根迁走后 cwd 变成 `<stateDir>/worktrees`——**这是无声的契约变更**，必须改 003 并在升级说明里点名。本机两台部署 `prepare` 都为空，短期不炸，但别人的部署可能在用。

新变量（`execution-environment.ts` 的变量表）：

```
DSH_SUPERAGENT_PROJECT       项目名（无项目为空串）
DSH_SUPERAGENT_PROJECT_PATH  项目绝对路径（无项目为空串）
```

顺序：建工作树（有项目时）→ 跑 `prepare` → **身份校验** → 启动。

**身份校验替换「目录存在即已准备」**（`dsh.ts:481-482` 现在只 `stat`，且跳过 `verifyDirectory`）：要求 `git -C <dir> rev-parse --show-toplevel` 等于期望路径、`--git-common-dir` 等于项目的 commonDir；不符则走 §5 的自愈或 failed。对 worktree 来说「目录存在」不等于「这是本工单该用的工作树」。

（正向：`verifyDirectory` 已处理 `worktree` scope，`environment.ts:155`；本机 153 个仓库的 `credential.*`/`http.*extraheader` 命中 0，这道门禁短期不会误杀。）

### 7. 判错怎么办，以及纠正必须被记住

`basis` 由代码算之后，「模型猜错」已被排除；剩下的是「原文提到了 A，但请求真正想做的是 B」。这类只能靠人。

- worker 的 assignment 文本（构造于 `dsh.ts:98-112`，1500 字符上限）：写项目名、工作树路径，以及一条**物理约束**而不是叮嘱：「你没有项目主目录的写权限路径，改动只能落在本工作树，并经由 `agent/<name>` 分支提 PR」。
- 详细的「开工前确认归属」写进 worker prompt，不占 assignment 预算。
- **不做** accept 前的确认门（会改动 `tickets.create → executor.start` 的现状，代价大于收益）。判错的处置是：人看到 `inferred`/`indexed` 标记与项目名不对，**取消工单重开**（取消现在已有回音，见 PR #3）。

### 7.1 人纠正了，就记下来（否则下次还错）

判错之后人会在工单会话里说一句「这不是 A 项目，是 B」。这句话不能只影响当下这一张工单——**它必须让同类请求下次直接判对**。

触发与处理：

1. 工单是 open 的，且来了一条**人**的消息（`trigger.human`，机器人不算），消息里点出另一个项目名 → 主 Session 用 `orchestrator_projects` 解析，解析到唯一项目即视为纠正。
2. 新增引擎命令 `ticket_project_correct({ ticket_id, project, trigger_id })`：
   - 记录 `ticket.projectCorrection = { from, to, by: trigger_id, at }`，并把 `ticket.project` 改成纠正后的项目（**历史不覆盖**，`from` 留在记录里）；
   - 立即停止当前 assignment（人在纠正的那一刻，错误项目上的改动必须停下），工单按 `dropped` 结束并附原因「项目判定有误，已按 B 纠正」——复用 PR #3 的结束通知，所以这一步外面看得见；
   - 在会话里回一句：已改记为 `<B>`，本次已停止，要接着做就再发一次（现在会直接用 B）。
3. **写入别名表**（这是“记住”的落点）：`<stateDir>/projects-aliases.json` 追加一条带来源的记录

   ```json
   { "趋势互动": { "project": "portal.example.com", "source": "human-correction",
                   "by": "<staffId>", "ticket": "<ticket id>", "at": "2026-11-27T…" } }
   ```

   与手工维护的字符串形式共存（读取时两种都接受）。来源只记 `human-correction`，**不接受模型自述**——与 §3 同一条原则。
4. **冲突**：同一别名已有条目时以最新一条为准，但把旧条目移进 `history` 数组，不直接抹掉（判错如果反复发生，要看得到规律）。
5. **幂等**：同一 `trigger_id` 只记一次；重复调用返回既有结果。

不做的事：

- **不自动重开工单**。纠正已经让「错误项目上的改动」停下，是否继续由人决定（再发一句即可，别名已生效）。自动重开会在「人其实不想继续」时又派一次活。
- **不改已存在的 worker session 的目录**（物理上换不了，见「已知边界」）。

### 8. 面板

- 工单卡片显示项目名与 `basis`。
- 执行页：索引 `generatedAt`、项目数、`skipped` 明细、与上次快照的差异、索引生成失败原因。
- 工作树列表（可选）：哪些工单占着工作树、占了多少磁盘。

## 上线顺序（每步可独立回退）

| 步 | 内容 | 独立价值 |
|---|---|---|
| 1 | 索引 + `orchestrator_projects` + 面板（只读） | 判定有据；不影响任何执行 |
| 2 | 工单记录 `project`（代码解析 basis）+ accept 字段 | 归属可复盘 |
| 3 | **目录根迁移 + 工作树创建 + prepare 变量 + 身份校验**（合并原第 2、4 步，一次迁移到位） | 会话在正确项目里；工作根不再新增空目录 |
| 4 | 工作树生命周期（清理策略、自愈、失败不回退） | 不积累残留 |
| 5 | worker prompt 的分支约定与归属确认 | 防静默判 completed、防判错 |

v1 曾把「目录根迁出工作根」单独作为第 2 步：评审实测后判定**它的独立价值不成立**（工作根的脏来自操作者自己的 168 个 checkout），却会单独引入一次 prepare cwd 变更与一条升级说明，因此并入第 3 步。

## 测试计划

1. **索引**：`.git` 目录与 `.git` 文件两种形态；bare 不收录；同仓库两个 worktree 只出一条（按 commonDir 去重）；子模块不单独收录；权限不足/损坏仓库进 `skipped`。
2. **判定**：named / indexed / alias / 留空各一条；两条同时命中必须留空；模型给了名字但索引里没有 → 留空并拒绝该字段。
3. **工作树**：有项目时目录在 `<stateDir>/worktrees` 且 `rev-parse --show-toplevel` 指向项目；无项目时目录也在该根下、**不在工作根**；同仓库两工单并发（一个失败不污染另一个）。
4. **自愈**：同路径重试（`already exists`）；目录被手工删但注册残留（prune 不认 → 显式 remove）；两者都应成功。
5. **身份校验**：目录存在但不是本工单的工作树 → 拒绝复用；`prepare` 跳过不再绕过 `verifyDirectory`。
6. **prepare**：cwd 断言（现在 `tests/` 里没有 executionRoot/cwd 断言）；`DSH_SUPERAGENT_PROJECT`/`_PATH` 在有/无项目下分别为值/空串。
7. **绑定**：assignment 与 worker prompt 都含 `git switch -c agent/$DSH_SUPERAGENT_NAME`。
8. **迁移**：无 `project` 的旧工单仍能 launch（目录在新根下创建）；已有目录的旧工单不受影响（路径冻结在记录里）。
9. **清理**：无 open PR 的工单结束后工作树与其 `.git/worktrees` 注册一起消失；有 open PR 的保留。
10. **纠正记录**（§7.1）：人纠正确实写入别名表并带 `source/by/ticket`；同一 trigger 重复只记一次；旧条目进 `history` 而不是被抹掉；模型（机器人）消息不能触发纠正；纠正后当前 assignment 停止、工单以 `dropped` 结束并发出结束通知；纠正后的再发一次请求命中新项目。

## 待定

- **预热工作树池**：**不做**（实测见下节「实测：工作树开销」，秒级，预热只会让磁盘更早被占满）。
- **子模块**：本机 6/153 有 `.gitmodules`。默认**不**自动 `submodule update`，由 `prepare` 决定。
- **多 work root**：现在不做；索引 schema 已带 `root`，将来加根不改格式。

## 实测：工作树开销（2026-11-27，本机）

`git worktree add --detach <path> HEAD`，每个仓库测一次，完成后 `worktree remove --force`：

| 仓库 | 受版本控制文件数 | 仓库体积 | `worktree add` 耗时 | 工作树体积 |
|---|---|---|---|---|
| `deepseek-harness` | 22 951 | 3.2 G | **4.83 s** | 216 M |
| `shop.example.com` | 7 730 | 1.6 G | **2.55 s** | 122 M |
| `portal.example.com` | 811 | 115 M | **1.17 s** | 22 M |

结论：

- **耗时是秒级**，不需要预热池；最坏情况（本机最大仓）也在 5 s 内，而工单从 accept 到 worker 首个 turn 本身就有秒级开销。
- **磁盘是主要约束**：工作树体积约为仓库受控文件的大小（`deepseek-harness` 216 M）。5 个并发工单同时在最大仓上 = 约 1 G。这是 §5「工单结束即清理」必须做掉的直接理由，不是可选的整理工作。
- 工作树不复制 `.git`（只写 `.git/worktrees/<name>` 注册），所以 N 个并发工作树的额外开销近似线性，可预算。

## 已知边界（写下来，避免被当成缺陷）

- 工作树共享 `stash`/`refs`/`config`/`gc`，不是安全边界。
- 索引在后台生成，刚装好的第一次判定会留空（宁可留空也不现场扫 2.6 s 阻塞 `ready`）。
- 已存在的 worker session 换不了 cwd（`sessions.ts:138-147` 只在 session 不存在时 `workspaceRegistry.create(cwd)`），所以判错只能取消重开。