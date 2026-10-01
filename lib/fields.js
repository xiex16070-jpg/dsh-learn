/**
 * Small shared vocabulary: the field names the model sees, and the labels the
 * ledger uses. Keeping them in one place means a report, a tool result and a
 * pending entry always describe the same thing the same way.
 */

export const SUMMARY_FIELDS = [
  { field: 'statement', meaning: '一条可迁移的规则或事实，独立成立，不含日期/工单号/用户原话' },
  { field: 'umbrella', meaning: '归属的类级技能；为空说明它还不该成为技能' },
  { field: 'kind', meaning: '信号类型：用户纠正 / 记住指令 / 用户偏好 / 工具失败 / 环境事实 / 技术手法' },
  { field: 'resolved', meaning: '失败是否在本次会话里真的被修好；未修好的不写成规则' },
  { field: 'gates', meaning: '五道门：可迁移 / 持久 / 无事故绑定 / 可执行 / 非重复' },
];

export const OUTCOME_FIELDS = [
  { outcome: 'created', meaning: '新建了一个类级技能（此前没有覆盖这个类别的技能）' },
  { outcome: 'extended', meaning: '在已有类级技能里原地加了一条规则' },
  { outcome: 'duplicate', meaning: '同一条教训已经在技能里，什么都没写' },
  { outcome: 'pending', meaning: '没通过五道门，留在候选区等人/等更多证据' },
  { outcome: 'skipped', meaning: '按策略明确不记（环境态失败、未解决的失败、没有可归入的类）' },
];
