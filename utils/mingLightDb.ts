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

import JSZip from 'jszip';

const DB_NAME = 'SullyOS_MingLight';
const DB_VERSION = 2;

const STORE_BOOKS = 'books';
const STORE_PROGRESS = 'progress';

export type MingLightTheme = 'day' | 'sepia' | 'green' | 'night';
export type MingLightReadingMode = 'scroll' | 'paged';


export type MingLightAnnotationSource = 'user' | 'ta';

export interface MingLightThreadMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
}

export interface MingLightAnnotation {
  id: string;
  startOffset: number;
  endOffset: number;
  quotedText: string;
  source: MingLightAnnotationSource;
  comment: string;
  thread: MingLightThreadMessage[];
  createdAt: number;
  archivedToMemory?: boolean;
}

export interface MingLightBook {
  id: string;
  charId: string;
  title: string;
  author?: string;
  coverUrl?: string;
  rawText: string;
  chapters: MingLightChapter[];
  annotations?: MingLightAnnotation[];
  createdAt: number;
}

export interface MingLightChapter {
  index: number;
  title: string;
  startOffset: number;
  endOffset: number;
}

export interface MingLightProgress {
  id: string;
  bookId: string;
  charId: string;
  charOffset: number;
  theme: MingLightTheme;
  fontSize: number;
  readingMode?: MingLightReadingMode;
  page?: number;
  /** TA 已经检查到的用户阅读位置；仅用于控制主动批注请求频率。 */
  taCheckedOffset?: number;
  updatedAt: number;
}

export interface MingLightImportedBook {
  title: string;
  author: string;
  coverUrl: string;
  rawText: string;
  chapters: MingLightChapter[];
}

function normalizeZipPath(base: string, target: string): string {
  const cleanTarget = target.replace(/^\/+/, '');
  const parts = `${base}/${cleanTarget}`.split('/');
  const out: string[] = [];

  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }

  return out.join('/');
}

function textFromXhtml(xhtml: string): string {
  const doc = new DOMParser().parseFromString(xhtml, 'text/html');

  doc.querySelectorAll('script,style,head').forEach(el => el.remove());

  const body = doc.body || doc.documentElement;

  const blockTags = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'BR',
    'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR'
  ]);

  const parts: string[] = [];

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push((node.nodeValue || '').replace(/\s+/g, ' '));
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      node.childNodes.forEach(walk);
      return;
    }

    const el = node as Element;

    if (blockTags.has(el.tagName)) parts.push('\n');

    el.childNodes.forEach(walk);

    if (blockTags.has(el.tagName)) parts.push('\n');
  };

  walk(body);

  return parts
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getMetaText(doc: Document, name: string): string {
  const direct = doc.querySelector(`metadata > ${name}`);
  if (direct?.textContent?.trim()) {
    return direct.textContent.trim();
  }

  const prefixed = doc.querySelector(`dc\\:${name}`);
  if (prefixed?.textContent?.trim()) {
    return prefixed.textContent.trim();
  }

  const plain = doc.querySelector(name);
  return plain?.textContent?.trim() || '';
}

export async function importEpub(file: File): Promise<MingLightImportedBook> {
  const zip = await JSZip.loadAsync(file);

  const containerEntry = zip.file('META-INF/container.xml');

  if (!containerEntry) {
    throw new Error('不是有效的 EPUB：找不到 container.xml');
  }

  const containerXml = await containerEntry.async('text');

  const containerDoc = new DOMParser().parseFromString(
    containerXml,
    'application/xml'
  );

  const rootfile = containerDoc
    .querySelector('rootfile[full-path]')
    ?.getAttribute('full-path');

  if (!rootfile) {
    throw new Error('EPUB 格式错误：找不到 OPF 文件');
  }

  const opfEntry = zip.file(rootfile);

  if (!opfEntry) {
    throw new Error('EPUB 格式错误：无法读取 OPF 文件');
  }

  const opfText = await opfEntry.async('text');

  const opfDoc = new DOMParser().parseFromString(
    opfText,
    'application/xml'
  );

  const opfDir = rootfile.includes('/')
    ? rootfile.slice(0, rootfile.lastIndexOf('/'))
    : '';

  const title =
    getMetaText(opfDoc, 'title') ||
    file.name.replace(/\.epub$/i, '');

  const author = getMetaText(opfDoc, 'creator');

  const manifest = new Map<
    string,
    {
      href: string;
      mediaType: string;
      properties: string;
    }
  >();

  opfDoc.querySelectorAll('manifest > item, item').forEach(item => {
    const id = item.getAttribute('id') || '';
    const href = item.getAttribute('href') || '';

    if (id && href) {
      manifest.set(id, {
        href,
        mediaType: item.getAttribute('media-type') || '',
        properties: item.getAttribute('properties') || '',
      });
    }
  });

  const spineIds = [...opfDoc.querySelectorAll('spine > itemref, itemref')]
    .map(el => el.getAttribute('idref') || '')
    .filter(Boolean);

  const chapterTexts: {
    title: string;
    text: string;
  }[] = [];

  for (let i = 0; i < spineIds.length; i++) {
    const id = spineIds[i];
    const item = manifest.get(id);

    if (!item) continue;

    const isHtml =
      /xhtml|html/i.test(item.mediaType) ||
      /\.(xhtml?|html?)$/i.test(item.href);

    if (!isHtml) continue;

    const href = item.href.split('#')[0];

    const entry = zip.file(
      normalizeZipPath(opfDir, decodeURIComponent(href))
    );

    if (!entry) continue;

    const html = await entry.async('text');
    const text = textFromXhtml(html);

    if (!text) continue;

    const doc = new DOMParser().parseFromString(html, 'text/html');

    const heading =
      doc.querySelector('h1,h2,h3,h4,h5,h6')?.textContent?.trim();

    chapterTexts.push({
      title: heading || `第 ${chapterTexts.length + 1} 章`,
      text,
    });
  }

  if (!chapterTexts.length) {
    throw new Error('EPUB 中没有读取到正文内容');
  }

  let rawText = '';
  const chapters: MingLightChapter[] = [];

  chapterTexts.forEach((chapter, index) => {
    const startOffset = rawText.length;

    if (rawText) {
      rawText += '\n\n';
    }

    rawText += chapter.text;

    const endOffset = rawText.length;

    chapters.push({
      index,
      title: chapter.title.slice(0, 80),
      startOffset,
      endOffset,
    });
  });

  // 尝试寻找封面
  let coverHref = '';

  const coverId = opfDoc
    .querySelector('metadata meta[name="cover"]')
    ?.getAttribute('content');

  if (coverId && manifest.has(coverId)) {
    coverHref = manifest.get(coverId)!.href;
  }

  if (!coverHref) {
    for (const item of manifest.values()) {
      if (
        /^image\//i.test(item.mediaType) &&
        /cover/i.test(item.properties)
      ) {
        coverHref = item.href;
        break;
      }
    }
  }

  if (!coverHref) {
    for (const item of manifest.values()) {
      if (
        /^image\//i.test(item.mediaType) &&
        /cover/i.test(item.href)
      ) {
        coverHref = item.href;
        break;
      }
    }
  }

  let coverUrl = '';

  if (coverHref) {
    const coverEntry = zip.file(
      normalizeZipPath(
        opfDir,
        decodeURIComponent(coverHref.split('#')[0])
      )
    );

    if (coverEntry) {
      const blob = await coverEntry.async('blob');
      coverUrl = URL.createObjectURL(blob);
    }
  }

  return {
    title,
    author,
    coverUrl,
    rawText,
    chapters,
  };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(STORE_BOOKS)) {
        const store = db.createObjectStore(STORE_BOOKS, {
          keyPath: 'id',
        });

        store.createIndex('charId', 'charId', {
          unique: false,
        });
      }

      if (!db.objectStoreNames.contains(STORE_PROGRESS)) {
        const store = db.createObjectStore(STORE_PROGRESS, {
          keyPath: 'id',
        });

        store.createIndex('charId', 'charId', {
          unique: false,
        });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function splitIntoChapters(
  rawText: string
): MingLightChapter[] {
  const chapterHeadingRe =
    /^(第[0-9一二三四五六七八九十百千万零]+[章节回卷部].{0,30})$/gm;

  const matches = [...rawText.matchAll(chapterHeadingRe)];

  if (matches.length === 0) {
    return [
      {
        index: 0,
        title: '正文',
        startOffset: 0,
        endOffset: rawText.length,
      },
    ];
  }

  const chapters: MingLightChapter[] = [];

  matches.forEach((m, i) => {
    const start = m.index ?? 0;

    const end =
      i + 1 < matches.length
        ? matches[i + 1].index ?? rawText.length
        : rawText.length;

    chapters.push({
      index: i,
      title: m[1].trim().slice(0, 80),
      startOffset: start,
      endOffset: end,
    });
  });

  return chapters;
}

export async function getBooksForChar(
  charId: string
): Promise<MingLightBook[]> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKS, 'readonly');
    const idx = tx.objectStore(STORE_BOOKS).index('charId');
    const req = idx.getAll(charId);

    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function saveBook(
  book: MingLightBook
): Promise<void> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_BOOKS, 'readwrite');

    tx.objectStore(STORE_BOOKS).put(book);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteBook(
  bookId: string
): Promise<void> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      [STORE_BOOKS, STORE_PROGRESS],
      'readwrite'
    );

    tx.objectStore(STORE_BOOKS).delete(bookId);

    const progressStore =
      tx.objectStore(STORE_PROGRESS);

    const idx = progressStore.index('charId');

    idx.openCursor().onsuccess = e => {
      const cursor =
        (e.target as IDBRequest<IDBCursorWithValue>)
          .result;

      if (cursor) {
        if (
          (cursor.value as MingLightProgress).bookId ===
          bookId
        ) {
          cursor.delete();
        }

        cursor.continue();
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getProgress(
  bookId: string,
  charId: string
): Promise<MingLightProgress | null> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      STORE_PROGRESS,
      'readonly'
    );

    const req = tx
      .objectStore(STORE_PROGRESS)
      .get(`${bookId}__${charId}`);

    req.onsuccess = () =>
      resolve(req.result || null);

    req.onerror = () => reject(req.error);
  });
}

export async function saveProgress(
  progress: MingLightProgress
): Promise<void> {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      STORE_PROGRESS,
      'readwrite'
    );

    tx.objectStore(STORE_PROGRESS).put(progress);

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
