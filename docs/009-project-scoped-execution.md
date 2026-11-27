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

⚠️ 更正一个常见误解：工作根里现在有 **207 个 checkout**（155 个可见 + 52 个隐藏 worktree，其中 43 个是 `.tap-wt-*`），那基本是操作者自己的东西；工单造成的空目录只有 1 个。**本设计不承诺「让工作根变干净」**。

## 目标与非目标

目标：

- 工单在**正确项目的隔离工作树**里运行。
- 项目归属在派活时判定，且判定**可复盘**（依据由代码算出，不是模型自述）。
- 判不出来时，不要给 worker 一个「看起来像目标项目」的目录；把「默认改对仓库」做成路径决定的后果，而不是靠 worker 自觉。

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

- **两次调用取全部事实**（一次拿不全）：`git -C <dir> rev-parse --path-format=absolute --git-common-dir --is-bare-repository` + `git -C <dir> rev-parse --abbrev-ref HEAD` 与 `git -C <dir> rev-parse --verify HEAD`。
  注意 `--abbrev-ref` 作用于**其后所有** rev，写成 `rev-parse --abbrev-ref HEAD HEAD` 两次都输出分支名、**拿不到 SHA**。实测一层 153 个仓库：4 次调用 12.2 s，两次调用约 3 s（不含 `committedAt`，那个要再跑一次 `git log -1 --format=%cI`，只在面板展示用、可延后）。
- **判据是「目录里有 `.git`」**：`.git` 可以是目录（普通 checkout）或文件（worktree / 子模块）。bare 仓库没有 `.git`，但**实测它的 `rev-parse --git-common-dir` 返回 `.`、分支 `HEAD`，与普通仓库无法区分**，所以必须在同一次 `rev-parse` 里加 `--is-bare-repository` 判掉。
- **`commonDir` 必须是绝对路径**：`git rev-parse --git-common-dir` 在仓库根目录下返回**相对的 `.git`**（本机 git 2.49.0），按字面去重会把 153 个项目塌成 1 个。必须加 `--path-format=absolute` 并 `realpath`（`/data1` 是符号链接，git 返回 realpath，天然与字面路径不等）。
- **去重键 = `realpath(commonDir)`**：同一仓库的多个 worktree 只能出一条索引项，否则 `indexed` 判定会常态性歧义。
- **子模块不是靠 commonDir 归并掉的**：子模块的 commonDir 是 `parent/.git/modules/<name>`，与父仓**不同**，归并不会发生。正确判据是 `git rev-parse --show-superproject-working-tree`（有输出即子模块）→ 跳过。
- **代表路径**：同一 commonDir 有多个 checkout 时（本机 tap 仓有 44 个），取「主 worktree」：`git rev-parse --show-toplevel` 与 commonDir 的父目录一致的那一个；退而取有 `remote.origin.url`、且路径最浅的一个。索引里只留代表路径，其余记在 `checkouts: [...]` 供排查。
- **别名表独立、可编辑（已定）**：`<stateDir>/projects-aliases.json`，形如
  ```json
  { "趋势互动": "portal.example.com", "购物车": "shop.example.com" }
  ```
  扫描只产事实，别名只产 hint，二者合并成 `projects.json`。放在 stateDir 的理由：可 review、可 diff、可随备份迁移、不随重新扫描丢失；命中别名只给 `indexed` 级依据，多条命中仍必须留空。
- **启动不阻塞**：索引在后台生成，`ready` 不等它；面板显示「索引生成中 / 上次生成时间 / 跳过的条目」。首次使用时若索引缺失，判定直接留空（见 §3），不现场扫。
- **面板不要比「项目数 vs 目录数」**：本机 153 个 gitdir + 2 个 gitfile + 非 git 目录 + 56 个隐藏项（其中 52 个是 checkout），没有唯一的「实际数」。改为展示 `skipped` 明细与「与上次快照的差异」。

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
  git switch -c agent/$DSH_SUPERAGENT_NAME 2>/dev/null || git switch agent/$DSH_SUPERAGENT_NAME
  ```

  **必须写成 `-c || switch`**：分支已存在是常态而非异常（retry、恢复、重建工作树三种场景都会撞上）。

  这句话要同时出现在 worker prompt（`prompts/`）与 per-ticket assignment 里。理由：`docs/003` 明写「ready 但没有 PR 时工单结束为 completed」——worker 忘了建分支还报 ready，工单会**静默判完成**，提交只留在 detached worktree 里。

无 `project`：目录 = `<stateDir>/worktrees/<execution.name>`，空目录，行为与今天等价（除了不再落在工作根）。**旧工单不受影响**：它们的 `execution.directory` 已落库，`prepare()` 只在新 create 时调用、`wake()` 不重算 `execution`，所以永远用旧目录；新根只作用于新工单。

**失败不回退**：工作树建不出来（路径已被注册但无效、分支不存在、磁盘满）→ 工单 `failed` 并在会话里说明原因。不退回空目录。

### 5. 工作树的生命周期（v1 完全缺失）

- **创建前自愈分两种情形，命令不同**（实测）：
  - 目录已不存在、注册残留 → `git worktree prune` **能清**（输出「删除 worktrees/x: gitdir 文件指向一个不存在的位置」），之后同路径 `add` 成功。
  - 目录还在、但内部 `.git` 丢了（半损坏）→ prune 清掉注册，但路径**占位**仍在，`add` 报「已经存在」，而 `worktree remove --force` 报「不是一个工作区」。**正确动作是 `rm -rf <path>` 后再 `add`**。
  - 先 `prune`、再判断路径是否存在、存在就 `rm -rf`、最后 `add`，三步都幂等。
- **清理 owner 与时机**（引擎，工单结束或 PR 终态时）：
  - 无 open PR → `git worktree remove --force <path>` 后 `git -C <project> worktree prune`。
  - 有 open PR → 保留到 PR merged/closed；**但这不能是无上界**：带 PR 等 review 的工单是常态，稳态占盘会等于「所有 open PR 工单」之和。上界两条：PR 结束后 T+7 天删；任何工作树存在超过 30 天删（面板标出「将要清理」）。
  - `failed` 工单（open、等 retry）→ 保留 7 天，之后按上一条处理。
  - 无 project 的中立目录 → 不是 worktree，直接 `rm -rf`（与今天清理空目录等价）。
  - `agent/<name>` 分支在共享仓里，**永不删除**（它是 PR 的根，删了 PR 就断了）。
  - 启动时做一次孤儿清扫：对每个项目 `git worktree list --porcelain`，删除路径已不存在或路径不在 `<stateDir>/worktrees` 下的注册。
  - `closePull` 在「没有 open 工单跟这个 PR」时会提前返回，所以 PR 终态的清理要**先于**那个 return 判断，或另挂一个 PR 事件监听。
  - 清理失败（磁盘只读、权限）只记日志并在面板标出，**不影响工单终态**。
- **执行接缝**：`tickets.end()` 在 `store.atomic` 内且同步，不能在里面删目录；走 `store.afterCommit`（`docs/007:199` 的 `stop` 是先例）或独立 effect。PR 终态在 Source 层（`closePull` 是纯函数、且「没有 open 工单跟这个 PR」时提前返回），所以 PR 清理要挂 Engine 侧 effect，不能「顺带清」。启动时补一次孤儿扫描（host 被 kill 时工作树会永久残留）。
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

**身份校验替换「目录存在即已准备」**（`dsh.ts:481-482` 现在只 `stat`，且跳过 `verifyDirectory`），按有没有 project 分档：

- **有 project**：`git -C <dir> rev-parse --show-toplevel` 等于期望路径且 `--git-common-dir` 等于项目的 commonDir；不符走 §5 自愈或 failed。对 worktree 来说「目录存在」不等于「这是本工单该用的工作树」。
- **无 project（含所有旧工单）**：目录可能是**普通空目录**，`rev-parse` 会 exit 128、无输出——所以不能套上面的判据。只校验两件事：目录存在；它不是别人工作树的根（存在 `.git` 文件且其 commonDir 属于另一个工单目录时拒绝）。
- **旧工单豁免**：`execution.directory` 已冻结的工单不做迁移，按上面的「无 project」档校验。

**谁建工作树**：引擎建（§4），`prepare` 只在之后跑。这与 `docs/003:55` 的「典型 prepare 用 `git worktree` 建 checkout」冲突，必须二选一并写进 003：

- 选**引擎建**（本设计）：`docs/003` 改为「有 project 的工单由引擎建工作树；prepare 在其后运行，可用于装依赖」。同时**检测已存在**：若目标路径已是本项目的 worktree 就跳过建树。
- **必须同时改 `docs/006:153` 的官方示例**：那份示例的 prepare 就是 `git worktree add -b agent/$DSH_SUPERAGENT_NAME "$DSH_SUPERAGENT_DIR" …`——代码先建树会让这条唯一文档示例直接 `already exists` 失败。把它改成「只装依赖 + 建分支」（见下条），并在升级说明里点名「prepare 里含 `worktree add` 的部署要删掉那一步」。

（正向：`verifyDirectory` 已处理 `worktree` scope，`environment.ts:155`；本机 153 个仓库的 `credential.*`/`http.*extraheader` 命中 0，这道门禁短期不会误杀。）

### 7. 判错怎么办，以及纠正必须被记住

`basis` 由代码算之后，「模型猜错」已被排除；剩下的是「原文提到了 A，但请求真正想做的是 B」。这类只能靠人。

- worker 的 assignment 文本（构造于 `dsh.ts:98-112`，1500 字符上限）：写项目名与工作树路径，并说明**默认做法**（不是权限）：「改动落在本工作树，经 `agent/<name>` 分支提 PR；不要直接改项目主目录」。worker 有整机写权限，这句是约定不是限制，所以 §7.1 的纠正要真的把活停下来。
- 详细的「开工前确认归属」写进 worker prompt，不占 assignment 预算。
- **不做** accept 前的确认门（会改动 `tickets.create → executor.start` 的现状，代价大于收益）。判错的处置是：人看到 `inferred`/`indexed` 标记与项目名不对，**取消工单重开**（取消现在已有回音，见 PR #3）。

### 7.1 人纠正了，就记下来（否则下次还错）

判错之后人会在工单会话里说一句「这不是 A 项目，是 B」。这句话不能只影响当下这一张工单——**它必须让同类请求下次直接判对**。

**这条通道必须按「停 + 记」实现，不能借 `dropped`。** `dropped` 是 `by: 'executor'`，而 `intake.ts:47`／`tickets.ts:254` 的规则是「人以非人的 owner 结束的工单，再来一句人话就自动 resume」——用 `dropped` 结束纠正，工单会被下一条消息唤醒并**回到 A 项目的旧工作树**继续干，「不自动重开」这条取舍当场被证伪。

流程：

1. **触发**：工单 open，来了一条**人**的消息（`trigger.human`；机器人不算），消息里点出另一个项目名。
   - 谁可以纠正：请求人（`requester`）或 `policy.sources[x].allowed` 里的 actor；其它群成员的纠正进面板待裁决，不直接改写路由。
   - 若工单**已经结束**（最常见的顺序其实是「先取消再抱怨」）：允许做 alias-only 纠正——只写别名表，不动工单。
2. **停下来**：主 Session 在人在场时只能停（`docs/002:26`），所以这条纠正走 `stop` 的 gate，附带纠正字段；引擎用 `tickets.end(..., by: 'human', outcome: 'stopped')` 结束工单——`stopped` 已存在（`model.ts:280`、`cards.ts:18`），**不新增 outcome**。`stopped` + `by: human` 正好满足「不会被下一条人话自动重开」。
3. **引擎自己发一条 IM**（不能指望主 Session 说话）：新增一个专门的 notice（不复用 `droppedNotice`，那条写死「没有做任何改动」，而纠正场景往往已经改过文件或开了 PR）。文案：项目判定有误、已按 `<B>` 记录、本次已停止、要接着做请再发一次（现在会直接用 B）。
4. **记录**（三处，各司其职）：
   - `ticket.project` **不覆盖**——它是「这张工单实际在哪个项目里干过活」，改成 B 会让记录说谎，并与「PR 归属认 `agent/<name>` 分支在 A 仓」互相打架。
   - `ticket.projectCorrections: Array<{ from, to, by: { staffId }, triggerId, at }>`（**append-only**）：`triggerId` 用于幂等，`by` 记人（不是 trigger id）。同一别名出现 ≥2 个不同来源时标 `ambiguous` 并让判定**留空**，而不是静默取最后一条。
   - **别名表**（长期学习）：**权威源在 SQLite**，不直接写 JSON。理由：工单结束与纠正发生在 `store.atomic` 事务里，文件写在事务外，两步之间崩溃就会出现「工单已纠正、别名没记住」。落库用 `key('project-corrected', ticketId, triggerId)` 做幂等键（O(1)，不用扫全表），再**单向导出**成 `<stateDir>/projects-learned.json` 供 review、diff、回滚。
     人工维护的 `projects-aliases.json` 仍然是**输入**（只读），与导出的 learned 文件**分开**；两者在同一 key 上冲突时：人工优先，且该 key 标 `ambiguous`、判定留空（与 §3 一致），仲裁交给人改文件。
     ```json
     { "趋势互动": { "project": "portal.example.com", "source": "human-correction",
                     "by": "<staffId>", "ticket": "<ticket id>", "triggerId": "<trigger id>", "at": "…",
                     "evidence": "人原话" } }
     ```
5. **键的可信度**：别名键（人说的那句）由模型抽取，但必须**是 trigger 原文的子串**（代码可校验，与 §3 的 `named` 用同一判据），否则拒收。这样「不接受模型自述」这条才真正成立。

不做的事：

- **不自动重开工单**（人可能不想继续）。
- **不改已存在的 worker session 目录**（物理上换不了）。
- **不用纠正去改 `project`**：实际执行过什么就记什么。

## 7.2 与此冲突的既有契约（实施时必须一起改）

- `docs/002:26`「worker 拥有消息期间主会话只能 stop」——纠正就是「stop + 附带记录」，措辞要写清，`notices.ts:79` 的 `FOLLOWUP_NOTE` 同步。
- `docs/003:55`「典型 prepare 用 `git worktree` 建 checkout」——改为「有 project 的工单由引擎建工作树」（见 §6）。

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

v1 曾把「目录根迁出工作根」单独作为第 2 步：评审实测后判定**它的独立价值不成立**（工作根的脏来自操作者自己的 207 个 checkout），却会单独引入一次 prepare cwd 变更与一条升级说明，因此并入第 3 步。

## 测试计划

1. **索引**：`.git` 目录与 `.git` 文件两种形态；bare 不收录；同仓库两个 worktree 只出一条（按 commonDir 去重）；子模块不单独收录；权限不足/损坏仓库进 `skipped`。
2. **判定**：named / indexed / alias / 留空各一条；两条同时命中必须留空；模型给了名字但索引里没有 → 留空并拒绝该字段。
3. **工作树**：有项目时目录在 `<stateDir>/worktrees` 且 `rev-parse --show-toplevel` 指向项目；无项目时目录也在该根下、**不在工作根**；同仓库两工单并发（一个失败不污染另一个）。
4. **自愈**：同路径重试（`already exists`）；目录被手工删但注册残留（`worktree remove --force` 直接清）；两者都应成功。
5. **身份校验**：目录存在但不是本工单的工作树 → 拒绝复用；`prepare` 跳过不再绕过 `verifyDirectory`。
6. **prepare**：cwd 断言（现在 `tests/` 里没有 executionRoot/cwd 断言）；`DSH_SUPERAGENT_PROJECT`/`_PATH` 在有/无项目下分别为值/空串。
7. **绑定**：assignment 与 worker prompt 都含 `git switch -c agent/$DSH_SUPERAGENT_NAME`。
8. **迁移**：无 `project` 的旧工单仍能 launch（目录在新根下创建）；已有目录的旧工单不受影响（路径冻结在记录里）。
9. **清理**：无 open PR 的工单结束后工作树与其 `.git/worktrees` 注册一起消失；有 open PR 的保留。
10. **纠正记录**（§7.1）：纠正以 `stopped`/`by:human` 结束，**下一条人话不会把它 resume 回旧工作树**（这是本次复评的一号 bug）；`project` 不被覆盖、`projectCorrections` 追加；同一 trigger 只记一次；两人纠正不同项目进面板待裁决；机器人消息不能触发；别名写入 `projects-learned.json` 且键必须是原文子串；已结束工单只写别名；纠正后那条 IM 真的发出（引擎发，不靠主会话）。

## 待定

- **预热工作树池**：**不做**（实测见下节「实测：工作树开销」，秒级，预热只会让磁盘更早被占满）。
- **子模块**：本机 6/153 有 `.gitmodules`。默认**不**自动 `submodule update`，由 `prepare` 决定。
- **多 work root**：现在不做；索引 schema 已带 `root`，将来加根不改格式。

已定（复评后收敛）：

- **别名分两个文件**：人工 `projects-aliases.json`、机器 `projects-learned.json`（原子写、schema 校验、逐条 skipped）。
- **`projectCorrection` 是 append-only 数组**，`project` 不可变；两人纠正不同项目进面板待裁决。
- **纠正用 `stopped`/`by:human`**，不新增 outcome；引擎自己发那条 IM。
- **工具命名**：`orchestrator_ticket_project_correct`（仓里工具一律 `orchestrator_*`）。
- **project 字段的唯一解析点**：新增 resolver 于 `src/app/projects.ts`，`orchestrator_route` 与 `orchestrator_eval_decide` 两条 accept 路径都调它，`basis` 只在 resolver 里算一次（`AssessmentSchema`／`RouteItemSchema` 都是 `.strict()`，新字段要同时改 `FIELDS` 表、`ports.ts` 的 accept 变体、`policy.ts` 的映射、`runtime.ts` 的 `prepareTicket`）。
- **`worktrees/` 排除出 stateDir 备份**（`docs/006:95` 把 stateDir 当备份对象），否则备份里全是可重建的工作树；stateDir 被搬走/还原后 worktree 的 `.git` 文件会指向不存在的路径，启动清扫要能识别并清掉。

## 实测：工作树开销（2026-11-27，本机）

`git worktree add --detach <path> HEAD`，每个仓库测一次，完成后 `worktree remove --force`：

| 仓库 | 受版本控制文件数 | 仓库体积 | `worktree add` 耗时 | 工作树体积 |
|---|---|---|---|---|
| `deepseek-harness` | 22 951 | 3.2 G | **4.83 s** | 216 M |
| `shop.example.com` | 7 730 | 1.6 G | **2.55 s** | 122 M |
| `portal.example.com` | 811 | 115 M | **1.17 s** | 22 M |

结论：

- **耗时是秒级**，不需要预热池；最坏情况（本机最大仓）也在 5 s 内，而工单从 accept 到 worker 首个 turn 本身就有秒级开销。
- **磁盘是主要约束，而且上面只是「检出」的数字**：216 M 是纯 checkout。同一个仓在装机后 `node_modules` 2.2 G、`.git` 545 M，磁盘文件数从 22 951（受控）涨到 126 398——worker 一旦 `pnpm install` 或构建，**单工作树会从 216 M 变成 2.5 G 级**，5 个并发更接近 5–12 G。本机当前只剩 68 G（已用 86%）。
  所以 §5 的清理不是整理工作，需要：每工单容量上限、`stateDir` 所在卷容量核对、超限告警；**不能**按线性检出体积做预算。
- 工作树不复制 `.git`（只写 `.git/worktrees/<name>` 注册），所以 N 个并发工作树的额外开销近似线性，可预算。

## 实施时的文档同步清单

| 文档 | 要改什么 |
|---|---|
| `docs/002` | 「worker 拥有消息期间主会话只能 stop」→ 写明纠正 = stop + 附带记录 |
| `docs/003` | 有 project 由引擎建工作树；prepare 的 cwd 与职责；变量表 |
| `docs/004` | worker prompt 的分支约定（`agent/<name>`）与归属确认 |
| `docs/005` | 面板显示 project / basis / 纠正状态 / 工作树占用 |
| `docs/006` | prepare 官方示例：去掉 `worktree add`，只留装依赖与建分支 |
| `docs/007` | 新模块 `src/app/projects.ts` 进 Modules 表（否则 `docs.spec` 直接失败）；新命令与工具进路由表 |
| 升级说明 | prepare 含 `worktree add` 的部署要删掉那一步；新根只作用于新工单 |

## 已知边界（写下来，避免被当成缺陷）

- 工作树共享 `stash`/`refs`/`config`/`gc`，不是安全边界。
- 索引在后台生成，刚装好的第一次判定会留空（宁可留空也不现场扫 2.6 s 阻塞 `ready`）。
- 已存在的 worker session 换不了 cwd（`sessions.ts:138-147` 只在 session 不存在时 `workspaceRegistry.create(cwd)`），所以判错只能取消重开。