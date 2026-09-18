/**
 * 论坛 · 路人（NPC）账号池引导
 *
 * 这是原本缺失的一环：forumBootstrap.ts 只负责"用户主号 / 角色主号 / 共管账号"这三种
 * 结构性账号，路人账号池没有任何地方生成。而 forumAi.runBatchGeneration 的第一步是
 * `if (npcAccounts.length === 0) return []`——池子是空的，整条内容生成链路就静默空转，
 * 不调 API、不报错，表现为"点刷新没反应"。
 *
 * 本文件用纯本地组合生成，不调 LLM：
 *   - 不花钱、不会因为 JSON 解析失败而生成一半；
 *   - 账号只是"壳"（昵称 + handle + 人设标签），真正的说话风格是生成内容时由
 *     personaArchetype 的 promptDescription 现场注入的，壳本身不需要模型来写。
 *
 * 幂等：按现有 npc 账号数量补足到目标数，已有的不动。用户注销/删号后再次进 App 会补齐。
 */

import * as db from './forumDb';
import type { ForumAccount } from './forumDb';
import { FORUM_PERSONA_ARCHETYPES, FORUM_TOPIC_TAGS, type ForumTopicTag } from './forumConstants';

/** 账号池目标规模。太少会翻来覆去就那几张脸，太多则 prompt 里也塞不下、没有意义。 */
export const FORUM_NPC_POOL_SIZE = 80;

/** 蓝V认证占比 [交接3 五]：全局账号池 20%。 */
const VERIFIED_RATIO = 0.2;

/** 每个号挂几个圈子标签（随机取区间内一个值）。 */
const CLIQUE_TAG_RANGE: [number, number] = [1, 3];

// ==================== 昵称 / handle 词库 ====================

const NICK_HEAD = [
  '深夜', '加班', '摸鱼', '柠檬', '橘子', '薄荷', '咸鱼', '蘑菇', '土豆', '月亮',
  '星期三', '下雨天', '老式', '二手', '半糖', '冷萃', '潮湿', '失眠', '早八', '便利店',
  '地铁口', '三点钟', '旧磁带', '塑料', '海边', '雪顶', '糖霜', '铁皮', '纸箱', '荔枝',
  '芝士', '番茄', '拿铁', '布丁', '银杏', '电波', '冬眠', '过期', '临时', '安静',
];

const NICK_TAIL = [
  '观察员', '收藏家', '爱好者', '研究所', '小分队', '制造机', '搬运工', '鉴定师', '守夜人', '收音机',
  '便利贴', '打工人', '漫游者', '记录本', '储备粮', '管理员', '培育计划', '发生器', '中转站', '维修工',
  '实验室', '日记', '频道', '小卖部', '情报局', '事务所', '回收站', '保安', '公司', '公园',
];

const HANDLE_HEAD = [
  'moss', 'noon', 'tape', 'glass', 'sable', 'plum', 'quiet', 'drift', 'minor', 'ember',
  'vinyl', 'onion', 'rusty', 'lemon', 'fog', 'pixel', 'otter', 'maple', 'salt', 'echo',
  'cider', 'navy', 'wren', 'tin', 'loop', 'dusk', 'clover', 'basil', 'mint', 'rook',
];

const HANDLE_TAIL = [
  'club', 'lab', 'diary', 'files', 'room', 'tape', 'note', 'desk', 'bench', 'wire',
  'wave', 'post', 'shelf', 'box', 'hour', 'line', 'cast', 'pond', 'yard', 'kit',
];

/** 个性签名候选，约六成账号会挂一条，剩下留空——真论坛本来就有大量空签名。 */
const BIO_POOL = [
  '随便看看',
  '不常上线',
  '这里只发废话',
  '已读乱回',
  '主页内容仅代表我今天的心情',
  '别问，问就是在加班',
  '存图为主',
  '有事私信，没事别找我',
  '我说的都对（不是）',
  '想到什么发什么',
  '低频出没',
  '只看不说话的那种',
  '今天也在努力活着',
  '本人非常好说话',
];

// ==================== 工具 ====================

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickInt([min, max]: [number, number]): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * 造一个没被占用的 handle。handle 是 @提及 的唯一依据（生成层靠字符串匹配判断
 * "这条评论有没有 @TA"），撞车会导致回复被挂到错误的账号上，所以必须全局唯一。
 */
function makeUniqueHandle(taken: Set<string>): string {
  for (let attempt = 0; attempt < 200; attempt++) {
    const base = `${pick(HANDLE_HEAD)}_${pick(HANDLE_TAIL)}`;
    const candidate = attempt < 40 ? base : `${base}${10 + Math.floor(Math.random() * 90)}`;
    if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
  }
  // 兜底：极端情况下直接带时间戳，保证一定不重复
  const fallback = `user_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  taken.add(fallback);
  return fallback;
}

function makeUniqueNickname(taken: Set<string>): string {
  for (let attempt = 0; attempt < 200; attempt++) {
    const base = `${pick(NICK_HEAD)}${pick(NICK_TAIL)}`;
    const candidate = attempt < 60 ? base : `${base}${2 + Math.floor(Math.random() * 98)}`;
    if (!taken.has(candidate)) { taken.add(candidate); return candidate; }
  }
  const fallback = `路人${Math.floor(Math.random() * 100000)}`;
  taken.add(fallback);
  return fallback;
}

// ==================== 主入口 ====================

/**
 * 补足路人账号池到目标规模。已存在的账号一律不动，只补差额。
 *
 * 人设分配用"先轮转一遍所有档案、再随机"的方式，保证 19 种人设每种至少出现一次，
 * 不会因为纯随机而出现某几种人设一个号都没有的情况。
 *
 * @returns 本次新建了几个账号（0 表示池子已经够了）
 */
export async function ensureNpcPool(target = FORUM_NPC_POOL_SIZE): Promise<number> {
  const existingNpcs = await db.getForumAccountsByOwnerType('npc');
  const missing = target - existingNpcs.length;
  if (missing <= 0) return 0;

  // handle / 昵称去重要看全库，不能只看 npc——用户主号和角色主号也占着名字。
  const allAccounts = await db.getAllForumAccounts();
  const takenHandles = new Set(allAccounts.map(a => a.handle));
  const takenNames = new Set(allAccounts.map(a => a.displayName));

  const allTopicTags = FORUM_TOPIC_TAGS.map(t => t.tag);
  const personaIds = FORUM_PERSONA_ARCHETYPES.map(p => p.id);

  // 人设轮转序列：把所有档案洗牌后循环取，铺满 missing 个名额
  const personaSequence: string[] = [];
  while (personaSequence.length < missing) personaSequence.push(...shuffle(personaIds));

  // 蓝V名额：先算出总共该有几个，减去已有的，剩下的名额随机撒在这批新号里
  const verifiedTarget = Math.round(target * VERIFIED_RATIO);
  const verifiedExisting = existingNpcs.filter(a => a.isVerified).length;
  const verifiedQuota = Math.max(0, verifiedTarget - verifiedExisting);
  const verifiedSlots = new Set(shuffle([...Array(missing).keys()]).slice(0, verifiedQuota));

  const now = Date.now();
  const created: ForumAccount[] = [];

  for (let i = 0; i < missing; i++) {
    const cliqueCount = pickInt(CLIQUE_TAG_RANGE);
    const cliqueTags = shuffle(allTopicTags).slice(0, cliqueCount) as ForumTopicTag[];

    const account: ForumAccount = {
      id: db.createForumAccountId(),
      ownerType: 'npc',
      isAlt: false,
      handle: makeUniqueHandle(takenHandles),
      displayName: makeUniqueNickname(takenNames),
      bio: Math.random() < 0.6 ? pick(BIO_POOL) : undefined,
      status: 'active',
      personaArchetype: personaSequence[i],
      cliqueTags,
      // profession 暂不填：它的取值必须是都市人生 SimProfession 枚举里的合法值，
      // 填错会让 getForumProfessionLabel 取不到而报错。等确认枚举清单后再补，
      // 空着不影响蓝V标记本身的展示与生成。
      isVerified: verifiedSlots.has(i) ? true : undefined,
      createdAt: now,
      updatedAt: now,
    };

    await db.saveForumAccount(account);
    created.push(account);
  }

  return created.length;
}

/** 当前池子里有多少个可用路人号（生成前的健康检查用）。 */
export async function getNpcPoolSize(): Promise<number> {
  const npcs = await db.getActiveNpcAccounts();
  return npcs.length;
}
