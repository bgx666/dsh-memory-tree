# DSH Memory Tree

把 DeepSeek Harness 的「压缩成一段摘要」换成分层记忆树。

压缩后的上下文由节点消息组成；节点攒够 9 个就取最早 3 个合并成父节点，父节点再攒够再往上，
`explore_memory_tree(node_id)` 可以逐层下钻到原始消息。

## 快速使用（先看这里）

安装并启用插件后：

1. 打开一个会话，看输入框下方那行统计信息（轮次/步数、token、缓存命中）的**最左边**：
   「**本会话使用记忆树**」。
   - 默认不勾选：新会话、以及装插件之前就存在的会话，都继续用框架的普通摘要。
   - 勾选：只对**当前会话**启用；之后上下文超预算时，插件改成分层节点压缩，模型也可以用
     `explore_memory_tree` 下钻查历史。这个开关持久化在 `session_prefs`，不影响其他会话。
   - 取消勾选：只停止**当前会话以后**使用记忆树；已经生成的节点和卡片保留。**已经压掉的原文不会自动
     回到上下文**：当前上下文仍然是 checkpoint 里的节点摘要加未压缩的尾部。原文还在会话日志和树节点
     的 `details` 里，可以点卡片节点查看；下一次普通压缩会把当前 checkpoint 当普通摘要再压一次。
2. 打开 **设置 → 记忆树**，可以改触发阈值、保留条数、分片大小、节点预算、合并阈值和压缩提示词；
   这些是下一轮压缩才生效的参数。
3. 压缩完成后，对话区会出现记忆卡片：点节点标题展开字段，再点子节点继续往下一层；点到叶子节点
   会显示它覆盖的原始消息。卡片右上有「全部收起」，一次收起所有展开的层级。
4. 模型侧也一样：根节点已经在 checkpoint 里，`explore_memory_tree` 只接受一个 `node_id`，不会再
   空参数列一遍根；摘要和字段够用就直接回答，不必为了回答而一路翻到原文。

## 内存和数据库

- 对话区只渲染 checkpoint 里的**活跃根节点**，不会把整棵树展开成消息；根节点数量由合并阈值控制，
  不是历史节点总数。
- 卡片内容是按需加载的：点开一个节点才请求 `/memory-tree/api/node`，返回它的直接子节点，叶子才
  返回原文；收起节点会清掉该分支在页面里的缓存，重新展开再取。
- SQLite 不是把整个库读进内存：`roots`/`children`/单个节点按需查询，页面缓存只保留展开过的节点，
  数据库文件大小不等于插件内存占用。
- 真正会持续增长的是磁盘上的 `nodes.details`（每个叶子的原文）和 SQLite 文件；保留全部原文才能
  下钻到原始消息。若长期运行需要控制体积，后续可加“详情压缩 / 老叶子原文保留期”，代价是超过保留期
  的叶子只能看摘要和字段，不能再看逐条原文。

## 安装

要求 DeepSeek Harness `>=0.2.1-rc.3 <0.3.0`。插件管理器支持从 GitHub 安装 bundle，
target 填：

```text
github:bgx666/dsh-memory-tree
```

安装后启用 `memory-tree` 行并重启 DSH。源码安装 / 本地开发见
[装在哪里](#装在哪里改完代码最容易踩的坑)。

## 一句话原理

压缩不是"另存一份摘要"，而是**把上下文里的原始消息换成节点消息**。节点消息长这样：

```
[node0_003 · L0 · 第13-18条] [已压缩 · 不需要压缩]
[摘要] 这段做了什么、进展到哪、决定了什么
[概述] 一句人话
[任务] 目标：…；状态：…；待办：…
[决策] 选 A（因为 …）
[经验] 症状→修法（原因：…）
[环境] 目录：…；命令：…；引用：…；约束：…
[用户] 偏好、习惯
```

所以模型看到的上下文**本身就是这棵树**。节点攒够 9 个就把最早的 3 个合并成父节点，
父节点再攒够再往上，`explore_memory_tree(node_id)` 可以逐层下钻到原文。

## 一次压缩做什么

| 步骤 | 做法 |
|---|---|
| 何时压 | 框架按 `thresholdRatio`/`retainRatio` 决定；插件只拿到“要压这一段” |
| 分片 | 3 万 token/片、最多 12 片、优先用户消息边界、浮动 0.75×~1.4×、不切开 tool 配对 |
| 渐进前缀 | 从最新一片往前调用，每次带「第 1..k 片原文」：`src/engine.js` 的 `chunks.slice(0, k+1)`；先建立最长前缀缓存，后续请求只读更短前缀 |
| 指令定位 | 头锚点=首条正文前 120 字、尾锚点=末条正文结尾 60 字 |
| 输入组装 | system（对话自身的 system 头）+ 带标记的已有节点 + 待压原文 + 指令 |
| 输出 | JSON：summary/narration/task/decisions/lessons/context/user，`src/schema.js` 归一化 |
| 预算 | `nodeBudget` 默认 1000 字，summary 占 40%，超了按固定牺牲顺序硬裁 |
| 落树 | `store.addLeaf`：summary、消息范围、原文 details、结构化字段 |
| 向上合并 | 阈值 9、每次取最早 3 个、一轮持续合并到低于阈值（最多 8 批） |
| 合并输入 | 只放节点消息；目标去标记；目标之后的节点（未来信息）不进 |

## 提示词

`prompts/compress/*.md` 是插件内置的压缩提示词（`leaf_*` / `leaf_scope_*` /
`leaf_scope_chunk_*` / `parent_*` / `budget_*` / `skeleton_*` / `retry_*`，中英各一份）。
可以直接改设置里的模板，或跑 `explore_memory_tree` 看节点文本。

`src/prompts.js` 对模板渲染很严格：模板引用了没传的占位符直接抛错，
这样少一行预算不会静默发出去。

## 配置

每个会话有一个独立开关：输入框下方统计行最左侧的「本会话使用记忆树」复选框，
排在轮次/步数、token 和缓存命中之前。
开关默认关闭：新会话、以及安装插件之前就已经存在的会话，都不会自动启用记忆树，
而是继续使用框架的普通摘要。手动勾选后才会为该会话启用。
关闭只影响当前会话，下一次压缩回退到普通摘要；已经生成的记忆节点和卡片不会删除，
其他会话也不受影响。开关持久化在 `session_prefs` 表。压缩进行时，这一行临时显示
「记忆树压缩中 · …」，完成后恢复为开关，不会额外占一行。

右侧的轮次导航也只保留仍在上下文里的用户消息；被折叠进记忆树的旧用户消息不再显示对应横条。
会话开启记忆树时，Host 还会向系统提示词加入一条规则，要求模型在回答“之前讨论过什么/决定过什么”
这类问题前先调用 `explore_memory_tree`，不要只依赖压缩摘要；关闭的会话不会收到这条规则。

打开 **设置 → 记忆树**，可以编辑：

- 分片大小 `chunkTokens`、每轮分片数 `maxChunks`
- 触发阈值 `triggerTokens`（默认 500000；0 = 按窗口比例）、保留最近消息条数 `retainMessages`（默认 30，只按条数）
- 节点字数 `nodeBudget`、合并阈值 `mergeThreshold`（默认 9）、每次合并数 `branch`（默认 3）、每轮合并批数 `maxMerges`
- 语言 `zh/en`、后台异步开关
- 7 类压缩提示词的中英文模板（叶子、单分片范围、多分片范围、预算、JSON 形状、父节点、重试）

提示词模板默认就是 `prompts/compress/*.md` 的文件内容；清空某条并保存会恢复内置模板。保存走 DSH 的 settings 用户层，会覆盖 profile 的 composition 默认值。

profile 补丁 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 的 `memory-tree` 条目：

```yaml
- id: memory-tree
  name: "@your-scope/dsh-memory-tree"   # 安装时生成的包名
  config:
    chunkTokens: 30000     # 每片估算 token（字符数 ×1.2）
    maxChunks: 12          # 一轮最多切几片，剩下的留给下一轮
    nodeBudget: 1000       # 整节点字数（中文 1:1；英文 ×3.5），summary 占 40%
    triggerTokens: 500000  # 达到约 50 万 token 才触发压缩；0 = 按窗口比例
    retainMessages: 30     # 压缩后保留最近 30 条原始消息
    mergeThreshold: 9      # 某层活跃节点 ≥9 才合并
    branch: 3              # 每次合并最早 3 个
    maxMerges: 8           # 一轮最多合并几批
    language: zh           # zh | en，选哪套指令
    async: true            # true = 后台摘要，回合结束再落 checkpoint（默认）
    # mode: sync           # 或设 async: false / DSH_MEMORY_TREE_SYNC=1，退回同步压缩
    # summaryProvider / summaryModel：# 不给就用当前路由的模型
```

> ⚠️ 直接改 profile YAML 的 composition 层，旧值可能要到下一次激活才稳定；优先用
> **设置 → 记忆树** 保存，设置页走 settings 用户层并会触发生效。

## 装在哪里（改完代码最容易踩的坑）

DSH 按**包名**从 profile 的 `node_modules` 解析插件：

```
源仓库   <checkout>\dsh-memory-tree\
实际加载 $DSH_HOME\profiles\<profile>\node_modules\<package>\
```

这是**两份**。改源码不同步 = 进程里跑的还是旧那份，而插件照常启动、日志照样像模像样，
只有行为不对。所以每次改完：

```bash
npm run sync      # 把源码拷进 profile（先删后拷，不会留旧模块）
npm run probe     # 逐字节比对 + 检查数据库列
npm run verify    # sync + probe
```

`probe` 会检查：关键文件是否逐字节一致、有没有残留的旧模块、
`inject` 里有没有 `llm`、数据库缺的列是否都能迁移。

**不要用目录联接（junction）代替拷贝。** Node 会把联接解析成真实路径，
于是从 checkout 根目录出发去解析 `@deepseek-ai/*`，而那套名字只有在 harness 里才解析得到。

`activate` 行末尾的 `self=` 是"到底加载了哪一份"的唯一铁证：

```
activate  pid=…  service=…  chunkTokens=30000  nodeBudget=1000  …  base=…app.asar/…  self=file:///C:/Users/…/profiles/<profile>/node_modules/<package>/index.js
```

`base=` 是后端模块的真实位置（应以 `app.asar` 结尾，说明注入到了 app 自己那个类上），
`self=` 是插件自身。两个都对，才说明补丁打在了正在运行的对象上。

## 怎么确认它在工作

```bash
node src/status.js                    # 所有会话的树 + 生命周期日志
node src/status.js <session-id>       # 某个会话的完整树（含已合并的子节点）
node tests/policy.test.js             # 定价/区间/空闲锁
node tests/async.test.js              # 后台摘要 → 空闲提交 → 失败回滚
node tests/smoke.test.js              # 离线测试（9 例，不需要 Harness）
node tests/client.test.js             # 离线验证卡片槽位与 checkpoint 解析
```

真实进程里的证据是 `$DSH_HOME/memory-tree/plugin.log`，一次成功压缩按顺序长这样：

```
import    pid=…  prototype=patched  rewrapped=no  base=…app.asar/…
activate  pid=…  service=…  chunkTokens=30000  nodeBudget=1000  threshold=9  branch=3  lang=zh  base=…  self=…
probe     session=…  route=opencode-go/deepseek-v4.1-flash  messages=371  tools=N (not forwarded)  timed=371  aborted=false
start     session=…  fresh=371  chunks=8
leaf      session=…  n=1/8  range=1-47    summary=612
leaf      session=…  n=2/8  range=48-94   summary=580
…
merge     session=…  level=0  children=4  parents=1
compact   session=…  leaves=8  merges=1  nodes=5  depth=L1  blocks=6  chars=…
```

看这几点：

- `probe` 出现 = 钩子真的被调到了，并且知道它拿到了多少条消息、用的哪个模型。
  `tools=N (not forwarded)` 是刻意的：不把工具 schema 递给压缩请求，
  模型就没法用"我要调个工具"来回答，只能吐节点 JSON。
  `timed=N` 是从会话日志里认出了时间的消息条数；正常应当等于 `messages`，
  小于它就说明这一轮节点的 `[时间]` 会退回采样行近似（不是错误，但精度差一档）。
- `leaf n=k/N` 每片一行，是这一轮的真实进度。**看不到 `leaf` 只有 `probe`** =
  第一片就失败。
- `compact` 行的 `leaves` 是这轮落了几个叶子，`merges` 是合并了几个父节点。
- 只有 `fallback` = 树这一轮失败了、退回了框架的扁平摘要，错误原因就在行内
  （`error=` 后面）。看到它就把那一行贴出来，别自己猜。

## 输入框下方的上下文百分比

那个 `上下文已用 xx%` 是 DSH 自己的 `contextPressure` 投影，不是“7 个记忆树节点占多少”：

- 分母来自最近一次 `request/context` 的模型窗口
- 分子来自最近一次 provider usage，再加上当前 surface 相对那次 usage 的增减
- `compaction/summary` 会按 shadowed 区间的 heuristic token 先减掉，所以提交瞬间会下降；
  之后新消息继续增长，百分比当然会再涨回去
- 卡片上新增的“本次压缩 N 条 · 释放约 X token”就是这次释放量；它和上面的百分比不是同一套计量

如果觉得压完还是很高，通常是 `retainMessages` 保留得太多（比如 200 条），只压掉了最早一小段。
在 **设置 → 记忆树** 里把 `triggerTokens` 改成 `100000`、`retainMessages` 改成 `10`，
下一次压缩释放的量会明显更大，百分比下降也会更明显。压缩后保留的尾部是**整条消息**，不会把某条消息从中间切开。



## 实现取舍

- **触发**：由 `compaction-basic` 按窗口比例触发，插件只负责“压这一段”。
  想改用固定预算，可以调 `triggerTokens` 或 `compaction-basic` 的 `thresholdRatio`。
- **checkpoint 是一条消息**：节点放在单条 user 消息的多个 content block 里。
  可下钻、可寻址，但“消息条数”这种计量方式不再直接成立。
- **没有可靠的工作目录**：DSH 的请求里没有稳定的 cwd；节点里的 `[环境] 目录` 拿不到就留空，不编造。
- **时间取自已记录的会话日志，不是猜的**：DSH 的请求消息本身不带时间戳，但会话日志里
  每个事件都有 `event.time`（`session.append` 写的 `Date.now()`），压缩区用
  `session.deriveEventMessage(session.eventAt(seq))` 逐事件投影——返回的就是事件里存的那条消息对象本身。
  所以按**对象同一性**建索引，每条被压的消息都有精确时间；节点写 `[时间]`，
  叶子回放每条消息带 `· HH:MM`。索引不到才退回时间采样行，再不行就不写。
- **结构化输出**：直接调 `ctx.llm.stream` + JSON 解析，失败重试一次（带“上次被截断”提示），
  再不行落机械摘要。
- **机械兜底**：某一片彻底压不出来时，仍然落一个节点（截取原文开头当摘要），
  绝不把消息从上下文里删掉却没有东西顶上。
- **写入节奏（异步）**：在 `agent/pre-step` 只截取区间并起一个后台任务，
  摘要请求与主对话的模型请求并行跑，**不阻塞本轮回复**。等 `agent.whenIdle()` 拿到空闲维护槽后，
  再用框架的 `compaction/start → compaction/summary → 替换 surface → compaction/end` 事件序列落盘；
  这一段没有模型调用，通常几十毫秒。溢出恢复和手动 `/compact` 仍走同步路径（必须立即完成）。

## 异步压缩（`async`）

```text
pre-step:  测到超阈值 → 截取最老的平衡区间 → 返回 null（本轮照常请求模型）
后台:      分片/从新到旧的渐进前缀/结构化摘要 → 写 SQLite 节点（与主对话并行）
回合结束:  whenIdle() → runMaintenance → 追加 compaction 事件替换区间
```

日志里对应 `async-start` → `probe mode=async` → `leaf` → `compact mode=async` →
`async-commit`；失败是 `asyncfail`，并且会 `async-rollback` 把这一轮先写进去的节点撤掉，
不会留下“上下文里没有、树里却有”的孤儿节点。

关闭异步：profile 里设 `async: false`（或环境变量 `DSH_MEMORY_TREE_SYNC=1`），行为退回
`compaction-basic` 原来的同步压缩，用于对比/排查。

## 会话区那张卡片（`client.js`）

> `preview/card-preview.png` 只是设计预览，**不是运行时卡片**；运行时卡片是 `client.js` 里的
> React 组件，按 `conversation.chat.node` 槽位渲染，不读取任何图片。

DSH 的 Chat 视图本来就把压缩位置画成一行标记（`CompactionItem`：图标 + 标题 + 单行省略的摘要，
点开看正文）。这里把它换成插件的记忆卡片，做法是**注册同一个槽位位置**，不改 DSH：

```js
ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
  name: 'conversation.chat.node', key: 'compaction',
}, MemoryTreeCard))
```

`conversation.chat.node` 是按 key 的槽位，契约里写明「Reusing a key replaces that node renderer」，
所以 `key: 'compaction'` 就把官方那行换掉；本插件没加载时官方那行照旧，是天然的降级。

卡片内容来自 `CompactionSummaryNode.summary` —— 那正是 `compact()` 返回的 block 拼起来的文本，
所以按 `[node0_001 · L0 · 第1-29条]` 拆开，每个节点一行：编号、条数范围、时间、摘要，点开看完整字段。
认不出节点形状（别的 provider 写的 checkpoint）就整段原文照显，不装作没内容。

**原文折叠与单卡**：DSH 有意把被压缩的历史留在转录里（标记只是说明「模型从这儿开始看不见」），
官方没有提供过滤行的接口。Host 在 checkpoint 落盘时记下**实际保留下来的 Chat 行 key**，
并写入 `memory_tree.db` 的 `keeps` 表，重启后仍能取回；卡片按这组 key 找到最老的保留行，
只折它前面的历史，所以 `retainMessages` 留多少条，
界面上就显示多少条原始消息，不按固定行数猜。树是同一棵，只渲染 `summaryEventSeq` 最大的那张卡，
旧卡由新卡一起折掉，不会同时看到第一次和第二次的结果。
压缩只替换**真正总结过的前缀**（分片上限留下的尾部原样保留），所以卡片始终在保留尾部之后，
视觉上再排到顶部。没有保留边界数据时（旧卡或 Host 未记录）宁可不折，也不隐藏未压缩消息。
DOM 不合预期就一行都不动，卸载时一定还原 —— 宁可退回「只换外观」，也不能把转录弄空。
卡片始终收起，没有「展开原文」；会话打开或切换时客户端会自动隐藏并点击「加载更早」，
直到记忆卡片进入 DOM，然后把视图滚到卡片，因此可见的最早一条就是记忆摘要节点。
替换上下文时转录可能有几千行：折叠 observer 只监听直接子行并合并成一次任务，状态条找到卡片后
停止全页观察，轮次导航也不再逐行调用 `getComputedStyle`，避免一次替换触发成百上千次全量扫描。

> 这层是页面脚本（`window.__ModuleLoader__.load({id, factory})`），没有构建步骤：
> `react` 由 app 在运行时提供。改完 `client.js` 需要刷新页面；宿主侧（`index.js`）改动仍需重启 DSH。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 挂钩 `BasicCompactionEngine.prototype.summarize`、按 profile 配置驱动、失败退回扁平摘要 |
| `src/engine.js` | 分片 → 渐进前缀 → 叶子 → 合并 → 渲染 checkpoint |
| `src/chunk.js` | 按 token 切片，用户消息边界 + tool 配对安全 |
| `src/llm.js` | `ctx.llm.stream` 调用、JSON 解析、截断/解析失败重试 |
| `src/schema.js` | 节点字段归一化、预算硬兜底、字段行渲染 |
| `src/store.js` | SQLite：nodes + meta.fields/details/时间范围，8/4 合并 |
| `src/text.js` | 消息文本、头尾锚点、节点文本、checkpoint 渲染 |
| `src/policy.js` | 异步路径的定价、区间选择、区间回放、空闲锁检查 |
| `src/tool.js` | `explore_memory_tree` 下钻工具（叶子回放带 `【assistant→tool】名字(参数)`，否则只剩工具结果、看不出是谁调的） |
| `src/status.js` | 人看的树 + 日志 |
| `client.js` | **Web 半**：把会话区的压缩标记行换成记忆卡片（`conversation.chat.node` 槽位的 `compaction` 位置） |
| `prompts/compress/` | 内置压缩提示词 |
| `tests/policy.test.js` | 定价/区间选择/回放/空闲锁的离线测试 |
| `tests/async.test.js` | 用假 session 跑 `defer → 后台摘要 → 空闲提交`，含提交失败回滚 |
| `tests/smoke.test.js` | 离线测试（9 例，覆盖 checkpoint 识别/分片/后向调用/合并/节点文本/下钻回放） |
| `tests/client.test.js` | 按页面加载器的真实形态求值 `client.js`：信封、槽位、key、checkpoint 解析 |
| `tests/probe-install.mjs` | 比对源码与 profile 里的安装副本，并检查数据库 schema |
| `tools/sync.mjs` | 发布到 profile（`--check` 只比对不写） |
| `tools/db-schema.mjs` | 打印数据库表结构，确认迁移状态 |

## 数据库

默认 `$DSH_HOME/memory-tree/memory_tree.db`（可用 `DSH_MEMORY_TREE_DB` 覆盖）。
`nodes` 按 `session_id` 分区；`details` 存被压缩的原始消息、
`meta.fields` 存七个结构化字段、`time_start/time_end` 存时间范围。
`keeps` 存每个 checkpoint 实际保留的 Chat 行 key，供重启后恢复折叠边界。
`session_prefs` 存每个会话的记忆树开关，默认关闭。
`runs` 记录后台压缩的提交状态；进程在提交 checkpoint 之前中断时，下次打开数据库会删除
该 run 写出的节点，不会让未完成的摘要进入上下文。

旧版本建的库缺 `meta/time_start/time_end/run_id` 等列，打开时用 `ALTER TABLE` 补上，
已有行照旧渲染（只是没有字段行）。`npm run schema` 可以直接看当前状态。
