
import JSZip from 'jszip';

const DB_NAME = 'SullyOS_MingLight';
const DB_VERSION = 4;

const STORE_BOOKS = 'books';
const STORE_PROGRESS = 'progress';
const STORE_CHAPTER_SUMMARIES = 'chapterSummaries';
const STORE_SETTINGS = 'settings';

export type MingLightTheme = 'day' | 'sepia' | 'green' | 'night';
export type MingLightReadingMode = 'scroll' | 'paged';

export interface MingLightBook {
  id: string;
  charId: string;
  title: string;
  author?: string;
  coverUrl?: string;
  rawText: string;
  chapters: MingLightChapter[];
  annotations: MingLightAnnotation[];
  createdAt: number;
}

export interface MingLightAnnotation {
  id: string;
  bookId: string;
  charId: string;
  paragraphIndex: number;
  startOffset: number;
  endOffset: number;
  quotedText: string;
  source: 'user' | 'ta';
  comment: string;
  thread: MingLightThreadMessage[];
  createdAt: number;
  archivedAt?: number;
}

export interface MingLightThreadMessage {
  id: string;
  author: 'user' | 'ta';
  content: string;
  createdAt: number;
  annotations?: MingLightAnnotation[];
}

export interface MingLightParagraph {
  id: string;          // 稳定ID，格式 `p{全局序号}`，批注以后就锚定在这个ID上
  chapterIndex: number;
  text: string;
  startOffset: number;  // 仍保留字符偏移，兼容旧的 charOffset 进度字段
  endOffset: number;
}

export interface MingLightChapter {
  index: number;
  title: string;
  /** 目录层级，0 为一级章节。txt 导入的书没有层级概念，留空即可。 */
  level?: number;
  startOffset: number;
  endOffset: number;
  paragraphs: MingLightParagraph[];
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
  /** 已主动检查到的正文位置，用于控制 TA 每约 750 字只检查一次。 */
  taCheckedOffset?: number;
  updatedAt: number;
}

export interface MingLightChapterSummary {
  id: string; // `${bookId}__${chapterIndex}__${charId}`
  bookId: string;
  charId: string;
  chapterIndex: number;
  subjective: string; // TA带人设的主观读后感
  objective: string;  // 不带人设的客观内容总结
  createdAt: number;
}

export interface MingLightImportedBook {
  title: string;
  author: string;
  coverUrl: string;
  rawText: string;
  chapters: MingLightChapter[];
}

// 把一段章节文本切成带稳定ID的段落。txt 和 epub 两条导入路径共用这一个函数，
// 保证段落切分规则、ID 生成方式一致。
function paragraphsFromChapterText(
  chapterText: string,
  chapterIndex: number,
  chapterStartOffset: number,
  seqRef: { n: number },
): MingLightParagraph[] {
  const rawParas = chapterText.split(/\n\s*\n/);
  let cursor = 0;
  const paragraphs: MingLightParagraph[] = [];

  rawParas.forEach(p => {
    const trimmed = p.trim();
    const localIdx = chapterText.indexOf(p, cursor);
    const start = localIdx === -1 ? cursor : localIdx;
    const end = start + p.length;
    cursor = end;

    if (!trimmed) return;

    paragraphs.push({
      id: `p${seqRef.n++}`,
      chapterIndex,
      text: trimmed,
      startOffset: chapterStartOffset + start,
      endOffset: chapterStartOffset + end,
    });
  });

  if (paragraphs.length === 0 && chapterText.trim()) {
    paragraphs.push({
      id: `p${seqRef.n++}`,
      chapterIndex,
      text: chapterText.trim(),
      startOffset: chapterStartOffset,
      endOffset: chapterStartOffset + chapterText.length,
    });
  }

  return paragraphs;
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

function dirOf(path: string): string {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

/**
 * EPUB 里路径大小写不一致是很常见的打包错误（导航里写 Chapter01.xhtml，
 * 实际文件是 chapter01.xhtml）。浏览器里 zip 的 key 是大小写敏感的，
 * 直接查会 miss，所以额外建一份小写索引兜底。
 */
function buildZipIndex(zip: JSZip): Map<string, string> {
  const index = new Map<string, string>();
  zip.forEach(relativePath => {
    index.set(relativePath.toLowerCase(), relativePath);
  });
  return index;
}

function zipFileAt(
  zip: JSZip,
  index: Map<string, string>,
  path: string,
) {
  const direct = zip.file(path);
  if (direct) return direct;
  const real = index.get(path.toLowerCase());
  return real ? zip.file(real) : null;
}

/** 一份 xhtml 抽出来的正文，外加「每个锚点落在正文第几个字」的对照表。 */
interface XhtmlExtract {
  text: string;
  /** id / name → 在 text 里的字符下标 */
  anchors: Map<string, number>;
}

/**
 * 把一份 xhtml 转成纯文本，同时记录每个锚点的位置。
 *
 * 这里有个容易踩的坑：换行和空白的规整必须在遍历过程中就做完，不能像以前那样
 * 先拼成大字符串、再用正则统一清理。因为清理会删掉字符，删一次前面记下来的
 * 锚点下标就整体错位一次，锚点也就废了。所以下面用 pushText / pushBreak
 * 边走边规整，保证任何时刻 buf.length 就是最终文本里的真实下标。
 */
function parseXhtmlWithAnchors(xhtml: string): XhtmlExtract {
  const doc = new DOMParser().parseFromString(xhtml, 'text/html');

  doc.querySelectorAll('script,style,head').forEach(el => el.remove());

  const body = doc.body || doc.documentElement;

  const blockTags = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'BR', 'LI', 'TR', 'BLOCKQUOTE', 'HR',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  ]);

  let buf = '';
  const anchors = new Map<string, number>();

  const pushBreak = () => {
    buf = buf.replace(/[ \t]+$/, '');
    if (!buf) return; // 开头不留空行
    const trailing = /\n*$/.exec(buf)![0].length;
    if (trailing >= 2) return; // 最多连续两个换行 = 一个空行
    buf += '\n';
  };

  const pushText = (raw: string) => {
    const s = raw.replace(/\s+/g, ' ');
    if (!s) return;
    if (s === ' ' && (!buf || buf.endsWith('\n') || buf.endsWith(' '))) return;
    buf += s;
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(node.nodeValue || '');
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as Element;
    const isBlock = blockTags.has(el.tagName);

    if (isBlock) pushBreak();

    // 锚点位置要记在「这个元素的正文开始之前」，所以放在 pushBreak 之后
    const id = el.getAttribute('id');
    if (id) anchors.set(id, buf.length);

    const name = el.getAttribute('name'); // 老书常见的 <a name="x">
    if (name && !anchors.has(name)) anchors.set(name, buf.length);

    el.childNodes.forEach(walk);

    if (isBlock) pushBreak();
  };

  walk(body);

  // 只有开头的 trim 会让下标整体左移，统一补偿一次
  const lead = buf.length - buf.replace(/^\s+/, '').length;
  const text = buf.trim();

  if (lead > 0) {
    anchors.forEach((v, k) => anchors.set(k, Math.max(0, v - lead)));
  }
  anchors.forEach((v, k) => {
    if (v > text.length) anchors.set(k, text.length);
  });

  return { text, anchors };
}

/** 从导航文件里解析出来的一条目录项。 */
interface NavEntry {
  title: string;
  path: string;   // zip 内的绝对路径，已规整
  anchor: string; // 不含 #，可能为空
  level: number;  // 0 = 一级目录
}

/** EPUB3：nav.xhtml 里的 <nav epub:type="toc"> */
function parseNavXhtml(
  xhtml: string,
  navPath: string,
): NavEntry[] {
  const doc = new DOMParser().parseFromString(xhtml, 'text/html');
  const baseDir = dirOf(navPath);

  const navs = [...doc.querySelectorAll('nav')];
  const tocNav =
    navs.find(n =>
      (n.getAttribute('epub:type') || '').split(/\s+/).includes('toc'),
    ) ||
    navs.find(n => n.id === 'toc') ||
    navs[0];

  if (!tocNav) return [];

  const entries: NavEntry[] = [];

  const walkList = (list: Element, level: number) => {
    [...list.children].forEach(li => {
      if (li.tagName !== 'LI') return;

      const link = li.querySelector(':scope > a, :scope > span > a');
      const href = link?.getAttribute('href') || '';
      const title = (link?.textContent || '').replace(/\s+/g, ' ').trim();

      if (href && title) {
        const [rawPath, anchor = ''] = href.split('#');
        entries.push({
          title,
          path: rawPath
            ? normalizeZipPath(baseDir, decodeURIComponent(rawPath))
            : navPath, // href="#xxx" 指向导航文件自己
          anchor: decodeURIComponent(anchor),
          level,
        });
      }

      const child = li.querySelector(':scope > ol, :scope > ul');
      if (child) walkList(child, level + 1);
    });
  };

  const root = tocNav.querySelector('ol, ul');
  if (root) walkList(root, 0);

  return entries;
}

/** EPUB2：toc.ncx 里的 <navMap><navPoint> */
function parseNcx(xml: string, ncxPath: string): NavEntry[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const baseDir = dirOf(ncxPath);
  const entries: NavEntry[] = [];

  const childrenNamed = (parent: Element, name: string) =>
    [...parent.children].filter(el => el.localName === name);

  const walkPoints = (parent: Element, level: number) => {
    childrenNamed(parent, 'navPoint').forEach(point => {
      // 只看直接子节点，否则会把嵌套子章节的标题/链接错当成自己的
      const label = childrenNamed(point, 'navLabel')[0];
      const title = (
        label ? label.textContent || '' : ''
      ).replace(/\s+/g, ' ').trim();

      const src = childrenNamed(point, 'content')[0]?.getAttribute('src') || '';

      if (title && src) {
        const [rawPath, anchor = ''] = src.split('#');
        entries.push({
          title,
          path: rawPath
            ? normalizeZipPath(baseDir, decodeURIComponent(rawPath))
            : ncxPath,
          anchor: decodeURIComponent(anchor),
          level,
        });
      }

      walkPoints(point, level + 1);
    });
  };

  const navMap = [...doc.documentElement.children].find(
    el => el.localName === 'navMap',
  );
  if (navMap) walkPoints(navMap, 0);

  return entries;
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
  const zipIndex = buildZipIndex(zip);

  const containerEntry = zipFileAt(zip, zipIndex, 'META-INF/container.xml');

  if (!containerEntry) {
    throw new Error('不是有效的 EPUB：找不到 container.xml');
  }

  const containerDoc = new DOMParser().parseFromString(
    await containerEntry.async('text'),
    'application/xml',
  );

  const rootfile = containerDoc
    .querySelector('rootfile[full-path]')
    ?.getAttribute('full-path');

  if (!rootfile) {
    throw new Error('EPUB 格式错误：找不到 OPF 文件');
  }

  const opfEntry = zipFileAt(zip, zipIndex, rootfile);

  if (!opfEntry) {
    throw new Error('EPUB 格式错误：无法读取 OPF 文件');
  }

  const opfDoc = new DOMParser().parseFromString(
    await opfEntry.async('text'),
    'application/xml',
  );

  const opfDir = dirOf(rootfile);

  const title =
    getMetaText(opfDoc, 'title') || file.name.replace(/\.epub$/i, '');

  const author = getMetaText(opfDoc, 'creator');

  const manifest = new Map<
    string,
    { href: string; mediaType: string; properties: string }
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

  // ---- 第一步：按 spine 顺序抽正文，记下每个文件在全书里的起点和锚点表 ----

  interface SpineFile {
    path: string;
    start: number;  // 在 rawText 里的起始字符
    length: number;
    anchors: Map<string, number>;
  }

  const spineFiles: SpineFile[] = [];
  let rawText = '';

  for (const id of spineIds) {
    const item = manifest.get(id);
    if (!item) continue;

    const isHtml =
      /xhtml|html/i.test(item.mediaType) ||
      /\.(xhtml?|html?)$/i.test(item.href);
    if (!isHtml) continue;

    const path = normalizeZipPath(
      opfDir,
      decodeURIComponent(item.href.split('#')[0]),
    );

    const entry = zipFileAt(zip, zipIndex, path);
    if (!entry) continue;

    const { text, anchors } = parseXhtmlWithAnchors(await entry.async('text'));
    if (!text) continue;

    if (rawText) rawText += '\n\n';

    const start = rawText.length; // 注意要在加完分隔符之后取，否则每章都会偏两个字符
    rawText += text;

    spineFiles.push({ path, start, length: text.length, anchors });
  }

  if (!spineFiles.length) {
    throw new Error('EPUB 中没有读取到正文内容');
  }

  // ---- 第二步：读真正的导航目录（EPUB3 优先，回退 EPUB2 的 ncx）----

  let navEntries: NavEntry[] = [];

  const navItem = [...manifest.values()].find(it =>
    /(^|\s)nav(\s|$)/.test(it.properties),
  );

  if (navItem) {
    const navPath = normalizeZipPath(
      opfDir,
      decodeURIComponent(navItem.href.split('#')[0]),
    );
    const navEntry = zipFileAt(zip, zipIndex, navPath);
    if (navEntry) {
      navEntries = parseNavXhtml(await navEntry.async('text'), navPath);
    }
  }

  if (navEntries.length < 2) {
    const tocId = opfDoc.querySelector('spine')?.getAttribute('toc');
    const ncxItem =
      (tocId ? manifest.get(tocId) : undefined) ||
      [...manifest.values()].find(
        it => /dtbncx/i.test(it.mediaType) || /\.ncx$/i.test(it.href),
      );

    if (ncxItem) {
      const ncxPath = normalizeZipPath(
        opfDir,
        decodeURIComponent(ncxItem.href.split('#')[0]),
      );
      const ncxEntry = zipFileAt(zip, zipIndex, ncxPath);
      if (ncxEntry) {
        const fromNcx = parseNcx(await ncxEntry.async('text'), ncxPath);
        if (fromNcx.length > navEntries.length) navEntries = fromNcx;
      }
    }
  }

  // ---- 第三步：把每条目录项换算成全书里的字符偏移 ----

  const fileByPath = new Map(spineFiles.map(f => [f.path, f]));

  const marked = navEntries
    .map(entry => {
      const file = fileByPath.get(entry.path);
      // 指向封面页、目录页这类不在 spine 里的文件，直接丢掉
      if (!file) return null;
      // 锚点在目标文件里不存在时退回文件开头，不让整条目录失效
      const local = entry.anchor ? file.anchors.get(entry.anchor) : 0;
      return { ...entry, offset: file.start + (local ?? 0) };
    })
    .filter((x): x is NavEntry & { offset: number } => x !== null)
    .sort((a, b) => a.offset - b.offset || a.level - b.level);

  // 同一个位置可能被一级和二级目录同时指到，只留层级最浅的那条
  const deduped: (NavEntry & { offset: number })[] = [];
  for (const m of marked) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.offset === m.offset) continue;
    deduped.push(m);
  }

  // 目录太细会让「每章读完自动生成读后感」触发得过于频繁，
  // 所以一级目录够多时只按一级切章，二级小节留给以后做目录内缩进跳转。
  const topLevel = deduped.filter(m => m.level === 0);
  const used = topLevel.length >= 3 ? topLevel : deduped;

  // ---- 第四步：切章 ----

  const chapters: MingLightChapter[] = [];
  const seqRef = { n: 0 };

  const pushChapter = (
    chapterTitle: string,
    level: number,
    start: number,
    end: number,
  ) => {
    const text = rawText.slice(start, end);
    if (!text.trim()) return; // 空壳章节不进目录，这正是以前「点进去没正文」的来源

    const index = chapters.length;
    chapters.push({
      index,
      title: (chapterTitle || `第 ${index + 1} 章`).slice(0, 80),
      level,
      startOffset: start,
      endOffset: end,
      paragraphs: paragraphsFromChapterText(text, index, start, seqRef),
    });
  };

  if (used.length >= 2) {
    const head = rawText.slice(0, used[0].offset).trim();

    if (head.length >= 200) {
      // 第一条目录之前还有不少字（一般是长序言），单独立一章
      pushChapter('卷首', 0, 0, used[0].offset);
    } else if (head.length > 0) {
      // 只是扉页那几个字，并进第一章，别让它变成一个点进去空白的条目
      used[0] = { ...used[0], offset: 0 };
    }

    used.forEach((entry, i) => {
      const end = i + 1 < used.length ? used[i + 1].offset : rawText.length;
      pushChapter(entry.title, entry.level, entry.offset, end);
    });
  } else {
    // 没有可用导航文件（资料里的「情况1」）：退回一个文件一章，
    // 但标题改用文件里第一行实际文字，并跳过明显是封面/版权的短文件。
    for (const file of spineFiles) {
      const text = rawText.slice(file.start, file.start + file.length);
      const firstLine = text.split('\n').map(s => s.trim()).find(Boolean) || '';

      const looksLikeFrontMatter =
        /cover|title|copyright|colophon|nav|toc|contents/i.test(file.path) &&
        text.trim().length < 500;
      if (looksLikeFrontMatter) continue;

      pushChapter(
        firstLine && firstLine.length <= 40
          ? firstLine
          : `第 ${chapters.length + 1} 章`,
        0,
        file.start,
        file.start + file.length,
      );
    }

    if (!chapters.length) {
      pushChapter('正文', 0, 0, rawText.length);
    }
  }

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

      if (!db.objectStoreNames.contains(STORE_CHAPTER_SUMMARIES)) {
        const store = db.createObjectStore(STORE_CHAPTER_SUMMARIES, {
          keyPath: 'id',
        });
        store.createIndex('bookId', 'bookId', { unique: false });
      }

      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'id' });
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

  let chapters: Omit<MingLightChapter, 'paragraphs'>[];

  if (matches.length === 0) {
    chapters = [
      {
        index: 0,
        title: '正文',
        startOffset: 0,
        endOffset: rawText.length,
      },
    ];
  } else {
    chapters = [];

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
  }

  // 每章内部再按空行切段落，段落带全局唯一稳定 ID（p0, p1, p2...），
  // 以后批注、章末总结都锚定在段落 ID 上，不再依赖字符偏移量去猜位置。
  const seqRef = { n: 0 };
  return chapters.map(ch => ({
    ...ch,
    paragraphs: paragraphsFromChapterText(
      rawText.slice(ch.startOffset, ch.endOffset),
      ch.index,
      ch.startOffset,
      seqRef,
    ),
  }));
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

// ---------- 章节总结 ----------

export async function getChapterSummary(
  bookId: string, chapterIndex: number, charId: string
): Promise<MingLightChapterSummary | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAPTER_SUMMARIES, 'readonly');
    const req = tx.objectStore(STORE_CHAPTER_SUMMARIES).get(`${bookId}__${chapterIndex}__${charId}`);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function getChapterSummariesForBook(bookId: string): Promise<MingLightChapterSummary[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAPTER_SUMMARIES, 'readonly');
    const idx = tx.objectStore(STORE_CHAPTER_SUMMARIES).index('bookId');
    const req = idx.getAll(bookId);
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.chapterIndex - b.chapterIndex));
    req.onerror = () => reject(req.error);
  });
}

export async function saveChapterSummary(s: MingLightChapterSummary): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_CHAPTER_SUMMARIES, 'readwrite');
    tx.objectStore(STORE_CHAPTER_SUMMARIES).put(s);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------- 眠光设置（副 API + 省调用开关）----------------

export interface MingLightSubApi {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface MingLightSettings {
  id: 'default';
  /**
   * 副 API。留空则回退用主 API。
   * 只作用于后台自动任务（TA 主动划线、章末总结、记忆归档），
   * 你点开批注跟 TA 对话仍然走主 API，那是要看质量的。
   */
  subApi: MingLightSubApi;
  /** TA 主动划线的检查间隔（字）。越大，一本书里 TA 开口的次数越少。 */
  taInterval: number;
  /** 章末总结是读到就自动生成，还是等你点开再生成。 */
  autoSummary: boolean;
  updatedAt: number;
}

export const DEFAULT_MINGLIGHT_SETTINGS: MingLightSettings = {
  id: 'default',
  subApi: { baseUrl: '', apiKey: '', model: '' },
  taInterval: 2500,
  autoSummary: true,
  updatedAt: 0,
};

export async function getMingLightSettings(): Promise<MingLightSettings> {
  const db = await openDb();
  return new Promise(resolve => {
    const tx = db.transaction(STORE_SETTINGS, 'readonly');
    const req = tx.objectStore(STORE_SETTINGS).get('default');
    req.onsuccess = () =>
      resolve({
        ...DEFAULT_MINGLIGHT_SETTINGS,
        ...(req.result || {}),
        subApi: {
          ...DEFAULT_MINGLIGHT_SETTINGS.subApi,
          ...(req.result?.subApi || {}),
        },
      });
    // 读设置失败不该把整个书架卡住，退回默认值就好
    req.onerror = () => resolve(DEFAULT_MINGLIGHT_SETTINGS);
  });
}

export async function saveMingLightSettings(
  settings: MingLightSettings,
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SETTINGS, 'readwrite');
    tx.objectStore(STORE_SETTINGS).put({ ...settings, updatedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ==================== 备份与恢复 ====================

/** 眠光备份数据的结构。字段名须与 FullBackupData.mingLight 对齐。 */
export interface MingLightBackupData {
  books: MingLightBook[];
  progress: MingLightProgress[];
  chapterSummaries: MingLightChapterSummary[];
  settings: MingLightSettings | null;
}

/** 把眠光独立库里的所有数据导出成一个纯 JSON 对象。 */
export async function exportMingLightAll(): Promise<MingLightBackupData> {
  const db = await openDb();

  const getAll = <T,>(storeName: string): Promise<T[]> =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });

  const getSettings = (): Promise<MingLightSettings | null> =>
    new Promise(resolve => {
      const tx = db.transaction(STORE_SETTINGS, 'readonly');
      const req = tx.objectStore(STORE_SETTINGS).get('default');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });

  const [books, progress, chapterSummaries, settings] = await Promise.all([
    getAll<MingLightBook>(STORE_BOOKS),
    getAll<MingLightProgress>(STORE_PROGRESS),
    getAll<MingLightChapterSummary>(STORE_CHAPTER_SUMMARIES),
    getSettings(),
  ]);

  return { books, progress, chapterSummaries, settings };
}

/**
 * 用备份数据覆盖眠光独立库的全部内容。
 * 策略：先清空再写入（和主库 importFullData 对 IDB store 的处理一致）。
 */
export async function importMingLightAll(
  backup: MingLightBackupData,
): Promise<void> {
  const db = await openDb();

  const clearAndPut = <T,>(storeName: string, items: T[]): Promise<void> =>
    new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      store.clear();
      for (const item of items) {
        store.put(item);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

  await clearAndPut(STORE_BOOKS, backup.books || []);
  await clearAndPut(STORE_PROGRESS, backup.progress || []);
  await clearAndPut(STORE_CHAPTER_SUMMARIES, backup.chapterSummaries || []);

  // settings 是单例，单独写
  if (backup.settings) {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_SETTINGS, 'readwrite');
      const store = tx.objectStore(STORE_SETTINGS);
      store.clear();
      store.put(backup.settings);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
