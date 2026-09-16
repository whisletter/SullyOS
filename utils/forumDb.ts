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
  updatedAt: number;
}

// ==================== 数据库连接 ====================

const DB_NAME = 'SullyOS_Forum';
const DB_VERSION = 1;

const STORE_ACCOUNTS = 'accounts';
const STORE_POSTS = 'posts';
const STORE_COMMENTS = 'comments';
const STORE_ALT_BUDGETS = 'alt_budgets';
const STORE_IDENTITY_AWARENESS = 'identity_awareness';
const STORE_DM_MESSAGES = 'dm_messages';
const STORE_SETTINGS = 'settings';
const STORE_AI_TASKS = 'ai_tasks';

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
}

export async function exportForumAll(): Promise<ForumBackupData> {
  const db = await openDb();
  const getAll = <T,>(storeName: string): Promise<T[]> => {
    const tx = db.transaction(storeName, 'readonly');
    return reqResult<T[]>(tx.objectStore(storeName).getAll());
  };
  const [accounts, posts, comments, altBudgets, identityAwareness, dmMessages, settings] = await Promise.all([
    getAll<ForumAccount>(STORE_ACCOUNTS),
    getAll<ForumPost>(STORE_POSTS),
    getAll<ForumComment>(STORE_COMMENTS),
    getAll<ForumAltBudget>(STORE_ALT_BUDGETS),
    getAll<ForumIdentityAwareness>(STORE_IDENTITY_AWARENESS),
    getAll<ForumDmMessage>(STORE_DM_MESSAGES),
    getAll<ForumSettings>(STORE_SETTINGS),
  ]);
  return { accounts, posts, comments, altBudgets, identityAwareness, dmMessages, settings };
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
}

/** 一键清空全部（本轮不接入 UI，仅保留函数以后接 [交接4 一]）。 */
export async function wipeForumAllData(): Promise<void> {
  const db = await openDb();
  const stores = [
    STORE_ACCOUNTS, STORE_POSTS, STORE_COMMENTS, STORE_ALT_BUDGETS,
    STORE_IDENTITY_AWARENESS, STORE_DM_MESSAGES,
  ];
  for (const s of stores) {
    const tx = db.transaction(s, 'readwrite');
    tx.objectStore(s).clear();
    await txDone(tx);
  }
}
