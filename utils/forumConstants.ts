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
  | 'mystic' | 'science_pop'
  | 'couples';

/**
 * [用户确认新增] 每个分区的**评论区风气**。
 *
 * 加这个的直接原因：17 个分区的评论区读起来一个味儿——因为生成时话题标签只用来
 * 分类和配额，从来没影响过"这个区的人是怎么说话的"。真实论坛里财经区和吃瓜区
 * 的评论区完全是两个世界，这里得把那个差别写出来。
 *
 * 只描述**风气**，不规定内容。NPC 自己的人设仍然是第一位的——一个"安静树洞人"
 * 到了吃瓜区也不会突然变得很吵，只是会比在别的区稍微多说两句。
 */
export const FORUM_TOPIC_COMMENT_STYLES: Record<ForumTopicTag, string> = {
  social_affairs: '立场容易对立，有人认真讲道理、有人只想发泄；常见"你说的这个前提就不对"这类拆台，也常有人劝架或者阴阳两边都不讨好。',
  film_reading: '爱聊细节和私人感受，容易跑题到别的作品上；有剧透警告的习惯，也常见"这段我看哭了"和"过誉了吧"并存。',
  tech: '爱较参数和实测，喜欢纠正别人说错的规格；常出现"我上一代用户表示…"这种对比，偶尔演变成阵营之争。',
  finance: '互相甩数据和图表，语气硬；常见"已上车/已下车"的自嘲，也常有人冷冷指出别人在接盘。',
  gaming: '黑话密度最高的区，玩梗和缩写满天飞；常见开黑约人、吐槽平衡性、以及"这也能输"的互相嘲。',
  relationships: '最容易共情也最容易跑偏：一半人在安慰、一半人在劝分；常见"我当年也这样"的经验分享，偶尔有人给出很冷的清醒发言。',
  school_work: '苦水居多，互相心疼；常见"我们这也一样"的接龙，也有人认真给建议，语气比别的区温和。',
  humor: '接龙和抖机灵为主，谁能接得更好谁就赢；很少认真讨论，有人认真了反而会被玩。',
  gossip: '前排、蹲后续、阴阳怪气，三件套；爱推测和补充细节，也常有人跳出来说"别急着下结论"。',
  daily_chatter: '最松弛的区，随口一句"确实""我也是"就够了；没人追问，也没人较真。',
  hobbies: '同好之间热情且啰嗦，容易一口气打很长一段；新人提问会得到很耐心的回答。',
  fitness: '互相打卡和监督，也互相劝别练废；常见具体的组数重量，偶尔有人杠动作标不标准。',
  wellness: '经验之谈居多，代际感强；有人转述长辈说法，也有人认真科普纠偏，两边通常和平共处。',
  food: '看图说话为主，最容易出现"好想吃""坐标哪"；地域差异一挑起来就热闹（甜咸之争那种）。',
  imagination: '顺着楼主的设定往下接，比谁的脑洞更离谱；很少有人质疑设定，那样没意思。',
  mystic: '认真讨论的区，不是胡闹。谈的是命理、易理、星象、民俗信仰这类有自己一套体系的东西，大家在各自的框架里认真推演。常见"按这个说法应该是…"的援引，也有人温和表示自己不信但尊重。不要写成装神弄鬼或者装模作样。',
  science_pop: '爱补充和纠正，语气比科技区客气；常见"顺便一提"式的延伸，也常有人问很基础的问题而不会被嘲。',
  couples: '三种帖子混在一起：两性相处的讨论、情侣日常的吐槽、还有认真写的nsfw经验/教学帖。'
    + '吐槽帖底下是"我家那位也这样"的接龙和起哄，语气轻；讨论帖底下会有人认真给不同视角，'
    + '也会有人现身说法；教学帖底下是提问和补充，偶尔有人说"这套对我没用"。'
    + '甜的帖子会有人喊"狗粮"但不带恶意。吵架的帖子会有人劝和也有人劝分，两边都不算越界。'
    + 'nsfw经验/教学帖底下会有人现身说法,也会有人起哄抖机灵开黄腔，只是一种多样性评论的体现。' ,
};

export const FORUM_TOPIC_TAGS: { tag: ForumTopicTag; label: string }[] = [
  { tag: 'social_affairs', label: '社会时事' },
  { tag: 'film_reading', label: '电影阅读' },
  { tag: 'tech', label: '科技数码' },
  { tag: 'finance', label: '财经' },
  { tag: 'gaming', label: '游戏' },
  { tag: 'relationships', label: '情感人际' },
  { tag: 'couples', label: '情侣恋爱' },
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

/** 取某个分区的评论区风气说明。自定义话题（以后加的）取不到就返回空串。 */
export function getTopicCommentStyle(tag: string): string {
  return FORUM_TOPIC_COMMENT_STYLES[tag as ForumTopicTag] || '';
}

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

export const FORUM_BILINGUAL_RULE = `### 语言：每个账号只说一种语言，**不要中英混杂**
这个论坛上有说中文的人，也有说英文的人。每个账号后面标着它说哪种：

- 标着【全中文】的：**整条内容纯中文**。不要夹英文单词、不要夹缩写，
  连 "ngl" "sus" "pls" 这种网络用语也不要。专有名词（品牌名、游戏名、人名）本来就是
  英文的除外，那照原样写。
- 标着【全英文】的：**整条内容纯英文**，从头到尾不要出现一个汉字。
  语气该怎么随意就怎么随意，该玩梗就玩梗，但别夹中文。

没有标注时（用户自己的账号、TA 的账号），按那个人自己的说话习惯来，不要套用上面两档。

一楼中文、一楼英文是正常的，真实论坛本来就这样。但**同一条内容里不要两种语言混着用**——
那既不像中文使用者说话，也不像英文使用者说话，读起来是最难受的。`;

/**
 * 有多少比例的账号说英文。0.5 = 一半一半。想让论坛更偏中文就调小它。
 */
export const FORUM_ENGLISH_ACCOUNT_RATIO = 0.5;

/**
 * 某个账号说哪种语言。**只有纯中文和纯英文两档，没有混杂档。**
 *
 * 为什么写死而不是让模型自由发挥：措辞如果写成"允许"，模型一律选最省事的那条路，
 * 结果整个论坛全是纯中文。但反过来鼓励"混着说"也不行——混出来的句子既不像中文
 * 使用者说话、也不像英文使用者说话，读着最难受。所以按账号分档，每个账号只说一种。
 *
 * 用 handle 做哈希，所以同一个账号**永远**是同一档：今天说英文的人明天也说英文，
 * 不会同一个号一会儿中文一会儿英文。
 */
export function getAccountLanguageStyle(handle: string): 'english' | 'chinese' {
  let h = 0x811c9dc5;
  for (let i = 0; i < handle.length; i++) {
    h ^= handle.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 100) < Math.round(FORUM_ENGLISH_ACCOUNT_RATIO * 100) ? 'english' : 'chinese';
}

/** 渲染成提示词里那个标注。 */
export function describeAccountLanguageStyle(handle: string): string {
  return getAccountLanguageStyle(handle) === 'english' ? '【全英文】' : '【全中文】';
}

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

/**
 * [用户确认新增] 成人内容许可。
 *
 * 为什么是"许可"而不是"删掉某条禁令"：上面那条 FORUM_SAFETY_HARD_RULE 挡的是
 * **厌女**，不是**性**——它一个字都没提不许聊这些。真正让论坛一片干净的原因是
 * 从来没有人告诉模型可以，而模型的默认行为是回避。所以这里加的是明确的许可。
 *
 * 那条厌女禁令保留不动。两条并不冲突：一条说"可以荤"，一条说"别拿性别贬人"。
 * 真实的社交平台上黄段子和尊重人本来也能同时存在，这里要的就是那个状态。
 */
export const FORUM_ADULT_CONTENT_RULE = `### 成人向内容：可以有，按人设和分区来
这是一个成年人在用的社交平台，不是儿童社区。跟 X（推特）上的日常一样，
性话题、黄段子、荤玩笑、露骨的吐槽和调侃都属于正常内容，**不要刻意回避、
不要自我审查成一片干净**。具体包括：

- 直白地聊性经验、性生活、身体感受，包括具体到细节的讨论；
- 开黄腔、玩颜色梗、抖机灵式的双关和擦边；
- 情侣恋爱区里认真写的经验/技巧帖，以及底下现身说法、提问、起哄的评论；
- 露骨的自嘲和吐槽（"我真的不行了""昨晚差点交代在那儿"这种）。

但有三条边界：
1. **看人设。** 一个"安静树洞人"不会突然开黄腔，一个"发疯乐子人"才会。
   不要因为允许了就让所有人都往这个方向走——那比全干净还假。
2. **看分区。** 情侣恋爱、吃瓜、搞笑玩梗这些区出现得多很正常；
   科普杂谈、财经、养生区里突然来一句就很突兀。
3. **所有人都是成年人。** 任何涉及未成年人的性内容绝对不允许出现，
   这一条没有例外，人设、分区、玩梗都不是理由。

上面那条关于性别的硬约束依然全部有效：可以荤，但不能拿性别贬人、物化人、羞辱人。
这两件事不矛盾——真实平台上开得起玩笑的人，也知道分寸在哪。`;

/** 层1（批量生成）+ 层2（Char Turn/单独互动）共享的三条硬约束，按顺序拼接。 */
export function buildSharedForumHardRules(): string {
  return [
    FORUM_SAFETY_HARD_RULE,
    FORUM_BILINGUAL_RULE,
    // 不想要成人向内容时，把下面这一行注释掉即可，别的都不用动。
    FORUM_ADULT_CONTENT_RULE,
  ].join('\n\n');
}

// ==================== 五、默认参数 [交接4 一/二/三，交接5 三] ====================

/**
 * 热度滑动条 → 这次刷新产出多少评论。
 *
 * [用户确认] 以前热度只管"垫底楼最多接几条"，新增评论是另一个写死的随机范围，
 * 跟滑动条毫无关系——所以你把它拉到 5 也不会得到 5 条评论，这是那个困惑的由来。
 * 现在统一由它决定：**滑动条的数字 = 这次新开几楼**。
 *
 * 楼中楼是在这个基础上多出来的，所以实际总数会比滑动条的数字大：
 *   热度 5 → 5 楼，其中 2 楼有人接，每楼接 1-3 句 → 一共 7-11 条。
 */
export function resolveRefreshCommentPlan(heatLevel: number): {
  /** 这次新开几楼（= 热度值）。 */
  newFloors: number;
  /** 这几楼里有几楼会有人接话。 */
  repliedFloors: number;
} {
  const heat = Math.max(1, Math.floor(heatLevel) || 1);
  return {
    newFloors: heat,
    repliedFloors: Math.min(FORUM_DEFAULTS.postRefreshRepliedFloorCap, Math.floor(heat / 2)),
  };
}

export const FORUM_DEFAULTS = {
  /** 自然触发（slot 缺批次时）一次产出的帖子数区间 [交接5 三]。 */
  naturalBatchPostRange: [6, 10] as [number, number],
  /** 手动强制刷新一次产出的帖子数区间 [交接5 三]。 */
  manualRefreshPostRange: [4, 6] as [number, number],
  /** 单条帖子生成时，配的装饰性评论数区间（无论自然触发还是手动刷新）[交接4 一]。 */
  postCommentRange: [0, 4] as [number, number],
  /** 有人接话的那几条主楼，各自带几条楼中楼回复。这一档不跟着热度变——
   *  一条评论底下有人接一两句，冷清的论坛和热闹的论坛本来就一样自然。 */
  postRefreshSubCommentRange: [1, 3] as [number, number],
  /** 有人接话的主楼数上限。十楼里八楼都有人接，那不像论坛像群聊。 */
  postRefreshRepliedFloorCap: 4,
  /** 个人主页"批量配评论"：一次最多处理几条还没评论的帖子。 */
  profileBatchMaxPosts: 3,
  /** 每条帖子配几条评论。这里不要楼中楼——先让每条都有点动静就行。 */
  profileBatchCommentRange: [3, 5] as [number, number],
  /** 这一批总共最多送几张配图给模型看（几条帖子共用这个预算）。 */
  profileBatchMaxImages: 6,
  /** 刷新评论区时，最多把帖子的几张配图一起送给模型看。
   *  [用户确认] 全给——帖子本来就最多 9 张。嫌慢或嫌贵就把这个数字调小。 */
  postRefreshMaxImages: 9,
  /** 论坛热度滑动条范围 [交接4 三.3 / 交接5 4.12]：1-10，用户自定，此为初始默认值。 */
  defaultHeatLevel: 5,
  heatLevelMin: 1,
  heatLevelMax: 10,
  /** 小号销号次数上限，各自封顶 [交接2 二]。 */
  altBurnCap: 5,
  /** NPC 抽取权重：偏好标签加权 vs 随机，[交接1 论坛话题内容生成策略]。 */
  npcPickWeightedRatio: 0.7,
};
