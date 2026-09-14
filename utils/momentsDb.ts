/**
 * 朋友圈 · 独立 IndexedDB（SullyOS_Moments）
 *
 * 数据结构：
 *   posts      — 动态（用户发的 + TA 生成的），按时间倒序
 *   settings   — 每角色的朋友圈偏好（发布频率、封面图等）
 *
 * 备份：exportAll / importAll 供 OSContext 的 exportSystem / importSystem 调用。
 */

const DB_NAME = 'SullyOS_Moments';
const DB_VERSION = 1;
const STORE_POSTS = 'posts';
const STORE_SETTINGS = 'settings';

// ==================== 类型定义 ====================

/** 动态类型 */
export type MomentPostType = 'text' | 'image' | 'imageText' | 'music' | 'article';

/** 音乐卡片数据 */
export interface MomentMusicCard {
  songId?: number;
  songName: string;
  artists: string;
  albumPic: string;
}

/** 文章卡片数据 */
export interface MomentArticleCard {
  title: string;
  url?: string;
  body?: string;
  /** 封面图（链接识别抓到的 og:image，或手动没填时留空）。 */
  image?: string;
}

/** 评论 */
export interface MomentComment {
  id: string;
  author: 'user' | string;        // 'user' 或 charId
  authorName: string;
  replyTo?: string;                // 回复某条评论的 id
  replyToName?: string;            // 被回复人的名字（旧数据快照；新数据靠 replyToAuthor 实时读取）
  replyToAuthor?: 'user' | string; // 被回复人是 'user' 还是 charId，用于渲染时实时取当前名字，而不是用创建时的快照
  content: string;
  createdAt: number;
}

/** 一条朋友圈动态 */
export interface MomentPost {
  id: string;
  charId: string;                  // 所属角色（用于多角色隔离）
  author: 'user' | string;         // 'user' 或 charId
  authorName: string;
  authorAvatar?: string;
  type: MomentPostType;
  text?: string;                   // 文字内容
  images?: string[];               // 图片 URL 或 base64
  /**
   * 生成这些图片时用的英文描述（仅 AI 自动配图的动态才有）。重新生成失败的图片时
   * 复用同一句描述再调一次生图 API，而不是重新问 AI「这条要不要配图」——避免多打一次
   * 聊天补全 API，图的内容也和这条动态原本想表达的场景保持一致。
   */
  imagePrompt?: string;
  music?: MomentMusicCard;
  article?: MomentArticleCard;
  likes: string[];                 // 点赞人列表（'user' 或 charId）
  likeNames: string[];             // 点赞人名字列表（与 likes 一一对应）
  comments: MomentComment[];
  pinned?: boolean;
  /**
   * 仅"暂停营业"模式下、点 TA 朋友圈页面的🌼生成的历史动态才为 true。
   * 这批动态只在 TA 的"秘密空间"里展示，不出现在"我的朋友圈"混合时间线，
   * 也不出现在 TA 朋友圈子页面的常规列表里（那两处都要按这个字段过滤掉）。
   */
  isSecretMemory?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 朋友圈更新频率模式 */
export type MomentUpdateFrequency = '5min' | '30min' | '1h' | '2h' | 'paused';

/** 每角色的朋友圈设置 */
export interface MomentSettings {
  id: string;                      // charId
  // 用户封面
  userCoverImage?: string;         // 背景图 base64 或 URL
  userNickname?: string;           // 显示名
  userSignature?: string;          // 个性签名
  userAvatar?: string;             // 头像
  // TA 封面
  taCoverImage?: string;
  taSignature?: string;            // TA 的个性签名（TA 可自己改）
  // 生成设置
  taPostFrequency: number;         // TA 发布频率上限（每次打开最多生成几条）
  /**
   * TA 更新朋友圈的频率/状态。'paused'（暂停营业）时：打开 App / 从查手机跳转都不再
   * 自动生成新动态或回复评论区；TA 朋友圈页面的🔄手动按钮也被禁用；
   * 但🌼（秘密空间历史动态）依然可用，与这个状态是两套并列逻辑。
   */
  updateFrequency: MomentUpdateFrequency;
  asyncInteraction: boolean;       // 异步延时互动开关
  lastGeneratedAt: number;         // 上次 AI 生成时间戳
  // 秘密空间（🌼）：TA 自己的独立小天地，背景/名字/签名由 AI 生成，只有头像继承本体
  secretSpaceCoverImage?: string;
  secretSpaceName?: string;
  secretSpaceSignature?: string;
  updatedAt: number;
}

export const DEFAULT_MOMENT_SETTINGS: Omit<MomentSettings, 'id'> = {
  taPostFrequency: 3,
  updateFrequency: '30min',
  asyncInteraction: false,
  lastGeneratedAt: 0,
  updatedAt: Date.now(),
};

// ==================== 数据库操作 ====================

let dbCache: IDBDatabase | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbCache) return Promise.resolve(dbCache);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_POSTS)) {
        const store = db.createObjectStore(STORE_POSTS, { keyPath: 'id' });
        store.createIndex('charId', 'charId', { unique: false });
        store.createIndex('author', 'author', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'id' });
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

// ---- Posts ----

export async function getPostsByCharId(charId: string): Promise<MomentPost[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_POSTS, 'readonly');
    const idx = tx.objectStore(STORE_POSTS).index('charId');
    const req = idx.getAll(charId);
    req.onsuccess = () => {
      const posts = (req.result || []) as MomentPost[];
      posts.sort((a, b) => {
        // 置顶优先，然后按时间倒序
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return b.createdAt - a.createdAt;
      });
      resolve(posts);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function savePost(post: MomentPost): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_POSTS, 'readwrite');
    tx.objectStore(STORE_POSTS).put(post);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('savePost aborted'));
  });
}

export async function deletePost(postId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_POSTS, 'readwrite');
    tx.objectStore(STORE_POSTS).delete(postId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export function createPostId(): string {
  return genId('mpost');
}

export function createCommentId(): string {
  return genId('mcmt');
}

// ---- Settings ----

export async function getMomentSettings(charId: string): Promise<MomentSettings> {
  const db = await openDb();
  return new Promise(resolve => {
    const tx = db.transaction(STORE_SETTINGS, 'readonly');
    const req = tx.objectStore(STORE_SETTINGS).get(charId);
    req.onsuccess = () => {
      resolve(req.result || { id: charId, ...DEFAULT_MOMENT_SETTINGS });
    };
    req.onerror = () => resolve({ id: charId, ...DEFAULT_MOMENT_SETTINGS });
  });
}

export async function saveMomentSettings(settings: MomentSettings): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SETTINGS, 'readwrite');
    tx.objectStore(STORE_SETTINGS).put({ ...settings, updatedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('saveMomentSettings aborted'));
  });
}

// ==================== 备份与恢复 ====================

export interface MomentsBackupData {
  posts: MomentPost[];
  settings: MomentSettings[];
}

export async function exportMomentsAll(): Promise<MomentsBackupData> {
  const db = await openDb();

  const getAll = <T,>(storeName: string): Promise<T[]> =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });

  const [posts, settings] = await Promise.all([
    getAll<MomentPost>(STORE_POSTS),
    getAll<MomentSettings>(STORE_SETTINGS),
  ]);

  return { posts, settings };
}

export async function importMomentsAll(backup: MomentsBackupData): Promise<void> {
  const db = await openDb();

  const clearStore = (storeName: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error(`clear ${storeName} aborted`));
    });

  const putOne = <T,>(storeName: string, item: T): Promise<void> =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(item);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error(`put ${storeName} aborted`));
    });

  // posts 可能含图片 base64，逐条写入避免大事务 abort
  await clearStore(STORE_POSTS);
  for (const post of (backup.posts || [])) {
    await putOne(STORE_POSTS, post);
  }

  // settings 数据量小
  await clearStore(STORE_SETTINGS);
  for (const s of (backup.settings || [])) {
    await putOne(STORE_SETTINGS, s);
  }
}
