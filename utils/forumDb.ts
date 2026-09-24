/**
 * 论坛 · 独立 IndexedDB（SullyOS_Forum）
 *
 * 结构参照 utils/momentsDb.ts 的写法（openDb 缓存单例 + 手写 promise 包装 IDBRequest，
 * 不引入第三方 idb 库），保持项目内风格一致。
 *
 * 仓（object store）划分依据 [交接1 三.1]："必须分开存"——帖子和评论各自独立判断是否过期，
 * 不能嵌套存；销号计数/身份知晓状态跟着"人"走、不跟着"账号对象"走，所以也各自独立成仓：
 *   accounts            — ForumAccount（账号本体）
 *   posts               — ForumPost（帖子）
 *   comments            — ForumComment（评论，含楼中楼）
 *   alt_budgets         — ForumAltBudget（销号计数，user 一条 + 每个 char 一条）
 *   identity_awareness  — ForumIdentityAwareness（双向身份知晓，一角色一条）
 *   dm_messages         — ForumDmMessage（论坛内部私信，跟主线1v1聊天物理隔离 [交接2 一]）
 *   settings            — ForumSettings（全局单例：论坛热度滑动条、当前身份、批次slot水位）
 *
 * 全局单库，不按角色分库——因为一个账号本身就可能属于某个 char（TA），
 * 多个角色的 TA 账号、NPC 路人账号共存在同一个论坛世界里 [交接1 2.1/2.2]。
 */

// ==================== 类型定义 ====================

export type ForumAccountOwnerType = 'user' | 'char' | 'shared' | 'npc';

/** [交接1 2.1] 账号本体。销号计数/锁定/身份知晓状态均不挂在这里，见下方独立类型的说明。 */
export interface ForumAccount {
  id: string;
  ownerType: ForumAccountOwnerType;
  /** char/shared 时必填，user/npc 时 undefined。 */
  charId?: string;
  /** 仅 user/char 可能为 true，shared/npc 恒 false。 */
  isAlt: boolean;
  handle: string;
  displayName: string;
  avatar?: string;
  /** 背景图/封面图 [用户确认新增]，仅用户方账号(主号/小号/共管账号)可编辑，
   *  TA自己的号和NPC账号目前没有编辑入口，不代表不能有值。 */
  banner?: string;
  /** 个性签名 [用户确认新增]，同上仅用户方账号可编辑。 */
  bio?: string;
  status: 'active' | 'deactivated';

  // ---- 以下四个字段是 [交接3] NPC 人设/圈子/职业/认证的落地，仅 ownerType==='npc' 时有意义 ----
  /** 说话风格人设，单值。对应 FORUM_PERSONA_ARCHETYPES 里的 id。 [交接3 二/三] */
  personaArchetype?: string;
  /** 圈子标签，数组，一个号可同时属于多个圈子。 [交接3 二] */
  cliqueTags?: string[];
  /** 职业标签，非必填；仅蓝V认证官方号必填，其余 NPC 留空。 [交接3 五] */
  profession?: string;
  /** 蓝V认证，不是新账号类型，只是普通 npc 账号上的标记。全局账号池占比20%。 [交接3 五] */
  isVerified?: boolean;
  /**
   * 角色小号的"自我设定"：TA 给自己这个小号定的说话风格/伪装方向，只进生成提示词，
   * 任何界面都不显示，用户也看不到 —— 显示出来这号就白开了。
   * 不复用 bio，因为 bio 是公开签名，会出现在主页和搜索结果里。
   */
  altPersonaNote?: string;

  createdAt: number;
  updatedAt: number;
}

/** [交接1 2.2] 销号计数，独立于账号对象，跟着"这一方/这个角色"走。 */
export interface ForumAltBudget {
  /** 合成主键：subjectType==='user' 时固定为 'user'；'char' 时为 `char_${charId}`。 */
  id: string;
  subjectType: 'user' | 'char';
  charId?: string;
  burnCount: number;
  /** burnCount 达到 ALT_BURN_CAP（5）后置 true。 [交接2 二] */
  locked: boolean;
}

/** [交接1 2.3] 双向身份知晓状态，独立于账号对象，一角色一条。 */
export interface ForumIdentityAwareness {
  charId: string;
  userKnowsCharAlt: boolean;
  charKnowsUserAlt: boolean;
}

/**
 * [交接1 2.5 + 交接4 四 + 交接5 4.9] 帖子。
 * involvesCharInteraction 本轮收窄为"只有 TA 本人的号（主号或掉马后继续沿用的小号）
 * 回复过才算"，普通 NPC 接的不算 [交接4 四]。
 */
export interface ForumPost {
  id: string;
  authorAccountId: string;
  postKind: 'news' | 'organic';
  topicTag: string; // ForumTopicTag，避免循环依赖这里不直接 import，调用方自行约束类型
  title: string;
  content: string;
  sourceNewsUrl?: string;
  sourceNewsTitle?: string;
  createdAt: number;
  /**
   * 工程补充字段（报告未提及）：帖子本身 createdAt + 目前所有"用户方"评论(用户主号/
   * 小号/共管账号)里最新一条的createdAt，取较大值。NPC发的装饰性评论不计入
   * [用户确认：NPC评论不该续命，只有用户真的回来搭理过才该多给三天]。
   * 用于三天水线判断，避免每次判断过期都要把评论拉出来逐条过滤求 max。
   * 初始等于 createdAt，只在 appendComment 里追加"用户方"评论时才会被推进。
   */
  lastActivityAt: number;

  isCollected: boolean;
  involvesCharInteraction: boolean;
  isOwnedByUserSide: boolean;

  /**
   * 点赞 [用户确认新增]：账号id数组，谁点过赞。跟 isCollected 是两件事——
   * 点赞不算保留理由，三天水线判断时不看这个字段 [用户确认]。
   */
  likes: string[];

  /**
   * [交接5 4.9] 共管账号的"专属动态"（系统按4档节奏自动生成）只在共管账号自己的独立
   * 主页可见，不进公共 feed；其余帖子（含用户手动切到共管账号身份发的）都是 'public'。
   */
  visibility: 'public' | 'sharedAccountExclusive';

  /**
   * 图片附件，最多 9 张，与朋友圈同规格。存的是 blobref 令牌（本地相册选图，见
   * utils/blobRef.ts）或 http(s) 外链，渲染统一走 TokenImg。
   * 图不塞进 content——content 只放正文，喂给 AI 的上下文才不会被一长串令牌污染。
   * 注意：令牌写进了论坛自己的库（SullyOS_Forum），所以 utils/blobGc.ts 与
   * utils/blobDedupe.ts 必须把论坛这几张表也当引用面扫（已接入，见 FORUM_BLOB_REF_STORES）。
   */
  images?: string[];

  /** 轨道A长期归档水位，语义与 MomentPost.memoryArchivedUntil 一致 [交接5 2.2]。 */
  memoryArchivedUntil?: number;
}

/** [交接1 2.6] 评论，与 ForumPost 分开存。不需要单独的保留字段，跟随父帖子的三条理由。 */
export interface ForumComment {
  id: string;
  postId: string;
  authorAccountId: string;
  /** 楼中楼时指向上一层评论 id，顶层评论为 undefined。 */
  parentCommentId?: string;
  /**
   * 冗余字段（本实现新增，报告未提及，纯工程优化）：指向所属"楼"的顶层评论 id，
   * 自己就是顶层评论时等于自身 id。用于 O(1) 判定"垫底"楼，不用递归爬 parentCommentId 链。
   */
  threadRootId: string;
  content: string;
  createdAt: number;
}

/**
 * [交接2 一 DM定义 + 交接5 4.6] 论坛内部私信，跟主线1v1聊天物理隔离，不复用聊天消息表。
 * 一个会话 = (viewerIdentityAccountId, counterpartAccountId) 这一对，同一个用户用不同身份
 * 找同一个人聊天，算两个不同的会话（身份隔离的自然延伸——不然对面能拼出"这两个号是同一人"）。
 */
export interface ForumDmMessage {
  id: string;
  viewerIdentityAccountId: string;
  counterpartAccountId: string;
  fromAccountId: string; // 等于上面两者之一，标记这条是谁发的
  content: string;
  createdAt: number;
}

/**
 * 后台任务队列，结构照抄 momentsDb.ts 的 MomentAiTask（固定ID去重 + 持久化 +
 * 崩溃续跑 + 指数退避），服务 forumArchive.ts 的轨道A归档、以及以后可能出现的
 * 其它后台生成任务。跟朋友圈那份是两张不同的表（不同 IndexedDB 数据库），
 * 不能跨库共用，所以在这里单独开一份同构的。
 */
export type ForumAiTaskKind = 'memory_archive' | 'shared_account_post';
export type ForumAiTaskStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface ForumAiTask {
  id: string;
  kind: ForumAiTaskKind;
  /** memory_archive: 帖子 id；shared_account_post: 共管账号账号 id。 */
  targetId: string;
  status: ForumAiTaskStatus;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number;
  lastError?: string;
}

/** 全局单例设置。 */
export interface ForumSettings {
  id: 'global';
  /** 论坛热度，1-10 [交接4 三.3 / 交接5 4.12]。 */
  heatLevel: number;
  /** 当前使用中的身份账号 id（主号/小号/共管账号）[交接5 4.8/4.10]。 */
  activeIdentityAccountId: string;
  /** 自然触发批量生成对应的 slot id（格式复用 HotNewsSnapshot.id 的 `${date}#${slot}`）
   *  [交接5 三]，用于判断"当前 slot 有没有对应批次"。 */
  lastNaturalBatchSlotId?: string;
  /**
   * 论坛自己的浅色/夜色切换（工程补充字段，报告未提及）。[交接5 4.11] 只借
   * MingLightApp 的色值token和"一键切换机制"，没说要不要跟随系统 theme.darkMode——
   * 既然是独立借来的切换机制，就给它一个独立开关，不强行绑定系统主题。
   */
  darkMode?: boolean;
  /** 常客名单：固定几个路人账号，让他们在用户的帖子下面反复出现，形成"熟面孔"。
   *  没有熟面孔的话每次都是全新陌生 ID，用户根本无从分辨谁是 TA 的小号。 */
  regularsAccountIds?: string[];
  /** TA 挑明怀疑：同一个 4 小时时段只问它一次。它说"先不说"时，不再每次进 App 都重问、都花一次调用。 */
  lastConfrontationSlotId?: string;
  /** TA 处理好友申请：同上，一个时段只问一次。 */
  lastFriendDecisionSlotId?: string;
  updatedAt: number;
}

// ==================== 数据库连接 ====================

const DB_NAME = 'SullyOS_Forum';
const DB_VERSION = 3;

const STORE_ACCOUNTS = 'accounts';
const STORE_POSTS = 'posts';
const STORE_COMMENTS = 'comments';
const STORE_ALT_BUDGETS = 'alt_budgets';
const STORE_IDENTITY_AWARENESS = 'identity_awareness';
const STORE_DM_MESSAGES = 'dm_messages';
const STORE_SETTINGS = 'settings';
const STORE_AI_TASKS = 'ai_tasks';
const STORE_RELATIONS = 'relations';
const STORE_SUSPICIONS = 'suspicions';

let dbCache: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbCache) return Promise.resolve(dbCache);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(STORE_ACCOUNTS)) {
        const store = db.createObjectStore(STORE_ACCOUNTS, { keyPath: 'id' });
        store.createIndex('ownerType', 'ownerType', { unique: false });
        store.createIndex('charId', 'charId', { unique: false });
        store.createIndex('status', 'status', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_POSTS)) {
        const store = db.createObjectStore(STORE_POSTS, { keyPath: 'id' });
        store.createIndex('topicTag', 'topicTag', { unique: false });
        store.createIndex('authorAccountId', 'authorAccountId', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('visibility', 'visibility', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_COMMENTS)) {
        const store = db.createObjectStore(STORE_COMMENTS, { keyPath: 'id' });
        store.createIndex('postId', 'postId', { unique: false });
        store.createIndex('threadRootId', 'threadRootId', { unique: false });
        store.createIndex('authorAccountId', 'authorAccountId', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_ALT_BUDGETS)) {
        db.createObjectStore(STORE_ALT_BUDGETS, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(STORE_IDENTITY_AWARENESS)) {
        db.createObjectStore(STORE_IDENTITY_AWARENESS, { keyPath: 'charId' });
      }

      if (!db.objectStoreNames.contains(STORE_DM_MESSAGES)) {
        const store = db.createObjectStore(STORE_DM_MESSAGES, { keyPath: 'id' });
        store.createIndex('viewerIdentityAccountId', 'viewerIdentityAccountId', { unique: false });
        store.createIndex('counterpartAccountId', 'counterpartAccountId', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(STORE_AI_TASKS)) {
        const store = db.createObjectStore(STORE_AI_TASKS, { keyPath: 'id' });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('nextRunAt', 'nextRunAt', { unique: false });
        store.createIndex('kind', 'kind', { unique: false });
        store.createIndex('targetId', 'targetId', { unique: false });
      }

      // v2 新增：好友 / 拉黑关系。一行代表一个方向（from 对 to 的态度），
      // 互为好友时两个方向各存一行，这样"我的好友列表"用 fromAccountId 索引一次就拿到。
      if (!db.objectStoreNames.contains(STORE_RELATIONS)) {
        const store = db.createObjectStore(STORE_RELATIONS, { keyPath: 'id' });
        store.createIndex('fromAccountId', 'fromAccountId', { unique: false });
        store.createIndex('toAccountId', 'toAccountId', { unique: false });
        store.createIndex('status', 'status', { unique: false });
      }

      // v3 新增：小号怀疑/掉马记录。
      // 老的 identity_awareness 表（两个是/否开关）表达不了"怀疑但没确认"这个中间态，
      // 也记不住怀疑的是哪个号，所以另起一张。老表保留不动，避免动到任何已有数据。
      if (!db.objectStoreNames.contains(STORE_SUSPICIONS)) {
        const store = db.createObjectStore(STORE_SUSPICIONS, { keyPath: 'id' });
        store.createIndex('observerKey', 'observerKey', { unique: false });
        store.createIndex('targetAccountId', 'targetAccountId', { unique: false });
        store.createIndex('stage', 'stage', { unique: false });
      }
    };

    req.onsuccess = () => {
      dbCache = req.result;
      dbCache.onclose = () => { dbCache = null; };
      resolve(dbCache);
    };
  });
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createForumAccountId(): string { return genId('facc'); }
export function createForumPostId(): string { return genId('fpost'); }
export function createForumCommentId(): string { return genId('fcmt'); }
export function createForumDmMessageId(): string { return genId('fdm'); }

// 通用 promisify 小工具，减少重复样板
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}
function reqResult<T>(req: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

// ==================== Blob 引用面（给 blobGc / blobDedupe 用） ====================

/**
 * 论坛库里「可能存着 blobref 令牌」的表。
 *
 * 论坛用的是自己的 IndexedDB（SullyOS_Forum），不在主库里，所以 utils/blobGc.ts 的
 * REF_SOURCE_STORES 那份清单**扫不到这里**。account.avatar / account.banner /
 * post.images 存的是令牌，这几张表要是不单独吐给 GC，用户自己选的相册图会在下一轮
 * 「孤儿图片清理」里被判成没人引用直接删掉，且不可逆。
 *
 * 往论坛里加新表、或者把令牌写进新字段时，先回来过一眼这份清单。
 * 枚举是整行 JSON.stringify，字段增删自动覆盖，不用按字段维护。
 */
export const FORUM_BLOB_REF_STORES = [
  STORE_ACCOUNTS,
  STORE_POSTS,
  STORE_COMMENTS,
  STORE_DM_MESSAGES,
] as const;

export type ForumBlobRefStore = typeof FORUM_BLOB_REF_STORES[number];

/**
 * 按主键分页读一页原始行，口径对齐主库的 DB.getStoreRowsPage：
 * afterKey 为 null 从头开始，返回 lastKey 供下一页续读，读完返回 lastKey: null。
 * 分页而不是 getAll，是因为帖子表可能很大，一次全量拉进内存会顶爆低端机。
 */
export async function getForumRowsPage(
  storeName: ForumBlobRefStore,
  afterKey: IDBValidKey | null,
  limit: number,
): Promise<{ rows: unknown[]; lastKey: IDBValidKey | null }> {
  const db = await openDb();
  if (!db.objectStoreNames.contains(storeName)) return { rows: [], lastKey: null };
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const range = afterKey === null ? undefined : IDBKeyRange.lowerBound(afterKey, true);
  const rows: unknown[] = [];
  let lastKey: IDBValidKey | null = null;

  await new Promise<void>((resolve, reject) => {
    const req = store.openCursor(range);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || rows.length >= limit) { resolve(); return; }
      rows.push(cursor.value);
      lastKey = cursor.key;
      cursor.continue();
    };
  });

  return { rows, lastKey: rows.length < limit ? null : lastKey };
}

/** 整行写回（令牌合并用）。这几张表都是 inline keyPath: 'id'，可以直接 put。 */
export async function putForumRows(storeName: ForumBlobRefStore, rows: unknown[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await openDb();
  if (!db.objectStoreNames.contains(storeName)) return;
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  for (const row of rows) store.put(row as any);
  return txDone(tx);
}

// ==================== Accounts ====================

export async function saveForumAccount(account: ForumAccount): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_ACCOUNTS, 'readwrite');
  tx.objectStore(STORE_ACCOUNTS).put(account);
  return txDone(tx);
}

export async function getForumAccount(id: string): Promise<ForumAccount | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_ACCOUNTS, 'readonly');
  const result = await reqResult<ForumAccount | undefined>(tx.objectStore(STORE_ACCOUNTS).get(id));
  return result || null;
}

export async function getAllForumAccounts(): Promise<ForumAccount[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_ACCOUNTS, 'readonly');
  return (await reqResult<ForumAccount[]>(tx.objectStore(STORE_ACCOUNTS).getAll())) || [];
}

export async function getForumAccountsByOwnerType(ownerType: ForumAccountOwnerType): Promise<ForumAccount[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_ACCOUNTS, 'readonly');
  const idx = tx.objectStore(STORE_ACCOUNTS).index('ownerType');
  return (await reqResult<ForumAccount[]>(idx.getAll(ownerType))) || [];
}

export async function getForumAccountsByCharId(charId: string): Promise<ForumAccount[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_ACCOUNTS, 'readonly');
  const idx = tx.objectStore(STORE_ACCOUNTS).index('charId');
  return (await reqResult<ForumAccount[]>(idx.getAll(charId))) || [];
}

/** NPC 账号池（抽取候选），排除已注销的。 */
export async function getActiveNpcAccounts(): Promise<ForumAccount[]> {
  const all = await getForumAccountsByOwnerType('npc');
  return all.filter(a => a.status === 'active');
}

export async function deleteForumAccount(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_ACCOUNTS, 'readwrite');
  tx.objectStore(STORE_ACCOUNTS).delete(id);
  return txDone(tx);
}

// ==================== Posts ====================

export async function saveForumPost(post: ForumPost): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_POSTS, 'readwrite');
  tx.objectStore(STORE_POSTS).put(post);
  return txDone(tx);
}

export async function getForumPost(id: string): Promise<ForumPost | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_POSTS, 'readonly');
  const result = await reqResult<ForumPost | undefined>(tx.objectStore(STORE_POSTS).get(id));
  return result || null;
}

/** 主 feed / 分区页共用：按可见性 + 话题过滤，调用方自己再做水线过滤与分页切片。 */
export async function getForumPostsRaw(opts: {
  visibility?: 'public' | 'sharedAccountExclusive';
  topicTag?: string;
} = {}): Promise<ForumPost[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_POSTS, 'readonly');
  let posts: ForumPost[];
  if (opts.topicTag) {
    const idx = tx.objectStore(STORE_POSTS).index('topicTag');
    posts = (await reqResult<ForumPost[]>(idx.getAll(opts.topicTag))) || [];
  } else {
    posts = (await reqResult<ForumPost[]>(tx.objectStore(STORE_POSTS).getAll())) || [];
  }
  if (opts.visibility) posts = posts.filter(p => p.visibility === opts.visibility);
  posts.sort((a, b) => b.createdAt - a.createdAt);
  return posts;
}

export async function getForumPostsByAuthor(authorAccountId: string): Promise<ForumPost[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_POSTS, 'readonly');
  const idx = tx.objectStore(STORE_POSTS).index('authorAccountId');
  const posts = (await reqResult<ForumPost[]>(idx.getAll(authorAccountId))) || [];
  posts.sort((a, b) => b.createdAt - a.createdAt);
  return posts;
}

export async function deleteForumPost(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_POSTS, 'readwrite');
  tx.objectStore(STORE_POSTS).delete(id);
  return txDone(tx);
}

/** 批量删（清空机制用）。 */
export async function deleteForumPosts(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(STORE_POSTS, 'readwrite');
  const store = tx.objectStore(STORE_POSTS);
  for (const id of ids) store.delete(id);
  return txDone(tx);
}

// ==================== Comments ====================

export async function saveForumComment(comment: ForumComment): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_COMMENTS, 'readwrite');
  tx.objectStore(STORE_COMMENTS).put(comment);
  return txDone(tx);
}

export async function saveForumComments(comments: ForumComment[]): Promise<void> {
  if (comments.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(STORE_COMMENTS, 'readwrite');
  const store = tx.objectStore(STORE_COMMENTS);
  for (const c of comments) store.put(c);
  return txDone(tx);
}

export async function getCommentsByPost(postId: string): Promise<ForumComment[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_COMMENTS, 'readonly');
  const idx = tx.objectStore(STORE_COMMENTS).index('postId');
  const comments = (await reqResult<ForumComment[]>(idx.getAll(postId))) || [];
  comments.sort((a, b) => a.createdAt - b.createdAt);
  return comments;
}

export async function deleteForumComment(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_COMMENTS, 'readwrite');
  tx.objectStore(STORE_COMMENTS).delete(id);
  return txDone(tx);
}

export async function deleteCommentsByPost(postId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_COMMENTS, 'readwrite');
  const idx = tx.objectStore(STORE_COMMENTS).index('postId');
  const req = idx.openCursor(IDBKeyRange.only(postId));
  req.onsuccess = () => { const cur = req.result; if (cur) { cur.delete(); cur.continue(); } };
  return txDone(tx);
}

/** 批量按帖子 id 删评论（清空机制用，帖子和评论一起清）。 */
export async function deleteCommentsByPosts(postIds: string[]): Promise<void> {
  for (const postId of postIds) await deleteCommentsByPost(postId);
}

// ==================== Alt Budgets ====================

function altBudgetId(subjectType: 'user' | 'char', charId?: string): string {
  return subjectType === 'user' ? 'user' : `char_${charId}`;
}

export async function getAltBudget(subjectType: 'user' | 'char', charId?: string): Promise<ForumAltBudget> {
  const db = await openDb();
  const tx = db.transaction(STORE_ALT_BUDGETS, 'readonly');
  const id = altBudgetId(subjectType, charId);
  const result = await reqResult<ForumAltBudget | undefined>(tx.objectStore(STORE_ALT_BUDGETS).get(id));
  return result || { id, subjectType, charId, burnCount: 0, locked: false };
}

export async function saveAltBudget(budget: ForumAltBudget): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_ALT_BUDGETS, 'readwrite');
  tx.objectStore(STORE_ALT_BUDGETS).put(budget);
  return txDone(tx);
}

// ==================== Identity Awareness ====================

export async function getIdentityAwareness(charId: string): Promise<ForumIdentityAwareness> {
  const db = await openDb();
  const tx = db.transaction(STORE_IDENTITY_AWARENESS, 'readonly');
  const result = await reqResult<ForumIdentityAwareness | undefined>(
    tx.objectStore(STORE_IDENTITY_AWARENESS).get(charId)
  );
  return result || { charId, userKnowsCharAlt: false, charKnowsUserAlt: false };
}

export async function saveIdentityAwareness(state: ForumIdentityAwareness): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_IDENTITY_AWARENESS, 'readwrite');
  tx.objectStore(STORE_IDENTITY_AWARENESS).put(state);
  return txDone(tx);
}

// ==================== DM Messages ====================

export async function saveForumDmMessage(msg: ForumDmMessage): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_DM_MESSAGES, 'readwrite');
  tx.objectStore(STORE_DM_MESSAGES).put(msg);
  return txDone(tx);
}

/** 某个会话（身份+对方）的完整消息，按时间升序。 */
export async function getDmThreadMessages(
  viewerIdentityAccountId: string,
  counterpartAccountId: string
): Promise<ForumDmMessage[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_DM_MESSAGES, 'readonly');
  const idx = tx.objectStore(STORE_DM_MESSAGES).index('viewerIdentityAccountId');
  const all = (await reqResult<ForumDmMessage[]>(idx.getAll(viewerIdentityAccountId))) || [];
  const thread = all.filter(m => m.counterpartAccountId === counterpartAccountId);
  thread.sort((a, b) => a.createdAt - b.createdAt);
  return thread;
}

/** 当前身份下的会话列表（按每个会话最后一条消息时间倒序），供 4.6 会话列表页用。 */
export async function getDmThreadsForIdentity(viewerIdentityAccountId: string): Promise<
  { counterpartAccountId: string; lastMessage: ForumDmMessage }[]
> {
  const db = await openDb();
  const tx = db.transaction(STORE_DM_MESSAGES, 'readonly');
  const idx = tx.objectStore(STORE_DM_MESSAGES).index('viewerIdentityAccountId');
  const all = (await reqResult<ForumDmMessage[]>(idx.getAll(viewerIdentityAccountId))) || [];
  const byCounterpart = new Map<string, ForumDmMessage>();
  for (const m of all) {
    const prev = byCounterpart.get(m.counterpartAccountId);
    if (!prev || m.createdAt > prev.createdAt) byCounterpart.set(m.counterpartAccountId, m);
  }
  return Array.from(byCounterpart.entries())
    .map(([counterpartAccountId, lastMessage]) => ({ counterpartAccountId, lastMessage }))
    .sort((a, b) => b.lastMessage.createdAt - a.lastMessage.createdAt);
}

// ==================== Relations（好友 / 拉黑）====================

/**
 * pending  —— from 向 to 发出了好友申请，还没被处理
 * accepted —— from 认可 to 是好友（互为好友时两个方向各一行）
 * blocked  —— from 拉黑了 to（单向；私信是否被拦要看两个方向里有没有任何一条 blocked）
 */
export type ForumRelationStatus = 'pending' | 'accepted' | 'blocked';

export interface ForumRelation {
  /** `${fromAccountId}__${toAccountId}`，同一对方向只会有一行，天然幂等。 */
  id: string;
  fromAccountId: string;
  toAccountId: string;
  status: ForumRelationStatus;
  createdAt: number;
  updatedAt: number;
}

export function makeForumRelationId(fromAccountId: string, toAccountId: string): string {
  return `${fromAccountId}__${toAccountId}`;
}

export async function saveForumRelation(relation: ForumRelation): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_RELATIONS, 'readwrite');
  tx.objectStore(STORE_RELATIONS).put(relation);
  return txDone(tx);
}

export async function getForumRelation(fromAccountId: string, toAccountId: string): Promise<ForumRelation | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_RELATIONS, 'readonly');
  const row = await reqResult<ForumRelation | undefined>(
    tx.objectStore(STORE_RELATIONS).get(makeForumRelationId(fromAccountId, toAccountId))
  );
  return row || null;
}

export async function deleteForumRelation(fromAccountId: string, toAccountId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_RELATIONS, 'readwrite');
  tx.objectStore(STORE_RELATIONS).delete(makeForumRelationId(fromAccountId, toAccountId));
  return txDone(tx);
}

/** 这个账号发出的关系（我的好友列表 / 我发出的申请 / 我拉黑的人）。 */
export async function getForumRelationsFrom(accountId: string, status?: ForumRelationStatus): Promise<ForumRelation[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_RELATIONS, 'readonly');
  const idx = tx.objectStore(STORE_RELATIONS).index('fromAccountId');
  const all = (await reqResult<ForumRelation[]>(idx.getAll(accountId))) || [];
  return status ? all.filter(r => r.status === status) : all;
}

/** 指向这个账号的关系（别人发给我的申请 / 谁拉黑了我）。 */
export async function getForumRelationsTo(accountId: string, status?: ForumRelationStatus): Promise<ForumRelation[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_RELATIONS, 'readonly');
  const idx = tx.objectStore(STORE_RELATIONS).index('toAccountId');
  const all = (await reqResult<ForumRelation[]>(idx.getAll(accountId))) || [];
  return status ? all.filter(r => r.status === status) : all;
}

// ==================== Suspicions（小号怀疑与掉马）====================

/**
 * suspected —— 观察者起了疑，但还没当面挑明
 * confronted —— 已经当面对质过，对方否认或还没表态
 * admitted  —— 对方承认了这个号就是自己的小号（掉马）
 * denied    —— 对方明确否认。否认不代表清白，观察者可以继续怀疑、再次对质。
 */
export type ForumSuspicionStage = 'suspected' | 'confronted' | 'admitted' | 'denied';

/** 掉马之后当事人的选择。 */
export type ForumSuspicionOutcome = 'kept' | 'burned';

export interface ForumSuspicion {
  /** `${observerKey}__${targetAccountId}` */
  id: string;
  /** 谁在怀疑：'user' 或角色 id。 */
  observerKey: string;
  /** 怀疑哪个账号。 */
  targetAccountId: string;
  stage: ForumSuspicionStage;
  /** 观察者自己写下的依据，掉马后也能回看是怎么被认出来的。 */
  reason?: string;
  /** 只有 stage='admitted' 时有值。 */
  outcome?: ForumSuspicionOutcome;
  /**
   * 当面对质时，发起指认的是哪个账号（用户那边用哪个身份问的）。
   * TA 的聊天上下文要靠它决定怎么描述"谁问过你"——必须走身份遮罩，
   * 用户小号问的就只能写成一个网名，不能写成"用户本人问过你"。
   */
  accuserAccountId?: string;
  createdAt: number;
  updatedAt: number;
}

export function makeForumSuspicionId(observerKey: string, targetAccountId: string): string {
  return `${observerKey}__${targetAccountId}`;
}

export async function saveForumSuspicion(row: ForumSuspicion): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_SUSPICIONS, 'readwrite');
  tx.objectStore(STORE_SUSPICIONS).put(row);
  return txDone(tx);
}

export async function getForumSuspicion(observerKey: string, targetAccountId: string): Promise<ForumSuspicion | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_SUSPICIONS, 'readonly');
  const row = await reqResult<ForumSuspicion | undefined>(
    tx.objectStore(STORE_SUSPICIONS).get(makeForumSuspicionId(observerKey, targetAccountId))
  );
  return row || null;
}

/** 某个观察者的全部怀疑记录（用来回流进上下文 / 展示）。 */
export async function getForumSuspicionsByObserver(observerKey: string): Promise<ForumSuspicion[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_SUSPICIONS, 'readonly');
  const idx = tx.objectStore(STORE_SUSPICIONS).index('observerKey');
  return (await reqResult<ForumSuspicion[]>(idx.getAll(observerKey))) || [];
}

/** 针对某个账号的全部怀疑记录（判断这个号有没有掉过马）。 */
export async function getForumSuspicionsByTarget(targetAccountId: string): Promise<ForumSuspicion[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_SUSPICIONS, 'readonly');
  const idx = tx.objectStore(STORE_SUSPICIONS).index('targetAccountId');
  return (await reqResult<ForumSuspicion[]>(idx.getAll(targetAccountId))) || [];
}

// ==================== Settings ====================

const DEFAULT_SETTINGS_BASE: Omit<ForumSettings, 'id' | 'activeIdentityAccountId'> = {
  heatLevel: 5,
  updatedAt: 0,
};

export async function getForumSettings(defaultIdentityAccountId: string): Promise<ForumSettings> {
  const db = await openDb();
  const tx = db.transaction(STORE_SETTINGS, 'readonly');
  const result = await reqResult<ForumSettings | undefined>(tx.objectStore(STORE_SETTINGS).get('global'));
  return result || {
    id: 'global',
    activeIdentityAccountId: defaultIdentityAccountId,
    ...DEFAULT_SETTINGS_BASE,
  };
}

export async function saveForumSettings(settings: ForumSettings): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_SETTINGS, 'readwrite');
  tx.objectStore(STORE_SETTINGS).put({ ...settings, updatedAt: Date.now() });
  return txDone(tx);
}

// ==================== AI Task Queue（结构照抄 momentsDb 的 MomentAiTask 一套） ====================

export function createForumAiTaskId(kind: ForumAiTaskKind, targetId: string): string {
  return `fat_${kind}_${targetId}`;
}

export async function enqueueForumAiTask(task: ForumAiTask): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_AI_TASKS, 'readwrite');
  tx.objectStore(STORE_AI_TASKS).put(task);
  return txDone(tx);
}

/** 固定ID去重前先看一眼是不是已经在跑，避免把 processing 中的任务重置成 pending。 */
export async function getForumAiTask(taskId: string): Promise<ForumAiTask | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_AI_TASKS, 'readonly');
  const result = await reqResult<ForumAiTask | undefined>(tx.objectStore(STORE_AI_TASKS).get(taskId));
  return result || null;
}

export async function getPendingForumAiTasks(now = Date.now()): Promise<ForumAiTask[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_AI_TASKS, 'readonly');
  const tasks = (await reqResult<ForumAiTask[]>(tx.objectStore(STORE_AI_TASKS).getAll())) || [];
  return tasks
    .filter(t => (t.status === 'pending' || (t.status === 'processing' && now - t.updatedAt > 5 * 60_000)) && t.nextRunAt <= now)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** 原子地把任务从 pending/stale processing 抢成 processing，避免多实例重复跑。 */
export async function claimForumAiTask(taskId: string, now = Date.now()): Promise<ForumAiTask | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AI_TASKS, 'readwrite');
    const store = tx.objectStore(STORE_AI_TASKS);
    const req = store.get(taskId);
    req.onsuccess = () => {
      const task = req.result as ForumAiTask | undefined;
      if (!task) { resolve(null); return; }
      const stale = task.status === 'processing' && now - task.updatedAt > 5 * 60_000;
      if (task.nextRunAt > now || (task.status !== 'pending' && !stale)) { resolve(null); return; }
      const claimed = { ...task, status: 'processing' as const, updatedAt: now, attempts: (task.attempts || 0) + 1 };
      store.put(claimed);
      tx.oncomplete = () => resolve(claimed);
    };
    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
  });
}

export async function finishForumAiTask(taskId: string, ok: boolean, error?: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_AI_TASKS, 'readwrite');
    const store = tx.objectStore(STORE_AI_TASKS);
    const req = store.get(taskId);
    req.onsuccess = () => {
      const task = req.result as ForumAiTask | undefined;
      if (!task) return;
      const attempts = task.attempts || 0;
      const retry = !ok && attempts < 8;
      const delay = Math.min(60 * 60_000, Math.max(5_000, 2 ** Math.min(attempts, 8) * 1_000));
      store.put({
        ...task,
        status: retry ? 'pending' : (ok ? 'completed' : 'failed'),
        updatedAt: Date.now(),
        nextRunAt: retry ? Date.now() + delay : 0,
        lastError: ok ? undefined : String(error || '未知错误').slice(0, 500),
      });
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('finishForumAiTask aborted'));
  });
}

// ==================== 备份与恢复（对齐 momentsDb 的 exportAll/importAll 约定） ====================

export interface ForumBackupData {
  accounts: ForumAccount[];
  posts: ForumPost[];
  comments: ForumComment[];
  altBudgets: ForumAltBudget[];
  identityAwareness: ForumIdentityAwareness[];
  dmMessages: ForumDmMessage[];
  settings: ForumSettings[];
  relations?: ForumRelation[];
  suspicions?: ForumSuspicion[];
}

export async function exportForumAll(): Promise<ForumBackupData> {
  const db = await openDb();
  const getAll = <T,>(storeName: string): Promise<T[]> => {
    const tx = db.transaction(storeName, 'readonly');
    return reqResult<T[]>(tx.objectStore(storeName).getAll());
  };
  const [accounts, posts, comments, altBudgets, identityAwareness, dmMessages, settings, relations, suspicions] = await Promise.all([
    getAll<ForumAccount>(STORE_ACCOUNTS),
    getAll<ForumPost>(STORE_POSTS),
    getAll<ForumComment>(STORE_COMMENTS),
    getAll<ForumAltBudget>(STORE_ALT_BUDGETS),
    getAll<ForumIdentityAwareness>(STORE_IDENTITY_AWARENESS),
    getAll<ForumDmMessage>(STORE_DM_MESSAGES),
    getAll<ForumSettings>(STORE_SETTINGS),
    getAll<ForumRelation>(STORE_RELATIONS),
    getAll<ForumSuspicion>(STORE_SUSPICIONS),
  ]);
  return { accounts, posts, comments, altBudgets, identityAwareness, dmMessages, settings, relations, suspicions };
}

export async function importForumAll(backup: ForumBackupData): Promise<void> {
  const db = await openDb();
  const clearAndFill = async <T,>(storeName: string, items: T[]) => {
    const clearTx = db.transaction(storeName, 'readwrite');
    clearTx.objectStore(storeName).clear();
    await txDone(clearTx);
    for (const item of items) {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(item as any);
      await txDone(tx);
    }
  };
  await clearAndFill(STORE_ACCOUNTS, backup.accounts || []);
  await clearAndFill(STORE_POSTS, backup.posts || []);
  await clearAndFill(STORE_COMMENTS, backup.comments || []);
  await clearAndFill(STORE_ALT_BUDGETS, backup.altBudgets || []);
  await clearAndFill(STORE_IDENTITY_AWARENESS, backup.identityAwareness || []);
  await clearAndFill(STORE_DM_MESSAGES, backup.dmMessages || []);
  await clearAndFill(STORE_SETTINGS, backup.settings || []);
  await clearAndFill(STORE_RELATIONS, backup.relations || []);
  await clearAndFill(STORE_SUSPICIONS, backup.suspicions || []);
}

/** 一键清空全部（本轮不接入 UI，仅保留函数以后接 [交接4 一]）。 */
export async function wipeForumAllData(): Promise<void> {
  const db = await openDb();
  const stores = [
    STORE_ACCOUNTS, STORE_POSTS, STORE_COMMENTS, STORE_ALT_BUDGETS,
    STORE_IDENTITY_AWARENESS, STORE_DM_MESSAGES, STORE_RELATIONS, STORE_SUSPICIONS,
  ];
  for (const s of stores) {
    const tx = db.transaction(s, 'readwrite');
    tx.objectStore(s).clear();
    await txDone(tx);
  }
}

// ==================== 已读标记（私信未读 / 通知已读共用） ====================
//
// 存在 settings 表里，一个会话/一个入口一行（id 带 readmark__ 前缀），不动数据库版本号。
// 备份导出/导入本来就是整张 settings 表原样搬，已读状态会跟着一起走。
// 不塞进 'global' 那一行设置里：那一行会被切换深浅色、调热度、后台时段标记各自整行覆盖写，
// 已读标记混进去容易被别的写入冲掉，红点莫名其妙又冒出来。
//
// 这些标记只给你自己看（红点），TA 那边完全不知道你读没读。

const READ_MARK_PREFIX = 'readmark__';
const UNREAD_EPOCH_KEY = 'epoch';

interface ForumReadMarkRow {
  id: string;
  at: number;
  updatedAt: number;
}

export function dmReadKey(viewerIdentityAccountId: string, counterpartAccountId: string): string {
  return `dm__${viewerIdentityAccountId}__${counterpartAccountId}`;
}

export async function setReadMark(key: string, at = Date.now()): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STORE_SETTINGS, 'readwrite');
  const row: ForumReadMarkRow = { id: `${READ_MARK_PREFIX}${key}`, at, updatedAt: Date.now() };
  tx.objectStore(STORE_SETTINGS).put(row);
  return txDone(tx);
}

export async function getReadMark(key: string): Promise<number | undefined> {
  const db = await openDb();
  const tx = db.transaction(STORE_SETTINGS, 'readonly');
  const row = await reqResult<ForumReadMarkRow | undefined>(tx.objectStore(STORE_SETTINGS).get(`${READ_MARK_PREFIX}${key}`));
  return row?.at;
}

/**
 * 开始记"已读"的时间点。第一次调用时写入"现在"。
 * 没有已读标记的会话一律按这个时间点算——不然更新之后第一次打开，
 * 以前所有的旧私信全都会亮红点。
 */
export async function getUnreadTrackingEpoch(): Promise<number> {
  const existing = await getReadMark(UNREAD_EPOCH_KEY);
  if (existing !== undefined) return existing;
  const now = Date.now();
  await setReadMark(UNREAD_EPOCH_KEY, now);
  return now;
}

/** 某个身份下，每个私信会话有几条对方发来、你还没点开看的消息。 */
export async function getDmUnreadByCounterpart(viewerIdentityAccountId: string): Promise<Map<string, number>> {
  const epoch = await getUnreadTrackingEpoch();
  const db = await openDb();
  const msgTx = db.transaction(STORE_DM_MESSAGES, 'readonly');
  const messages = (await reqResult<ForumDmMessage[]>(
    msgTx.objectStore(STORE_DM_MESSAGES).index('viewerIdentityAccountId').getAll(viewerIdentityAccountId),
  )) || [];
  const counterparts = Array.from(new Set(messages.map(m => m.counterpartAccountId)));
  // 已读标记另开一个事务，所有 get 同步发出——不跨 await 复用上一个事务
  const settingsStore = db.transaction(STORE_SETTINGS, 'readonly').objectStore(STORE_SETTINGS);
  const marks = await Promise.all(counterparts.map(c =>
    reqResult<ForumReadMarkRow | undefined>(settingsStore.get(`${READ_MARK_PREFIX}${dmReadKey(viewerIdentityAccountId, c)}`)),
  ));
  const readAt = new Map(counterparts.map((c, i) => [c, marks[i]?.at ?? epoch]));

  const result = new Map<string, number>();
  for (const m of messages) {
    if (m.fromAccountId !== m.counterpartAccountId) continue; // 自己发的不算
    if (m.createdAt <= (readAt.get(m.counterpartAccountId) ?? epoch)) continue;
    result.set(m.counterpartAccountId, (result.get(m.counterpartAccountId) || 0) + 1);
  }
  return result;
}

/** 多个身份各自的未读私信总数（切换面板、左侧私信图标的红点用）。 */
export async function getDmUnreadTotals(viewerIdentityAccountIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for (const id of viewerIdentityAccountIds) {
    const byCounterpart = await getDmUnreadByCounterpart(id);
    let total = 0;
    byCounterpart.forEach(n => { total += n; });
    result.set(id, total);
  }
  return result;
}

// ==================== 评论：按作者查 / 批量计数 ====================

/** 某个账号发过的所有评论，最新的在前。"我发过的评论"用。 */
export async function getCommentsByAuthor(authorAccountId: string): Promise<ForumComment[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_COMMENTS, 'readonly');
  const idx = tx.objectStore(STORE_COMMENTS).index('authorAccountId');
  const comments = (await reqResult<ForumComment[]>(idx.getAll(authorAccountId))) || [];
  comments.sort((a, b) => b.createdAt - a.createdAt);
  return comments;
}

/**
 * 一次事务里数出多条帖子各自的评论数。
 *
 * 列表页原来是每条帖子单独把全部评论读出来再数长度，一页 15 条就是 15 次串行查询；
 * 这里只走索引计数（不把评论内容读出来），而且所有请求在同一个事务里并发发出。
 */
export async function getCommentCountsByPosts(postIds: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const ids = Array.from(new Set(postIds.filter(Boolean)));
  if (ids.length === 0) return result;
  const db = await openDb();
  const tx = db.transaction(STORE_COMMENTS, 'readonly');
  const idx = tx.objectStore(STORE_COMMENTS).index('postId');
  const counts = await Promise.all(ids.map(id => reqResult<number>(idx.count(id))));
  ids.forEach((id, i) => result.set(id, counts[i] || 0));
  return result;
}

/** 按 id 批量取帖子（"我发过的评论"要显示每条评论挂在哪个帖子下）。 */
export async function getForumPostsByIds(postIds: string[]): Promise<Map<string, ForumPost>> {
  const result = new Map<string, ForumPost>();
  const ids = Array.from(new Set(postIds.filter(Boolean)));
  if (ids.length === 0) return result;
  const db = await openDb();
  const tx = db.transaction(STORE_POSTS, 'readonly');
  const store = tx.objectStore(STORE_POSTS);
  const posts = await Promise.all(ids.map(id => reqResult<ForumPost | undefined>(store.get(id))));
  posts.forEach(p => { if (p) result.set(p.id, p); });
  return result;
}

/** 通知页的已读标记键。通知列表本身不分账号（你名下任何号被回复都算），所以标记也只有一份。 */
export function notificationReadKey(): string {
  return 'notif__all';
}

/**
 * 按时间倒序取最近若干条评论，走 createdAt 索引的反向游标。
 *
 * 通知页原来是把所有帖子拉出来、再逐条 getCommentsByPost 数过去——帖子有 200 条就是
 * 200 次串行查询，而且把每条评论的正文全读进内存了。这里只往回走 limit 条就停，
 * 跟库里总共有多少帖子无关。
 */
export async function getRecentForumComments(limit = 400): Promise<ForumComment[]> {
  if (limit <= 0) return [];
  const db = await openDb();
  const tx = db.transaction(STORE_COMMENTS, 'readonly');
  const idx = tx.objectStore(STORE_COMMENTS).index('createdAt');
  return new Promise<ForumComment[]>((resolve, reject) => {
    const out: ForumComment[] = [];
    const req = idx.openCursor(null, 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) { resolve(out); return; }
      out.push(cursor.value as ForumComment);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/** 按 id 批量取评论（通知要知道"这条回的是我哪一条评论"）。 */
export async function getForumCommentsByIds(ids: string[]): Promise<Map<string, ForumComment>> {
  const result = new Map<string, ForumComment>();
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (unique.length === 0) return result;
  const db = await openDb();
  const tx = db.transaction(STORE_COMMENTS, 'readonly');
  const store = tx.objectStore(STORE_COMMENTS);
  const rows = await Promise.all(unique.map(id => reqResult<ForumComment | undefined>(store.get(id))));
  rows.forEach(c => { if (c) result.set(c.id, c); });
  return result;
}

// ==================== 图片清理 ====================

/**
 * 把论坛库里存着的图片引用全部抹掉，用来腾本地空间。
 *
 * 只有两个地方存着图片令牌：帖子的 images、账号的 avatar/banner（评论和私信都是纯文本）。
 * 这里抹掉的是**引用**，不是图片数据本身——数据在共享的 blob 库里，等下一轮
 * 「孤儿图片清理」(utils/blobGc.ts) 扫到没人引用了才真正释放。所以点完这个按钮
 * 空间不会立刻变小，得再跑一次那个清理。
 *
 * 外链图（http(s)）也一起去掉。它们本来就不占本地空间，但留着会让帖子图文不全，
 * 而且用户点这个按钮的意思就是"把图都清了"。
 *
 * 读和写分成两个事务：IndexedDB 的事务在微任务队列排空时会自动提交，
 * 在同一个 readwrite 事务里 await 一次 getAll 再回头 put，赶上时序不好就会
 * TransactionInactiveError。读完再开一个写事务不会有这个问题。
 */
export interface ForumImagePurgeResult {
  /** 有多少条帖子被清掉了配图。 */
  posts: number;
  /** 一共去掉了多少个图片引用。 */
  images: number;
  /** 有多少个账号被清掉了头像/背景图。 */
  accounts: number;
}

export async function purgeForumImages(
  options: { includeAccountArtwork?: boolean } = {},
): Promise<ForumImagePurgeResult> {
  const result: ForumImagePurgeResult = { posts: 0, images: 0, accounts: 0 };
  const database = await openDb();

  // ---- 帖子配图 ----
  const readPosts = database.transaction(STORE_POSTS, 'readonly');
  const allPosts = (await reqResult<ForumPost[]>(readPosts.objectStore(STORE_POSTS).getAll())) || [];
  const postsToStrip = allPosts.filter(p => Array.isArray(p.images) && p.images.length > 0);

  if (postsToStrip.length > 0) {
    const writePosts = database.transaction(STORE_POSTS, 'readwrite');
    const store = writePosts.objectStore(STORE_POSTS);
    for (const post of postsToStrip) {
      result.posts += 1;
      result.images += post.images!.length;
      const next: ForumPost = { ...post };
      delete next.images;
      store.put(next);
    }
    await txDone(writePosts);
  }

  if (!options.includeAccountArtwork) return result;

  // ---- 账号头像 / 背景图 ----
  const readAccounts = database.transaction(STORE_ACCOUNTS, 'readonly');
  const allAccounts = (await reqResult<ForumAccount[]>(readAccounts.objectStore(STORE_ACCOUNTS).getAll())) || [];
  const accountsToStrip = allAccounts.filter(a => !!a.avatar || !!a.banner);

  if (accountsToStrip.length > 0) {
    const writeAccounts = database.transaction(STORE_ACCOUNTS, 'readwrite');
    const store = writeAccounts.objectStore(STORE_ACCOUNTS);
    const now = Date.now();
    for (const account of accountsToStrip) {
      result.accounts += 1;
      result.images += (account.avatar ? 1 : 0) + (account.banner ? 1 : 0);
      const next: ForumAccount = { ...account, updatedAt: now };
      delete next.avatar;
      delete next.banner;
      store.put(next);
    }
    await txDone(writeAccounts);
  }

  return result;
}
