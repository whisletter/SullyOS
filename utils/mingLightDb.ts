/**
 * 「眠光」共读功能的数据层。
 *
 * 设计取舍：用一个独立的 IndexedDB 数据库（而不是塞进主程序那个巨大的
 * utils/db.ts），原因是：
 *   1. 主库 db.ts 有几千行、几十张表，插进去容易冲突、也容易手滑改错东西；
 *   2. 眠光的数据（书籍原文、阅读进度、批注）自成一体，独立开一个库风险最低；
 *   3. 后续如果要接入「设置→导出/导入」的统一备份，只需要在那边新增
 *      几行调用本文件导出的 exportAll / importAll 即可，不影响这里的实现。
 *
 * 缺点也要说清楚：现在这份数据 **不会** 自动包含在主程序的云备份/本地导出
 * 里，换浏览器或清缓存会丢失。等基础功能稳定后，我们再补上和主备份系统的
 * 对接。
 */

const DB_NAME = 'SullyOS_MingLight';
const DB_VERSION = 1;

const STORE_BOOKS = 'books';
const STORE_PROGRESS = 'progress';

export type MingLightTheme = 'day' | 'sepia' | 'green' | 'night';

export interface MingLightBook {
  id: string;
  charId: string;        // 这本书属于哪一个角色（每个角色书架独立）
  title: string;
  author?: string;
  coverUrl?: string;
  rawText: string;       // 导入的原始纯文本全文
  chapters: MingLightChapter[];
  createdAt: number;
}

export interface MingLightChapter {
  index: number;         // 第几章，从 0 开始
  title: string;         // 章节标题（自动识别到的，或「第N部分」兜底）
  startOffset: number;   // 在 rawText 里的起始字符位置
  endOffset: number;     // 结束字符位置（不含）
}

export interface MingLightProgress {
  id: string;            // `${bookId}__${charId}`
  bookId: string;
  charId: string;
  charOffset: number;    // 读到 rawText 的第几个字符
  theme: MingLightTheme;
  fontSize: number;      // px
  updatedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        const store = db.createObjectStore(STORE_BOOKS, { keyPath: 'id' });
        store.createIndex('charId', 'charId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_PROGRESS)) {
        const store = db.createObjectStore(STORE_PROGRESS, { keyPath: 'id' });
        store.createIndex('charId', 'charId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 把导入的纯文本自动切成章节。识别常见的中文章节标题写法，
 *  识别不到任何章节标题时，整本书当作「第一章」处理，不报错、不阻断导入。 */
export function splitIntoChapters(rawText: string): MingLightChapter[] {
  const chapterHeadingRe = /^(第[0-9一二三四五六七八九十百千万零]+[章节回卷部].{0,30})$/gm;
  const matches = [...rawText.matchAll(chapterHeadingRe)];

  if (matches.length === 0) {
    return [{ index: 0, title: '正文', startOffset: 0, endOffset: rawText.length }];
  }

  const chapters: MingLightChapter[] = [];
  matches.forEach((m, i) => {
    const start = m.index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? rawText.length) : rawText.length;
    chapters.push({
      index: i,
      title: m[1].trim().slice(0, 40),
      startOffset: start,
      endOffset: end,
    });
  });
  return chapters;
}

export async function getBooksForChar(charId: string): Promise<MingLightBook[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKS, 'readonly');
    const idx = tx.objectStore(STORE_BOOKS).index('charId');
    const req = idx.getAll(charId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function saveBook(book: MingLightBook): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKS, 'readwrite');
    tx.objectStore(STORE_BOOKS).put(book);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteBook(bookId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_BOOKS, STORE_PROGRESS], 'readwrite');
    tx.objectStore(STORE_BOOKS).delete(bookId);
    // 顺手把这本书的阅读进度也清掉，避免留孤儿数据
    const progressStore = tx.objectStore(STORE_PROGRESS);
    const idx = progressStore.index('charId');
    idx.openCursor().onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
      if (cursor) {
        if ((cursor.value as MingLightProgress).bookId === bookId) cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getProgress(bookId: string, charId: string): Promise<MingLightProgress | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROGRESS, 'readonly');
    const req = tx.objectStore(STORE_PROGRESS).get(`${bookId}__${charId}`);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveProgress(progress: MingLightProgress): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROGRESS, 'readwrite');
    tx.objectStore(STORE_PROGRESS).put(progress);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
