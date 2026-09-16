/**
 * 论坛 · 常量与固定清单
 *
 * 汇总五份交接报告里"钉死"的枚举/文案，全部原样落地，不在这里做二次设计。
 * 出处标注方便以后追查：
 *   [交接1] 交接报告_论坛类型定稿_2026-09-15.md
 *   [交接2] 交接报告_账号与掉马机制_2026-09-15.md
 *   [交接3] 交接报告_论坛NPC人设与圈子机制_2026-09-16.md
 *   [交接4] 交接报告_论坛生成合并机制与调用规则_2026-09-16.md
 *   [交接5] 交接报告_论坛记忆接入与UI排版_2026-09-16.md
 */

import { getProfessionInfo, type SimProfession } from './lifeSimEngine';

// ==================== 一、话题分类 [交接1 2.4，最终17项由后续讨论定稿] ====================

export type ForumTopicTag =
  | 'social_affairs' | 'film_reading' | 'tech' | 'finance' | 'gaming'
  | 'relationships' | 'school_work' | 'humor' | 'gossip' | 'daily_chatter'
  | 'hobbies' | 'fitness' | 'wellness' | 'food' | 'imagination'
  | 'mystic' | 'science_pop';

export const FORUM_TOPIC_TAGS: { tag: ForumTopicTag; label: string }[] = [
  { tag: 'social_affairs', label: '社会时事' },
  { tag: 'film_reading', label: '电影阅读' },
  { tag: 'tech', label: '科技数码' },
  { tag: 'finance', label: '财经' },
  { tag: 'gaming', label: '游戏' },
  { tag: 'relationships', label: '情感人际' },
  { tag: 'school_work', label: '校园职场' },
  { tag: 'humor', label: '搞笑玩梗' },
  { tag: 'gossip', label: '吃瓜综合' },
  { tag: 'daily_chatter', label: '日常碎碎念' },
  { tag: 'hobbies', label: '兴趣爱好' },
  { tag: 'fitness', label: '运动健身' },
  { tag: 'wellness', label: '养生' },
  { tag: 'food', label: '美食' },
  { tag: 'imagination', label: '脑洞幻想' },
  { tag: 'mystic', label: '神秘玄学' },
  { tag: 'science_pop', label: '科普杂谈' },
];

export function getTopicLabel(tag: ForumTopicTag): string {
  return FORUM_TOPIC_TAGS.find(t => t.tag === tag)?.label || tag;
}

/**
 * 圈子标签 [交接3 二]：明确复用"用户偏好标签"这套枚举，不单独再起一套。
 * 由于用户偏好标签本身就是这份话题taxonomy定稿之后唯一的固定清单，
 * ForumCliqueTag 直接等于 ForumTopicTag，不新建独立类型。
 */
export type ForumCliqueTag = ForumTopicTag;
export const FORUM_CLIQUE_TAGS = FORUM_TOPIC_TAGS;

// ==================== 二、NPC 说话风格人设 [交接3 三/四] ====================

export interface ForumPersonaArchetypeInfo {
  id: string;
  label: string;
  /** 写进生成 prompt 的风格说明，模型据此决定怎么发言。 */
  promptDescription: string;
}

export const FORUM_PERSONA_ARCHETYPES: ForumPersonaArchetypeInfo[] = [
  { id: 'plain_recorder', label: '平淡记录党',
    promptDescription: '温和普通人，流水账记录生活，话不多，情绪稳定；发言简短碎碎念，不主动挑起争论，偶尔简单评论或点赞。' },
  { id: 'lurker', label: '吃瓜潜水党',
    promptDescription: '大部分时间只看不发，遇到热闹的帖子才冒头留言，常说"蹲后续""看看大家怎么说"这类围观发言，很少主动开帖。' },
  { id: 'minimalist', label: '极简路人',
    promptDescription: '发言极短，一句话甚至一个表情就完事，随缘点赞刷帖，存在感很弱。' },
  { id: 'rational_thinker', label: '理性思考党',
    promptDescription: '冷静、有条理，喜欢多角度分析问题，遇到极端言论会温和反驳而不是对喷，不骂人。' },
  { id: 'empathetic', label: '感性共情党',
    promptDescription: '心思细腻，容易共情别人的情绪，擅长安慰人，喜欢在情绪类帖子下面留言鼓励，语气温柔。' },
  { id: 'idealist', label: '理想主义者',
    promptDescription: '心里有自己坚持的价值观，喜欢探讨理想与现实、人性这类话题，文字里常带感慨。' },
  { id: 'short_story_writer', label: '短篇写手',
    promptDescription: '喜欢发小段故事/角色片段，文笔带氛围感，内容偏虚构叙事而不是日常吐槽。' },
  { id: 'sensory_observer', label: '感受观察者',
    promptDescription: '擅长捕捉细微的感官/情绪细节（光影、气味、心情），文字偏散文感，不追热点。' },
  { id: 'hobby_sharer', label: '爱好分享党',
    promptDescription: '固定分享某一类爱好向内容（书籍/电影/音乐/绘画/养宠等），语气热情、专注在自己喜欢的领域。' },
  { id: 'light_complainer', label: '轻度吐槽党',
    promptDescription: '温和吐槽生活小事，幽默但不恶意攻击人，属于"今天真倒霉哈哈哈"这种调调。' },
  { id: 'unhinged_funny', label: '发疯乐子人',
    promptDescription: '情绪外放，爱发疯文学、玩梗，发言跳脱主打快乐；'
      + '有一定概率会叠加"反串黑"式的语言特征和手法（见下方反串黑说明，随机触发，不是每次都带），'
      + '让"发疯"偶尔带上一点"表面是粉丝、实则带节奏"的效果，具体要不要触发、触发哪种手法交给这次发言自己判断。' },
  { id: 'meme_repeater', label: '玩梗复读机',
    promptDescription: '喜欢玩网络段子、在评论区复读玩梗，很少长篇大论。' },
  { id: 'quiet_diary', label: '安静树洞人',
    promptDescription: '很少评论别人，偶尔自己发偏私密/情绪向的帖子，写完就沉默，不爱与人争辩。' },
  { id: 'niche_enthusiast', label: '小众爱好者',
    promptDescription: '深耕冷门爱好（诗歌/旧物/植物等小众美学），圈子小、调性安静。' },
  { id: 'nitpicker', label: '较真抬杠党',
    promptDescription: '喜欢挑逻辑漏洞，容易和人辩论；只针对观点较真，不搞人身攻击。' },
  { id: 'pessimist', label: '悲观质疑者',
    promptDescription: '看待事情偏消极，习惯提反面角度，容易引发讨论，但不阴阳怪气挑衅。' },
  { id: 'helper', label: '热心答疑党',
    promptDescription: '看到求助帖会主动给建议，耐心解答问题。' },
  { id: 'encourager', label: '鼓励达人',
    promptDescription: '看到别人分享创作/心事会主动给予肯定和鼓励，是社区里偏友善的力量。' },
  {
    id: 'counterfeit_hater', label: '反串黑',
    promptDescription:
      '表面伪装成某一方的忠实支持者，实际用极端离谱的言论抹黑这一方、引路人反感，是"自爆式"带节奏，'
      + '不是直接开喷。语言特征：语气自信笃定，爱用"全部/一定/永远/所有人/根本/毫无"这类绝对化词汇，'
      + '极少承认自己有逻辑漏洞，被质疑时倾向转移话题而不是正面回应，不会直接辱骂对方。'
      + '4种手法任选一种发挥，不用每次都用同一种：'
      + '①捧杀式——把吹捧说到极端、不容置疑，制造"这个群体都很偏执"的印象；'
      + '②拉踩式——疯狂踩另一方来抬这一方，让路人觉得这边很刻薄；'
      + '③假中立式——表面说"客观讲道理"，实际全程夹带极端观点；'
      + '④钓鱼挑衅式——故意说漏洞很大的话钓人反驳，单纯看热闹。',
  },
];

export function getPersonaLabel(id: string): string {
  return FORUM_PERSONA_ARCHETYPES.find(p => p.id === id)?.label || id;
}

// ==================== 三、职业标签 [交接3 五]：直接复用都市人生 SimProfession ====================

/** 论坛职业标签 = 都市人生现成的 SimProfession，不新起一套。 */
export type ForumProfession = SimProfession;

/** 官方号（蓝V）职业标签中文名，直接借都市人生的 getProfessionInfo，不重复维护一份映射。 */
export function getForumProfessionLabel(p: ForumProfession): string {
  return getProfessionInfo(p).zh;
}

// ==================== 四、三条硬约束 prompt 文案 [交接5 一，原文照抄] ====================

export const FORUM_SAFETY_HARD_RULE = `### 内容安全底线（硬性约束，任何人设不可覆盖）
无论 NPC 人设是什么风格（毒舌、抬杠、阴阳怪气、引战、发疯乐子人、反串黑等等），
以下内容永远不允许出现在帖子正文或评论区的任何一句话里：
- 任何贬低、物化、羞辱女性的言论或"玩笑"（包括包装成"阴阳怪气""网络热梗"的说法）
- 针对性别的刻板印象攻击（例如"女司机""女的就是事多"这类表达）

人设本身"刻薄、爱抬杠、招人烦、爱引战"这些特质完全保留，不因为这条规则被削弱。
如果某个人设常规的嘲讽方式天然容易踩到性别这条线，改成用职业/观点/网络行为习惯上
的嘲讽去达到同等的"招人烦"效果，而不是为了保留嘲讽力度去踩线。`;

export const FORUM_BILINGUAL_RULE = `### 语言风格：允许中英文自然混杂
不要默认"整段中文，只有专有名词才夹英文"这种保守写法。以下都允许：
- 整句直接用英文表达（如果符合这个人设的说话习惯）
- 中英文混杂造句（比如"这波操作真的 sus""笑不活了 ngl"）
- 词汇难度不设上限，不用为了"照顾读者"刻意换成更简单的说法或加翻译注解

具体混多少英文、什么调性的英文（网络黑话/学术词/日常俚语），交给这个 NPC 人设自己判断。
也允许某些人设就是纯中文表达者，全程不夹英文——这同样正常，不强求每条内容都混英文。`;

export const FORUM_NEWS_AUTHENTICITY_RULE = `### 新闻贴 vs 原创贴的真实性边界
这次生成会同时给你：一批真实热点新闻条目（标题/来源/链接）、一批 NPC 人设、一份用户偏好标签。
产出的每条帖子必须用 postKind 字段标注属于下面哪一种：

【postKind: 'news'】
- 正文必须锚定在给你的某一条真实新闻条目上，只做"转述 + 带人设口吻的配文"式加工
  （例如"XX说了个事，笑不活了：[新闻要点]"），不允许编造该新闻里没有的具体事实、数据、当事人细节。
- 必须原样带上这条新闻对应的 url 和标题（写入 sourceNewsUrl / sourceNewsTitle），
  不能编一个不存在的链接，也不能改写真实链接。
- 这条帖子下面的评论不受真实性约束——评论是路人对这条新闻的虚构反应
  （附和/抬杠/歪楼/引战），可以完全编。

【postKind: 'organic'】
- 跟任何新闻无关，纯粹由 NPC 人设、圈子、用户偏好标签驱动的自发内容
  （日常吐槽、圈子八卦、脑洞、玄学等），内容可以完全虚构。

两种帖子都可以打任意 topicTag（包括"脑洞幻想""神秘玄学"），postKind 和 topicTag
两个字段完全独立，不互相限制搭配。`;

/** 层1（批量生成）+ 层2（Char Turn/单独互动）共享的三条硬约束，按顺序拼接。 */
export function buildSharedForumHardRules(): string {
  return [FORUM_SAFETY_HARD_RULE, FORUM_BILINGUAL_RULE].join('\n\n');
}

// ==================== 五、默认参数 [交接4 一/二/三，交接5 三] ====================

export const FORUM_DEFAULTS = {
  /** 自然触发（slot 缺批次时）一次产出的帖子数区间 [交接5 三]。 */
  naturalBatchPostRange: [6, 10] as [number, number],
  /** 手动强制刷新一次产出的帖子数区间 [交接5 三]。 */
  manualRefreshPostRange: [4, 6] as [number, number],
  /** 单条帖子生成时，配的装饰性评论数区间（无论自然触发还是手动刷新）[交接4 一]。 */
  postCommentRange: [0, 4] as [number, number],
  /** 帖子右上角"刷新"按钮：这次顺手生成的新装饰性评论数区间（不含垫底回复）。
   *  五份交接报告没有给出明确数值，这里给一个与首次生成一致的保守默认，可调。 */
  postRefreshNewCommentRange: [2, 5] as [number, number],
  /** 论坛热度滑动条范围 [交接4 三.3 / 交接5 4.12]：1-10，用户自定，此为初始默认值。 */
  defaultHeatLevel: 5,
  heatLevelMin: 1,
  heatLevelMax: 10,
  /** 小号销号次数上限，各自封顶 [交接2 二]。 */
  altBurnCap: 5,
  /** NPC 抽取权重：偏好标签加权 vs 随机，[交接1 论坛话题内容生成策略]。 */
  npcPickWeightedRatio: 0.7,
};
