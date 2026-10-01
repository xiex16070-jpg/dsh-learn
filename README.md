# dsh-learn — DSH 的持久学习回路

**Persistent learning for DeepSeek Harness.** A Cordis plugin that turns a session's corrections, failures and fixes into ordinary DSH skills — so the next session starts already knowing them. Zero extra model calls. Never touches the prompt or the history.

![cover](docs/shots/01-cover.png)

> 从会话里学东西，把学到的东西写成**普通的 DSH 技能**，并且在写之前先过一遍内容卫生与门槛检查。

| | |
|---|---|
| 额外模型调用 | **0** —— 只有确定性的正则与门槛，没有后台 agent |
| 落盘时机 | 模型显式决定（`learn_skill_manage create` / `learn action=note`） |
| 产出形态 | 普通 DSH 技能（`<DSH_HOME>/skills/learned/<name>/SKILL.md`），不是第二套注册表 |
| 破坏性操作 | 先鉴权（`managed.json`）、后留痕（`ledger.jsonl`）、归档从不删除 |
| 自测 | `npm test` —— 17 节，358 条断言，零依赖 |

---

## 它是什么

`dsh-learn` 挂在会话事件流上，把每个回合里出现的**纠正、失败与修法**蒸成类级技能，写进技能库，让下一个会话能用 `learn_skills` 找到、能被模型当技能加载。它自己不做判断：确定性路径（正则 + 门槛）只**产出候选**，写盘必须由模型显式决定。技能落在一个专属技能根里，状态、账本、候选与归档落在 `<DSH_HOME>/learn/data/`。整个过程**零额外模型调用**，也**从不读写会话历史或系统提示词**。

它不发明新的文件格式，也不维护第二套目录：学到的技能就是**普通的 DSH 技能**——宿主的技能提供者扫得到，`/名字` 能加载，别的工具也读得懂。插件只是往那个目录里写，并记住自己写过什么。

---

## 设计取舍

自动学习这件事，难的不是「把东西存下来」，是**「存什么」和「谁说了算」**。这个插件在每一处都选了更保守的那一边：

| 常见的做法 | dsh-learn 的做法 | 为什么 |
|---|---|---|
| 回合结束后 fork 一个模型做后台复盘 | 只观察 `session/event`（`user/message`、`assistant/message`、`tool/result`），在内存里留一个有上限的蒸馏窗口（`capture.maxSessions` 个会话 × `maxItemsPerSession` 条） | 复盘要一次真实 API 调用，而且它看到的上下文已经和当前回合不一致；观测现有事件流是零成本的，且永远和真实发生的事一致 |
| 把 transcript 重新灌进一个 cache-warm prompt | 永不触碰对话与提示词 | 宿主的**前缀缓存是不变量**，注入在实践中不可撤销 |
| 由那个后台模型决定存什么 | 前台模型决定；正则只负责提出候选 | 判断「这条是不是可迁移的类级做法」需要语义理解，正则做不到——v0.1.0 的事故就是证据（见下） |
| 维护一套自己的记忆存储 | 直接写普通技能文件 | 用户能读、能改、能删、能版本控制；不需要让宿主多认一种格式 |
| 一个无所不包的 `MEMORY.md` | 三个类级**伞技能**（`durable-preferences` / `tool-recovery` / `environment-facts`），每个只有一个写入目标 | 同一个事实只有一个家，不会散落多处互相矛盾 |
| 归档 = 删除 | `curator.js`：自带 unref 定时器、只归档、从不删除 | 「忘掉」应该是可逆的；移出去的目录随手移回来就恢复了 |
| 配置项越多越好 | 加一个键，必须同时加它的读者 | v0.2.0 删掉了 5 个没人读的安慰剂配置——它们让 README 看起来很强，实际什么都没做 |

一个回合走完的路径：

1. `session/event` 进来 → `curator.touch()` 记一次活动。
2. `capture` 把用户/助手/工具事件脱敏、压缩、按信号分类，塞进当前会话的内存窗口。**来源纪律在这一层强制**：用户文本只允许产出 `REMEMBER_REQUEST` / `USER_CORRECTION` / `USER_PREFERENCE` / `DURABLE_FACT`，助手文本只允许 `TECHNIQUE` / `SKILL_WRONG` / `RECOVERED_FAILURE`，工具结果只允许 `RECOVERED_FAILURE` / `TECHNIQUE` / `TOOL_FAILURE_OPEN`（`text.js` 的 `SOURCE_KINDS`）。
3. `agent/turn-stopping` → 防抖 4 秒后跑一次 `runReview(session, {dryRun:false})`。它**只写候选**到 `pending.json`，并且只在窗口观测数 ≥ `review.triggerObservations`（默认 3）时才跑。回合边界只负责调度，绝不 await——自我改进不能拖慢用户的回合。
4. 模型看 `learn action=pending`，自己决定要不要写：`learn_skill_manage create`（新技能）或 `learn action=note`（往三把伞里加一条规则）。两条路都过同一套门槛与同一套内容卫生。
5. 命中 `tokenSimilarity ≥ 0.6` 的既有规则会被**强化**（记一次命中、进 lessons）而不是复制一条。
6. curator 自带定时器（默认周期 24h，定时器周期取周期的 1/4 并夹在 1 分钟–6 小时之间），只在**空闲且距上次维护够久**时把 `staleAfterDays`（14 天）以上的受管技能转成 `stale`、`archiveAfterDays`（30 天）以上的**移进归档目录**。

![replay](docs/shots/03-replay.png)

*把一整天的真实会话喂回插件：一百多条观测里，它只留下 1 条候选，而且是真的工具恢复教训（`edit: Error: cannot modify …: file has not been read`）。其余全被门槛说明理由拒掉。*

---

## 中央设计规则：确定性路径只提议，不判决

> **确定性路径只产出候选（零模型调用的候选队列）；写一个技能文件必须由模型自己的决定触发 —— `learn_skill_manage create`，或者 `learn action=note`。**

这不是洁癖，是 v0.1.0 的一次事故换来的。

v0.1.0 的 `REMEMBER_RE` 里挂着裸的 `\bremember\b|\balways\b|\bnever\b`。它当时坐在裁判席上：命中就算「用户偏好」，直接落盘。于是**这个插件存下的第一条「用户长期偏好」，是它自己调试正则表达式时写下的英文独白**——一段关于 pattern、regex 和 edge case 的推理散文，被它自己的正则读成了「用户要求以后一直这么做」。

三处结构性修正：

- **谁写的文本，决定能声明什么**。`text.js` 的 `SOURCE_KINDS` 按来源限定可声明的信号类型；助手的叙述**不可能**再被读成用户偏好，而它如果要推动落盘，只能以「有效做法 / 技能有错 / 失败后修复」的身份。
- **没有一条模式匹配裸副词**。`REMEMBER_RE` 要求祈使句或习惯性框架（例如行首的 `^(?:always|never)\s+[a-z]`），单独一个 `always` 什么都不是。
- **判别权交回模型**。正则只给候选打分、排序、写进 `pending.json`；`remember()` 是唯一会碰技能文件的路径，而它只能由模型给出 `statement` 才会被调用。`skillfile.js` 里的常驻技能把这条分工写在第一段：**「正则只负责回忆和打分，不负责判断。」**

---

## 专属技能目录

用户要求「学到的技能收进自己的文件夹」。实现方式是**单独一个技能根**，不是共享根下的子目录。

### 为什么子目录做不到

宿主 provider `@deepseek-ai/dsh-skill-filesystem` 对一个技能根**只扫一层**：

```js
// dsh-skill-filesystem/lib/index.js
function isPotentialSkillPath(root, path) {
  const segments = ...;
  if (segments.length === 0 || segments.length > 2) return false;
  // 1 段 → 根下的 *.md；2 段 → <name>/SKILL.md
}
```

`<skills>/learned/<name>/SKILL.md` 是 **3 段**，直接出局；chokidar watcher 也用 `depth: 1`。也就是说：把技能塞进 `<skills>/learned/` 子目录，文件还在，但宿主的技能目录里**看不见它们**，`/技能名` 也加载不到。

### 为什么单独一个根可以，而且不需要动宿主配置

技能目录是一层**提供者**（`@deepseek-ai/dsh-skill` 的 `SkillRegistry`）的合并结果：每个提供者按 `rank` 从小到大参与合并，同名取 rank 小的。所以只要**有人**覆盖这个根就行。

“有人”很容易搞砸。最自然的做法是往 profile 的 `cordis.patch.yml` 里给宿主那个 `skill-filesystem` loader 条目加一条 `customSkillDirs`——**这条路是死的**，而且死得没有声音：

```yaml
# <profileDir>/cordis.patch.yml
- id: skill-filesystem
  name: "@deepseek-ai/dsh-skill-filesystem"
  config:
    customSkillDirs: ["<DSH_HOME>\\skills\\learned"]
```

- 这条补丁**会**合成进最终配置树，`--dump-config` 里看得到 `customSkillDirs` 确实在了；
- 但它落在的是 **host plane 那一行**，而 `@deepseek-ai/dsh-web-app` 早把这一行 `disabled: true` 了（它把每个 agent 的行挪到了 agent preset 后面，skill 注册表本身留在 host plane）；
- 顶层 id 补丁只覆盖它**重新声明**的键，`disabled: true` 原样留着。于是配置看着对，provider 从来没挂载过。

所以插件**不再向宿主申请**，而是自己当这个提供者：`lib/provider.js` 通过 `ctx.inject(['skills'], …)` 调用 `ctx.skills.registerProvider()`，把这个根读进技能目录。不需要改 profile、不需要重启，`rank` 取 330——排在 `custom` 根（300）之后、默认 `user-dsh` 根（400）之前，项目根（100/200）仍然优先。

代价是必须守宿主的提供者契约，而它很严：`validateCandidate` 对一行不合法就直接 **throw**，一次 throw 会让整轮 collect 失败，**所有根的技能一起消失**。所以 `list()` 只发射已经满足宿主语法的行，其它一律跳过，并且不向外抛错：

- 目录名不匹配 `^[a-z0-9]+(?:-[a-z0-9]+)*$` → 跳过；
- 没有 `SKILL.md`（或根本读不出来）→ 跳过；
- `description` 缺失或只有空白 → 跳过（宿主要求非空）。

根不存在时 `list()` 返回 `{ candidates: [], complete: true }`——空贡献，不是错误。

真实技能根就是：

```
<DSH_HOME>/skills/learned/
```

`lib/config.js` 的 `skillsRoot` 是 `<DSH_HOME>/skills`，`lib/skills.js` 只加**一层** `LEARNED_SUBDIR`，并且这一步是幂等的（根已经以 `learned` 结尾就不再追加）。`organize` 提供出去的、以及 `doctor` 检查的，都是 `skills.learnedDir` 这一个值。

### 安全线：没被证明能看见，就不搬

`learned` 这个根在技能目录里真的出现之前，写进去的技能等于**消失**。所以插件不假设注册成功，而是**问宿主的目录自己**：

1. 往 `skills.learnedDir` 写一个一次性探针技能 `learn-root-probe/SKILL.md`；
2. 先调用自己那个 provider 的 `invalidate()` 丢掉宿主的 collect 缓存（缓存按 `cwd + scope 链 + revision` 存，不丢的话刚写进去的文件会被旧的快照一直盖住），再调宿主的技能目录服务（`ctx.skills`，退路 `ctx.get('skills')`），最多轮询 4 次、每次间隔 150ms，看这个名字回不回来；
3. 无论成败都在 `finally` 里删掉探针目录。

只有探针通过（`skills.isLive() === true`）之后：

- 新技能才写进专属根；在那之前一律写共享根，照常可用；
- `migrateOwnSkills()` 才肯搬东西，并且只搬**本插件拥有的**技能（`managed.json` 里有记录，或属于三个内置伞）；
- 共享根里同时存在旧副本时，删掉旧副本——否则旧的会盖住新的。

共享根里用户手写的技能永远不动（`organize` 会把它们列在「不动这些」里）。

### 怎么用

```bash
# 先看会改什么（只探测，不搬）
learn action=organize dryRun=true
# 真收拢
learn action=organize dryRun=false
```

`organize` 会：

1. 报告技能提供者是否注册上（`已注册 —— 这个根由本插件自己提供，不需要改宿主配置`）；
2. 跑上面那条探测安全线：探针不通过就**到此为止**，一个技能都不搬；通过了才收拢，并逐个 `claim` + 写账本 `skill.organize`；
3. **不碰** `<profileDir>/cordis.patch.yml`——这条写入路径已经删掉了，插件不该为了自己的功能去改用户的应用配置。

`learn action=doctor` 的 `host-root` 检查比对的是「插件真实技能根」与「已注册的根」，并注明是不是由本插件自注册提供的。

---

## v0.1.0 的缺陷与 v0.2.0 的修法

审计出来的每一条，以及它是怎么修的：

| # | v0.1.0 的缺陷 | v0.2.0 的修法 |
|---|---|---|
| 1 | `REMEMBER_RE` 匹配裸的 `always` / `never` / `remember`，英文推理文本被读成用户偏好 | 助手文本只能声明 `TECHNIQUE` / `SKILL_WRONG` / `RECOVERED_FAILURE`（`text.js` 的 `SOURCE_KINDS`）；没有任何模式匹配裸副词 |
| 2 | `directive ⇒ actionable`：可执行性门槛形同虚设，600 字的漫谈也能算「可执行」 | `isActionable()` 改判**形状**：过程性文本，或者「带具体对象的短陈述」 |
| 3 | curator 自动路径是死代码：`onTurnStop()` 先 `lastEventAt = Date.now()` 再读它，空闲恒 ≈0；同时 `learn_curator status` 传 `idleMs = +∞` 打印「会」——工具和调度器答的是两个问题 | `curator.touch()` 单点记录活动，`idleMs()` 单点推导，curator 跑自己的 unref 定时器，status 工具调**同一个** `shouldRunNow()` |
| 4 | `delete` / `archive` 在提前 return **之后**才鉴权，能归档共享技能根里的任意目录 | 鉴权是第一句（`managed.canDestroy()`），依据 `managed.json` 加保护名单（`self-learning-loop` 与三把伞） |
| 5 | 写入路径零脱敏零筛查（`desensitize()` 只在 capture 里跑，`escapeBraces()` 是死代码） | `sanitize.js` 在 `skills.write` 与 `store.appendLesson` 内部筛查；注入形状的文本直接拒收 |
| 6 | `DESCRIPTION_LIMIT = 60` 是个错的宿主常量（真实预算 500），还静默切掉路由词 | 预算改回 500；超出时在 create 阶段**显式拒收**，不裁剪 |
| 7 | `review.promoteScore` / `review.cooldownMs` / `generate.requireGates` / `generate.namePrefix` / `generate.updateOwnOnly` 全是没人读的安慰剂配置 | 删除。规则：**加一个键，必须同时加它的读者** |
| 8 | `learn_review` 的 `minScore` 是死参数且语义反转（`force = args.minScore === undefined`） | 现在是真实阈值 |
| 9 | `withLock` 在争用时**不持锁**直接跑回调，两个会话的读-改-写互相覆盖，一方的工作静默消失 | 争用时重试，超时抛错；`updateState` / `updatePending` 在同一把锁里做完整的读-改-写 |
| 10 | `defer()` 无条件写 `hits: 1`，「同一教训两次合并」从来没发生过 | 真实命中计数（`hits`、`lastAt`、sessions 上限 10） |
| 11 | `managed-by` 被盖进 SKILL.md 的 frontmatter：污染用户自己写的文件，手工一改就丢，而且随便就能伪造 | 归属搬到 `managed.json`，使用遥测搬到 `usage.json`，frontmatter 还给用户 |
| 12 | `used_skills: 0`：技能使用量是靠对工具结果跑正则猜出来的 | 真的加载才计数：`tool/result` 里 `skill` 类工具成功且技能存在，才在 sidecar 记一次并写 `skill.load` 账本 |

审计之后、在自测里又抓出来的（这些是 v0.2.0 自己的 bug，不是 v0.1.0 的）：

| # | 缺陷 | 修法 |
|---|---|---|
| 13 | `capture.js:151/155` 读 `config.capture.ignoreTools` 与 `recordSuccesses`，而 `config.js` 里**根本没有这两个键**——第一个 `tool/result` 事件就抛 `TypeError`，工具观测永远进不了窗口 | 两个键补成真配置（`ignoreTools` 默认 `[]`、`recordSuccesses` 默认 `false`），并全面核对每一处 `config.*` 读取都有对应键 |
| 14 | `skills.write()` 在已经以 `learned` 结尾的根上再拼一层 `learned`，落点是 `skills/learned/learned/` | 幂等：根以 `learned` 结尾就不再追加 |
| 15 | `curator` 调 `ledger.append()`，而 `createStore` 只导出 `appendLedger` / `readLedger`——第一次真正的维护就 `TypeError` | 统一走 store 的方法（本地适配器接受两种形状） |
| 16 | 自动路径的 gate 相信调用方给的 `kind`：一句 `I'm checking how the always pattern matches` 能把六项检查全拿 ok | `SELF_NARRATION_RE` 对**所有**路径生效；`classifyText` 另补「有过程形状但没命中词库」的技术回退 |
| 17 | 迁移无条件把技能搬进专属根——而宿主只扫一层，没登记的根里技能等于消失 | 「先证明再搬」：探针问宿主目录，通过了才写进去/搬；且只搬本插件拥有的技能 |
| 18 | `isMostlyRedacted()` 是个裸长度判断，任何短的合法技能正文都被判成「脱敏后没内容」而拒收 | 先要求真的出现过脱敏占位符，再按码点计数 |
| 19 | 技能名校验比宿主松（允许 `_`、`.`、首尾连字符），这些名字插件照写，宿主**静默忽略**——技能看起来存好了，其实不在目录里 | `NAME_RE` 直接抄宿主的 `@deepseek-ai/dsh-skill` 常量 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`，拒收理由里点名这是宿主的规则 |
| 20 | 时钟字段按一种形状硬读：v0.1.0 存的是 ISO 字符串，而 `Number("2026-…Z")` 是 `NaN`，`!NaN` 又是 `true`——curator 的间隔门槛被永久绕过；`new Date(脏值).toISOString()` 还会直接 RangeError | 统一的 `toMillis()` 接受数字/ISO/Date，读不动的算 0；快照里的时间一律先规范化再格式化 |

### v0.2.1：把插件放到真实对话里跑，它又露了一次原形

上面 20 条是读代码和单元测试发现的。把跑了一整天的真实会话喂回去重放之后，又抓出 6 条——
它们有同一个共同点：**测试夹具是我照着 schema 编的，而真实事件流不长那样。**

| # | 症状（真实数据里的原话） | 修法 |
|---|---|---|
| 21 | 工具观测全是匿名的：真实 `tool/result` 事件**不带工具名**，只有 `message.source.callId`。于是每条教训长成 `": Error: old_string was not found in …"`——没有工具前缀，「同一个工具先失败后成功」的恢复配对（`other.tool === tool`）**永远不可能命中** | `extract.js` 加一张 callId → `{name, args}` 的登记表：`tool/call` 事件先 `noteCall()` 登记，`tool/result` 再按 callId 反查；`failed()` 同时认 `message.isError` 和 `[exit code: 1]` |
| 22 | 助手的过程叙述照样过关。旧判据是六个短语（`I'm checking` / `the false positive` / …），而真实的规划文体是 `Now let me …`、`Found … — that defines …`、`I'll …`、`the user wants …`，一个都不沾 | 换成语法级判据：`AGENT_DELIBERATION_RE` 认第一人称意向、`let me`、规划连接词、报告式开头；新增 `looksLikeCommandDump()` 直接认出脚本原文 |
| 23 | 「复述一次事故」被当成可迁移的做法：`Small subdir recycling works once the process cwd is set to C:\. So the earlier failure was because …`——它没有任何规划标记，还因为 `\bset\s+\w+` 被 `PROCEDURAL_RE` 判成过程性 | 新增 `INCIDENT_REPORT_RE` / `looksLikeIncidentReport()`，进 `gateObservation` 与 `no-incident` 门。**故意不收录** `was because` / `原因是` 这类通用因果词——第一版收了，结果把一条合法教训（`bash 报错 ENOENT …, 原因是工作目录不对`）也拒了 |
| 24 | 插件把自己的自测输出当成「已恢复的失败」收进队列：`274/276 checks passed, 2 FAILED …` 以 RECOVERED_FAILURE（权重 4）入队 | 新增 `STATUS_REPORT_RE`（`N/M passed`、`[exit code: N]`、`N failing`）与 `ERROR_SHAPE_RE`，工具来源的恢复类教训必须**读得出具体报错**才算数 |
| 25 | `hits` 统计的是**审查次数**不是佐证次数：`runReview` 每个 tick 重读整个窗口、重复提交同一候选，5 分钟内 `hits` 涨到 5/4/7/20，账本堆了 124 行一模一样的 `review.refuse` | 观测带 `filed` 标记，`proposals()` 跳过已提交项，`capture.markFiled()` 在提交/拒收后记账；拒收也记账——**一条被否过的候选不该每个 tick 再审一遍** |
| 26 | 最有价值的自动信号从来没触发过：后来的成功只把早先的失败标 `resolved = true`，却不提升 `kind`，所以「这里坏了、这样修好的」永远变不成 RECOVERED_FAILURE；更糟的是旧循环在**当前调用失败**时去把别的失败标成已解决 | `recordToolResult` 重写：失败进窗口；同工具的成功**就地提升**每一条未解决的失败（`kind`→RECOVERED_FAILURE、`weight` 取大、`fixedBy` 存下修复文本、清 `filed` 让它重新可提交）；反过来的那段循环删掉 |

真实会话重放的结果（6,223 事件 / 31 用户 / 992 助手 / 1,050 工具）：dry run `observations: 78`，
真跑 `filed: 2`，两条都是真的工具恢复教训（`edit: Error: old_string was not found in …` 和
`edit: Error: old_string matched 2 times …; provide a more specific old_string or set replace_all to true`），
其余全部带着具名理由被拒。修 callId 之前，同样一次重放产出的是匿名的 `": Error: …"`。

### v0.2.2：专属根不再求宿主，改成自己提供

两个症状（`learned_root_live: false`、`durable-preferences` 一直显示 `external` 没被收编）其实是同一个病：
插件一直在**请求宿主**把 `<DSH_HOME>/skills/learned` 登记成技能根——往 `<profileDir>/cordis.patch.yml` 里加一条
`customSkillDirs`。那条补丁能被 loader 合并，却什么都不会发生：它落在宿主平面那一行 `skill-filesystem`
（`@deepseek-ai/dsh-web-app` 把它设成 `disabled: true`），而顶层 id 补丁只覆盖它自己重述的键。

改法是插件**自己**提供那个根：`lib/provider.js` 用 `ctx.inject(['skills'], …)` 拿到 `skills` 服务，
再 `registerProvider()` 注册一个只扫专属目录的提供者，`rank: 330`——夹在 `custom`(300) 与 `user-dsh`(400)
之间，所以学到的技能压得住共享根里的旧副本，而项目根（100/200）仍然优先。
这条路的形状决定了模块的写法：`@deepseek-ai/dsh-skill` 的 `validateCandidate` 在遇到畸形行时是 **throw**，
一次 throw 会打断整个 collect，**所有根里的所有技能一起消失**——所以 `list()` 必须自己把宿主会拒的行全部过滤掉
（名字不合 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`、没有 `SKILL.md`、描述为空……），而不是指望宿主容忍。

### v0.2.3：三处「输出比实际乐观」的谎

代码改对了，但工具**说**的话还停留在旧设计上。三条都是看着真实输出抓出来的：

| # | 症状 | 修法 |
|---|---|---|
| 27 | `learn action=doctor` 永远红着：`legacy` 检查是纯按位置的（`legacy: !inLearned(name)`），于是用户手写、插件**永远不该搬**的技能（`zz-user-probe`）让自检一直报 `自检发现问题` | 判据改成归属：只有 `managed.isManaged(name)` 或 `BUILTIN_PROTECTED` 里的遗留项才算异常；不是自己的，明说「位置由你说了算，不动」 |
| 28 | 同一个 doctor 在 `host-root` 失败分支里，还在教用户去改 `cordis.patch.yml` 加 `customSkillDirs`——那条路在 v0.2.2 里已经删掉了，用户照着做只会白忙 | 改成 provider 的说法（注册发生在 `ctx.skills.registerProvider()`；改完重启 DSH；还是不行说明宿主 `skills` 服务没就绪） |
| 29 | `learn action=status` 给共享根里的**别人**的技能打 `待收拢` 标签，等于承诺一次 `organize` 永远不会做的搬迁 | 标签的条件从 `legacy && live` 收紧到 `legacy && live && 归属是自己`，与 `organize` 的真实行为对齐 |

---

## 磁盘布局

```
<DSH_HOME>/
├── skills/
│   ├── learned/                     # 专属技能根（由 lib/provider.js 自己提供）
│   │   ├── self-learning-loop/SKILL.md     # 插件自己的常驻技能，激活时写入
│   │   ├── durable-preferences/SKILL.md    # 伞：用户长期偏好
│   │   ├── tool-recovery/SKILL.md          # 伞：工具/命令失败后的排查与恢复
│   │   └── environment-facts/SKILL.md      # 伞：环境与项目约定
│   ├── <本插件还没搬过来的技能>       # 探测通过前的新技能、用户自己写的技能
│   └── <其它技能根，不归本插件管>
├── learn/data/                      # config.dataDir
│   ├── state.json                   # 计数器、curator_last_run_at、curator_pinned、暂停位、learned_root_live
│   ├── ledger.jsonl                 # 账本：每一次写、拒、归档、加载
│   ├── pending.json                 # 候选队列 {version, updatedAt, items}
│   ├── lessons.jsonl                # 落盘过的教训（create / reinforce）
│   ├── managed.json                 # 归属清单：哪些技能是这个插件建的
│   ├── usage.json                   # 使用遥测：loads / firstAt / lastAt / sessions
│   ├── learning-graph.json          # 学习图（技能 / 教训 / 候选 / 灵枢 memory 节点）
│   ├── last-error.log               # 内部警告（锁回收、写入被拒等）
│   ├── .lock                        # 写锁（openSync 'wx'）
│   ├── archive/skills/<name>/       # 归档区：移动过来的，从没被删过
│   └── reports/
└── .dsh-memory/data/mdcg/contextual # 灵枢 memory 节点来源（没有就跳过，不报错）
```

只有三个伞技能是长期存在的写入目标；`kind` 路由不到伞的教训**不会**新建技能，只留在账本里。

---

## 五个工具

| 工具 | 用途 | action | 主要参数 |
|---|---|---|---|
| `learn` | 状态、检索、候选、历史、撤销、整理、体检、图、写笔记 | `status`(默认) / `list` / `view` / `pending` / `history` / `undo` / `consolidate` / `organize` / `doctor` / `graph` / `note` / `pin` / `archive` / `restore-pending` | `name`、`ruleId`、`statement`、`kind` ∈ `remember-request` `user-preference` `user-correction` `durable-fact` `technique` `recovered-failure` `skill-wrong`、`session`、`umbrella` ∈ `durable-preferences` `tool-recovery` `environment-facts`、`pinned`、`adopt`、`dryRun`、`query`、`fp` |
| `learn_review` | 手动跑一次回合后审查 | `run` / `dry-run`(默认) | `session`、`minWeight` |
| `learn_curator` | 生命周期维护 | `status` / `run` / `dry-run` / `pause` / `resume` | `force` |
| `learn_skill_manage` | **唯一被校验的技能文件写入口** | `create`(默认) / `update` / `read` / `delete` / `archive` | `name`、`description`、`whenToUse`、`summary`、`conditions`、`steps`、`pitfalls`、`verification`、`notApplicable`、`body`、`overwrite`、`adopt` |
| `learn_skills` | 语义检索（只看，不写） | — | `query`（必填）、`limit`（默认 5，夹在 1–20） |

几个约定：

- `learn action=note` 与 `learn_skill_manage create` 的差别是**落点**：前者往三把伞里加一条规则（走 `review.remember()` 的门槛与去重），后者是独立技能文件。
- `learn_skill_manage` 的 `description` **必填**——它是未来唯一的路由信号；超过 500 字会**拒收**（不是截断），理由里直接说「被截掉的往往正是触发词」。
- `learn_skill_manage create` 撞上已有技能时：本插件自己建的要 `overwrite=true`；**不是它建的**（不在 `managed.json`）要 `adopt=true`，否则拒绝覆盖用户自己写的技能。
- `delete` / `archive` 的鉴权是函数第一句；`archive` 是移动，`delete` 才真的删，两者都写账本（`skill.archive` / `skill.delete`）。
- `learn` 与 `learn_skills` 是并发安全的（只读），其余三个不是。
- `consolidate` 与 `organize` 默认 `dryRun=true`，要看真动作得显式关掉。

---

## 五道门，以及拒收怎么读

写库前过的是 `review.js` 的 `gatesFor()`，它按顺序产出**六项检查**。模型可见的词汇是「**五道门**」（`blocks.js` 的 `CANDIDATE_GATES`），第六项 `routed` 是伞路由检查，不属于那五道门：

| 检查 | 拒绝什么 | 拒收理由（逐字） |
|---|---|---|
| `general`（可迁移） | 短于 8 字或长于 400 字的陈述 | `陈述过短` / `陈述过长（>400 字）` |
| `actionable`（可执行） | `gateObservation()` 里带「可迁移」或「具体对象」字样的理由 | `读不出可迁移的做法或具体对象` |
| `durable`（持久） | 恒定通过——持久性在分类阶段就保证了 | — |
| `no-incident`（无事故绑定） | 含 `PR/issue/ticket #N` 或 `YYYY-MM-DD` 日期 | `含日期或工单号` |
| `routed`（伞路由） | `classifyRoute()` 给不出伞的教训（**不新建技能**） | `没有匹配的类级技能（不新建技能）` |
| `novel`（非重复） | 恒定通过——真正的去重在写入时用 `tokenSimilarity ≥ 0.6` 做强化 | — |

更早一层还有 `text.js` 的 `gateObservation()`，它的理由是拒收文本的正源：

```
没有可记录的陈述 / 陈述过短，信息量不足 / 陈述过长（>400 字） / 几乎全是脱敏占位符
失败尚未解决，先不落盘（解决后再记做法）
看起来是一次性要求，不是通用规则
属于环境状态（缺依赖/未配置/无权限），用户可修复，不记为长期规则
只有否定断言、没有可迁移的做法或具体对象
缺少可迁移的做法或具体对象（不是一条能照做的规则）
```

**读拒收**：`learn action=pending` 列出候选，每条带 `[可写入]` 或 `[未过门槛]`，未过的直接给 `未过原因：…`；`learn action=history name=<技能>` 看某个技能上发生过的写/强化/合并/撤销与拒收（`review.refuse` 在账本里）。

内容卫生（`sanitize.js`）在**字节落地的地方**执行，调用方无法绕过：私钥/令牌/JWT/邮箱/手机号/身份证/密码类值一律脱敏（`[已脱敏]` 占位），`{{` 转义成 `{ {`，超过 240 字的非代码行硬折行，正文上限 65536 字节 / 1200 行，命中指令注入特征（伪造角色标头、`ignore previous instructions`、`you are now …`、要求对用户隐瞒……）**直接拒收**——因为学到的技能会被自动加载进未来每一个会话，这类文本只能当引用，不能落盘。

---

## 安装与激活

插件就是一个普通目录，放在 profile 的 `node_modules` 里（profile 用 `nodeLinker: hoisted`，不需要 workspace 链接）：

```
<profileDir>\
├── package.json              # dsh.profile.bundles 里列出 "dsh-learn"
├── cordis.patch.yml          # 你自己的 loader 配置；本插件不写这个文件
└── node_modules\dsh-learn\   # 本插件的普通目录
    ├── package.json          # dsh.bundle.patch: "./cordis.patch.yml"
    ├── cordis.patch.yml      # bundle layer：insert 一个 id: dsh-learn / name: 'dsh-learn'
    └── lib\index.js
```

插件自带的 bundle patch 只有一件事：

```yaml
- insert:
    - id: dsh-learn
      name: 'dsh-learn'
```

### 两个会静默毁掉激活的陷阱

**(a) 对 `@deepseek-ai/dsh-*` 声明任何 `peerDependencies`，整个 bundle 会被跳过。** 宿主的 `evaluatePluginCompatibility` 在兼容性判定里会因此跳过整个 bundle——不报错，就是不激活。所以本插件的 `package.json` **没有 `peerDependencies`**；`@deepseek-ai/dsh-tools` 只是可选导入（`loadDefineTool()` 里 try/catch，拿不到就用普通定义注册工具）。

**(b) 导出一个普通的 `Config` 对象会抛 `TypeError: Cannot read properties of undefined (reading 'validate')`。** Cordis 在调用任何东西之前先读 `runtime.Config["~standard"]`，一个没有 schemastery 的 schema 对象比没有 schema 更糟。所以 `lib/index.js` **故意不导出 `Config`**：没有 schema 时 Cordis 把 patch 层的原始对象交给 `apply`，而 `normalizeConfig()` 已经逐字段校验并夹紧了每个值。

### 激活后的自检

```bash
learn action=status      # 技能根、受管技能数、候选数、curator 会不会跑
learn action=doctor      # root / skills / host-root / legacy / budget / sidecar 六项体检
```

`host-root` 检查就是在比对「插件真实技能根」与「已注册给技能目录的根」：没过就说明这个文件夹还没被任何提供者覆盖，文件在，但技能目录里看不到，也加载不了。

---

## 配置

`normalizeConfig()` 会解析相对路径（相对 `<DSH_HOME>`，绝对路径原样保留）并夹紧每个值。

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 关掉后 `apply` 直接返回，一个工具都不注册 |
| `skillsRoot` | `<DSH_HOME>/skills` | 技能根的**父**目录；真实的根是它下面的 `learned/`（`skills.learnedDir`） |
| `legacySkillsRoot` | `<DSH_HOME>/skills` | 共享根：专用根被宿主确认可见之前的落点，也是 `organize` 的迁移源 |
| `dataDir` | `<DSH_HOME>/learn/data` | 状态、账本、候选、归档 |
| `capture.maxSessions` | `8` | 内存里同时保留几个会话的窗口（LRU） |
| `capture.maxItemsPerSession` | `120` | 单会话观测上限 |
| `capture.maxItemChars` | `400` | 单条观测压缩后的字符上限 |
| `capture.ignoreTools` | `[]` | 不记工具结果的工具名（默认空：一刀切的黑名单会连真恢复一起藏掉） |
| `capture.recordSuccesses` | `false` | 是否把成功的工具调用也记进窗口 |
| `review.minWeight` | `2` | 低于此权重的观测不进候选 |
| `review.maxProposals` | `8` | 一次审查最多提几个候选 |
| `review.triggerObservations` | `3` | 窗口里有多少条观测才值得跑审查 |
| `review.ruleBudget` | `24` | 一把伞的规则软上限，到了会提示先 `consolidate` |
| `review.similarity` | `0.6` | 去重/强化的相似度阈值 |
| `curator.staleAfterDays` | `14` | 超过多少天没被加载 → `stale` |
| `curator.archiveAfterDays` | `30` | 超过多少天没被加载 → 归档（移动，不是删） |
| `curator.minIdleHours` | `2` | 空闲门槛：会话活跃时不整理 |
| `curator.intervalHours` | `24` | 两次维护的最小间隔 |
| `curator.pinned` | `[]` | 被 pin 的技能跳过一切自动流转 |

`dshHome` 的解析顺序：`config.dshHome` → `config.dsh_home` → 环境变量 `DSH_HOME` → `~/.dsh`。

---

## 自测

```bash
node scripts/selftest.mjs
```

`scripts/selftest.mjs` 是**独立、零依赖**的纯断言脚本（`check(label, condition, extra)`，失败即 `process.exit(1)`），17 节：脱敏与注入筛查、写锁与状态、专属根与规则手术、P0-1 回归与反捕获门槛、**真实对话里的假阳性回归**、观测窗口、**真实事件流与 callId 配对**、候选→确认→强化→合并→撤回、归属与销毁权、curator 生命周期、工具边界、**探针（宿主说了算）**、**提供者契约（`validateCandidate` 不允许一行出错）**、迁移（看得见才搬 / 旧副本不能遮蔽新根）、常驻技能文件、真实签名解析。它**不碰真实的 `~/.dsh`**：每一节用 `<插件目录>/.selftest-home/<节名>` 做一次性的 DSH home。

两件与真机安全有关的事：

- 它在模块加载时就把 `process.env.DSH_PROFILE_DIR` 指向沙箱里的假 profile（并删掉 `DSH_PROFILE`），然后断言 `organize` **没有**动过那个文件——插件现在不该写用户的 profile 补丁，这条断言就是防止它退回去。
- 成功时删掉沙箱，失败时保留现场供检查。

当前实际状态：

```
358/358 checks passed — all green
```

「真实对话里的假阳性回归」那一节把**跑挂过插件的原话逐字抄进去**当夹具（含那 240 字的 PowerShell 脚本原文、
`Now let me look inside D:\AI\deepseek-harness…`、`Small subdir recycling works once the process cwd is set to C:\…`），
断言它们在自动路径上**既不成教训、也过不了门**。「真实事件流与 callId 配对」那一节的事件形状是从真实
`session.v4.jsonl.zstd` 里抄的——夹具要是照 schema 编，就会把工具名放到结果事件上，然后**在坏的读取器上全绿通过**。

另外几个脚本：

| 脚本 | 用途 |
|---|---|
| `scripts/selftest.mjs` | 17 节断言，`npm test` |
| `scripts/replay-session.mjs` | 把**真实会话重放**给插件：`node scripts/replay-session.mjs --latest 1`。会话文件是一串**逐次追加拼接的 zstd 帧**，`zstdDecompressSync` 只解得出第一帧——脚本按 magic `28 b5 2f fd` 逐帧解再拼。这是最有说服力的验收方式 |
| `scripts/purge-noise.mjs` | 用**插件自己的** `review.gatesFor()` 重判队列里的每条候选（清理工具不该有自己的质量主张），并合并账本里重复的拒收行。默认 dry-run，`--apply` 才写 |
| `scripts/cleanup-v010.mjs` | 清 v0.1.0 的脏数据：frontmatter 里的 `managed-by`/`learn.*` 遥测、伞技能里那段插件自己的英文独白规则、旧形状的裸数组 `pending.json`、账本/lessons 里关于插件自己的散文；**没有 v0.1.0 标记的用户技能一律 SKIP**。另外把数据目录从 `<DSH_HOME>/learn/` 搬到 `<DSH_HOME>/learn/data/`（`state.json` 按键合并，新值优先） |
| `scripts/asar-inspect.mjs` | 读宿主 `app.asar` 的排查工具。注意 asar 头里每项的 `offset` 是**字符串**，用 `typeof === 'number'` 判会把所有条目静默跳过 |


---

## 设计不变量

- **永不注入、永不改写系统提示词或历史。** 插件只读 `session/event`；这是宿主的 prompt-cache 不变量，也是它零额外模型调用的原因。
- **学到的技能就是普通的 DSH 技能**，不是第二套注册表、不是私有格式。能被宿主的技能目录扫到，能被 `/名字` 加载，也能被别的工具读。
- **每个破坏性操作都先校验、后留痕。** 鉴权（`managed.canDestroy()`）是第一句；成功与否都写 `ledger.jsonl`。
- **归档从不删除。** `archive` 是把目录移出活动根，随手移回来就能恢复；只有显式的 `delete` 才真的删。
- **不显式 `adopt` 就永远不碰不是自己创建的技能。** 技能根是多个来源共享的，自动流程只碰 `managed.json` 里记着的那些；保护名单（`self-learning-loop` 与三把伞）连显式操作都拒绝归档。
- **空闲才维护，用户回合永远优先。** curator 跑自己的 unref 定时器，审查在回合边界只调度、不阻塞。
