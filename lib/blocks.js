/**
 * The instruction contracts, ported to DSH vocabulary.
 *
 * These strings are the *policy* half of the mechanism: they define what a
 * learned skill is, what must never be captured, and how a lesson is routed.
 * Two consumers read them:
 *   1. the deterministic reviewer (`review.js`), which applies them literally, and
 *   2. the model-facing tools, which report them so a foreground session can
 *      apply the same judgement with better information than any heuristic.
 */

export const SKILL_QUALITY = `什么算一个技能：一类任务最快的正确做法——步骤、能用的工具与命令、顺序、用户对结果的偏好、以及花过时间的坑。未来会话照着它做，第一次就该做出用户想要的东西。
- 先写过程（具体命令、决策点），不是本次会话的叙事。
- 坑 = 一条可迁移的规则 + 一句“为什么”（机制），用祈使句。
  例：改公共函数签名前，先在测试树里搜这个符号——手写的 mock 会复制旧签名，在没有跑到的分片里失败。
- 不写 PR/issue 号、日期、工单号，也不引用用户原话：规则要能脱离那次事故独立成立。
- 同一个教训学到两次，就是一条规则。
- 不重复环境已经教过的东西：仓库里的 AGENTS.md、工具 schema 描述、其他常驻上下文。
- 常驻规则整体写进 SKILL.md；只有“偶尔才需要”的深度内容才另开 references/，按主题命名，绝不叫 <日期>-<事故>.md。
- 技能写错了就原地改那句话，不要在下面追加“更新：其实……”。`;

export const DO_NOT_CAPTURE = `不要落盘的（它们会变成以后环境一变就反过来咬你的自我约束）：
- 环境态失败：缺二进制、全新安装报错、迁移后路径不匹配、command not found、凭据没配、包装不上。用户能修，所以不是持久规则。
- 对工具或功能的否定断言（“浏览器工具用不了”“X 坏了”“execute_code 里不能用 Y”）。它们会硬化成几个月后你拿来拒绝自己的理由。
- 会话内自行消失的瞬时错误。重试就好了的话，教训是重试这个模式，不是原来那个失败。
- 一次性任务叙事。
- 未解决的失败：如果会话结束时并没有真正找到可用办法，就不要把这些尝试写成“可靠流程”或“推荐做法”——那等于把一串没验证过的失败冒充成经验，未来会话会照着重犯。要么说“没什么可存的”，要么只在你独立确信存在真实可行替代方案时，只记那条替代方案，绝不记死胡同。
如果某工具因为环境状态失败，就记“修法”（安装命令、配置步骤、环境变量），放在已有的安装/排障技能里，不要单独立一条“这个工具不行”。`;

export const MEMORY_ROUTING = `两类落点，每条事实只进一个：
- 用户是谁（人设、偏好、沟通与工作风格、明确提出的期望）→ 用户侧记忆。
- 你所在环境的事实（工具怪癖、项目约定、配置坑、重要的路径与端点）→ 环境侧记忆。
同一条事实写两处会把两边都撑爆，把真正重要的挤掉；写错地方，下一个会话就不会去那儿找。`;

export const REVIEW_STANCE = `审查上面的会话，更新技能库。要主动——多数会话至少会产生一点技能更新，哪怕很小。一次什么都没做，是漏掉的学习机会，不是中性结果。
但“没什么可存的”是真实选项，不该是默认：如果会话顺利、没有被纠正、也没有产生新技术，就说“没什么可存的”然后停。否则就动手。`;

export const REVIEW_SIGNALS = `值得动手的信号（命中任意一条就够）：
- 用户纠正了你的风格、语气、格式、可读性或啰嗦程度。“别这么做”“太啰嗦了”“别这么排版”“为什么你在解释”“直接给我答案”“你总是 Y，我很烦”，以及明确的“记住这个”，都是一等一的技能信号。
- 用户纠正了流程、做法或顺序 → 写成坑或一个明确步骤。
- 出现了非平凡的技术、修法、绕行、排查路径或工具用法，未来会话用得上。
- 本次会话加载或查阅过的技能被证明是错的、缺步骤或过时的 → 现在就改。`;

export const REVIEW_PREFERENCE_ORDER = `落点优先级（选最早能装下的那个）：
1. 更新本次会话真正加载/查阅过的技能；仅当它由本插件管理时才可写。
2. 更新已有的同类伞形技能（先 list，再 view）。
3. 在已有伞下加支撑文件：references/<topic>.md（按主题，别按会话）、templates/、scripts/；并在 SKILL.md 里加一行指路。
4. 确实没有覆盖这个类别的技能时，才新建类级伞形技能。
名字必须是类级的：不能是某个 PR 号、错误字符串、功能代号、库名，或 fix-X / debug-Y / audit-Z-today 这类会话产物。`;

export const PROTECTED_SKILLS = `以下技能自动流程不得改动：
- 仓库自带（bundled）、从 hub 安装、external_dirs 里的技能；
- 被 pin 的技能——pin 完全禁止自动写入（连内容更新也不行），因为当场没有用户能同意；只有前台会话能改；
- 用户自有的技能（手写、从 URL 安装、或应前台用户要求创建的）。对它们的写入会被拒绝，包括本次会话加载过的。
如果唯一需要改的技能都是受保护的：说“没什么可存的”然后停。`;

export const READ_BEFORE_WRITE = `写之前必须先读（强制）：
- 改/替换已有 SKILL.md 之前，必须在本次审查里先 view 过它；
- 覆盖/删除已有支撑文件之前，必须先 view 过那个确切文件；
- 会话记录里引用过的内容不算；
- 新建技能、新建支撑文件不需要先读。
被读写守卫拒绝时：view 一次目标、重试一次、不要循环。`;

/** Anti-capture gate: the five questions a candidate must answer yes to. */
export const CANDIDATE_GATES = [
  { id: 'general', label: '可迁移', detail: '它是一条一般规则，不是“这一次发生了什么”' },
  { id: 'durable', label: '持久', detail: '下个月环境变了它仍成立，不是某个可修复的临时状态' },
  { id: 'no-incident', label: '无事故绑定', detail: '不含日期、PR/工单号、用户原话、一次性叙事' },
  { id: 'actionable', label: '可执行', detail: '能写成祈使句的动作或判断点' },
  { id: 'novel', label: '非重复', detail: '没有已被现有技能、AGENTS.md、工具描述覆盖' },
];

/** Curator transitions, reported verbatim by the tool so behaviour is legible. */
export const CURATOR_INVARIANTS = [
  '只碰本插件管理的技能；从不删除，只归档（可恢复）',
  '被 pin 的技能跳过一切自动流转',
  '首次运行只播种时间戳并推迟一个周期，避免全新安装时改动技能库',
  '空闲触发，没有常驻定时器；用户前台回合永远优先',
];

export function renderQualityBrief() {
  return [REVIEW_STANCE, '', SKILL_QUALITY, '', DO_NOT_CAPTURE].join('\n');
}

export function renderRoutingBrief() {
  return [MEMORY_ROUTING, '', REVIEW_SIGNALS, '', REVIEW_PREFERENCE_ORDER, '', PROTECTED_SKILLS, '', READ_BEFORE_WRITE].join('\n');
}
