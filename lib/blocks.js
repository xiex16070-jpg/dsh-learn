/**
 * The curator's contract, as text the tool reports verbatim.
 *
 * This module used to hold eight more blocks (`SKILL_QUALITY`, `DO_NOT_CAPTURE`,
 * `MEMORY_ROUTING`, `REVIEW_STANCE`, `REVIEW_SIGNALS`, `REVIEW_PREFERENCE_ORDER`,
 * `PROTECTED_SKILLS`, `READ_BEFORE_WRITE`), two renderers that concatenated them
 * (`renderQualityBrief`, `renderRoutingBrief`), and a `CANDIDATE_GATES` list.
 * NOTHING CALLED ANY OF IT. They had been ported from the Codex-era design and
 * still described things this plugin does not have — a user-side/environment-side
 * memory split, a hub, `external_dirs`, and a read-before-write guard. The text
 * was plausible, which is exactly why it survived: it read like documentation of
 * the system while documenting a different system.
 *
 * The parts worth keeping were already reachable elsewhere: the routing priority
 * and the anti-capture list live in the always-on skill file (`lib/skillfile.js`),
 * which the host loads through the ordinary skills pipeline. The gate vocabulary
 * lives in `lib/text.js`, where the gates are actually implemented — and it has
 * SIX entries, because `routed` was added; the deleted `CANDIDATE_GATES` still
 * listed five, so the doc had drifted from the code as well as from the call graph.
 *
 * Rule: a string that no code path can reach is not documentation, it is a
 * second version of the truth that only drifts.
 */

/** Curator transitions, reported verbatim by the tool so behaviour is legible. */
export const CURATOR_INVARIANTS = [
  '只碰本插件管理的技能；从不删除，只归档（可恢复）',
  '被 pin 的技能跳过一切自动流转',
  '首次运行只播种时间戳并推迟一个周期，避免全新安装时改动技能库',
  '空闲触发，每 10 分钟问一次是否到期；真正跑不跑由空闲与周期两道闸门决定',
];
