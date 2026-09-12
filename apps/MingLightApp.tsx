/**
 * 「眠光」—— 和角色一起共读
 *
 * 当前版本：
 * - TXT / EPUB 导入
 * - EPUB 书名 / 作者 / 封面 / 章节
 * - 连续滚动阅读
 * - 四种阅读主题 / 字号
 * - 目录跳转
 * - 段落级下划线与批注（批注内容点击标识后才显示）
 * - TA 每约 750 字检查一次是否有真正想说的话
 * - 用户与 TA 都可以发起书中讨论
 * - 讨论可手动收藏进记忆宫殿
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  CaretLeft,
  Plus,
  BookOpen,
  Sun,
  Moon,
  Leaf,
  Coffee,
  TextAa,
  X,
  Trash,
  List,
  ChatCircleText,
  Quotes,
  BookmarkSimple,
  PaperPlaneTilt,
  Sparkle,
  ArrowClockwise,
  Gear,
  Flask,
} from '@phosphor-icons/react';

import { useOS } from '../context/OSContext';
import type {
  MingLightAnnotation,
  MingLightBook,
  MingLightProgress,
  MingLightTheme,
  MingLightChapterSummary,
  MingLightChapter,
  MingLightSettings,
} from '../utils/mingLightDb';
import {
  getBooksForChar,
  saveBook,
  deleteBook,
  getProgress,
  saveProgress,
  splitIntoChapters,
  importEpub,
  getChapterSummary,
  getChapterSummariesForBook,
  saveChapterSummary,
  getMingLightSettings,
  saveMingLightSettings,
  DEFAULT_MINGLIGHT_SETTINGS,
} from '../utils/mingLightDb';
import {
  TA_CHECK_INTERVAL,
  askTaForInsight,
  askTaToReply,
  archiveAnnotationThread,
  generateChapterSummary,
} from '../utils/mingLightAnnotations';
import {
  notifyMingLightMinimized,
  notifyMingLightOpened,
  notifyMingLightClosed,
  getMingLightLastBook,
} from '../utils/mingLightBridge';

/**
 * 一次滚动前进超过这么多字，就认为是目录跳转 / 恢复进度之类的跳跃，
 * 而不是真的读过去了，不触发章末总结。正常一屏也就几百字，留足余量。
 */
const CHAPTER_CROSS_LIMIT = 5000;

/**
 * 翻页模式下相邻两栏之间的间距。必须大于正文容器的左右内边距（px-5 = 20px），
 * 否则下一页的第一列会从 padding 区域里露出来——overflow:hidden 是按 padding box
 * 裁剪的，content box 之外那一圈依然可见。
 */
const PAGE_GAP = 48;

/** 翻页模式下正文四周留白。绝对定位时要用具体数值，不能靠 class 上的 padding。 */
const PAGE_PAD_X = 20;
const PAGE_PAD_Y = 24;

/** 横向滑动超过这个距离才算翻页，小于它当成误触或者选字。 */
const SWIPE_THRESHOLD = 40;

interface PageMetrics {
  pageWidth: number;
  stride: number; // 一页的位移量 = 栏宽 + 栏间距
}

/**
 * 算出一个段落横跨哪几页。
 *
 * CSS 多栏里，同一栏内的内容左边缘都对齐在这一栏的起点，所以用「段落左边缘到
 * 内容元素左边缘的距离 ÷ 每页位移」就能得到它从第几页开始。一段文字如果被断到
 * 下一栏，getBoundingClientRect 返回的是所有分片的并集，right 边就落在最后一栏，
 * 据此算出结束页。
 *
 * 两个 rect 都带着同一个 translateX，相减之后位移抵消，所以这个换算跟当前翻到
 * 第几页无关，不用先还原 transform 再测量。
 */
function nodePageRange(
  node: HTMLElement,
  contentLeft: number,
  metrics: PageMetrics,
): { start: number; end: number } {
  const rect = node.getBoundingClientRect();
  const start = Math.max(
    0,
    Math.round((rect.left - contentLeft) / metrics.stride),
  );
  const end = Math.max(
    start,
    Math.round((rect.right - contentLeft - metrics.pageWidth) / metrics.stride),
  );
  return { start, end };
}

/** 这一页上最后一段：最后一个「起始页 ≤ page」的段落。 */
function lastNodeOnPage(
  nodes: HTMLElement[],
  contentLeft: number,
  metrics: PageMetrics,
  page: number,
): number {
  let lo = 0;
  let hi = nodes.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (nodePageRange(nodes[mid], contentLeft, metrics).start <= page) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** 这一页上第一段：第一个「结束页 ≥ page」的段落，可能是上一页断下来的。 */
function firstNodeOnPage(
  nodes: HTMLElement[],
  contentLeft: number,
  metrics: PageMetrics,
  page: number,
): number {
  let lo = 0;
  let hi = nodes.length - 1;
  let ans = Math.max(0, nodes.length - 1);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (nodePageRange(nodes[mid], contentLeft, metrics).end >= page) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

const THEME_STYLES: Record<
  MingLightTheme,
  {
    bg: string;
    text: string;
    label: string;
    icon: React.ReactNode;
    panelBg: string;
  }
> = {
  day: {
    bg: '#FFFFFF',
    text: '#1F2937',
    label: '日间',
    icon: <Sun size={16} />,
    panelBg: '#FFFFFF',
  },
  sepia: {
    bg: '#F3E6D0',
    text: '#4A3B2A',
    label: '暖黄',
    icon: <Coffee size={16} />,
    panelBg: '#F3E6D0',
  },
  green: {
    bg: '#E1EDDD',
    text: '#2E402C',
    label: '护眼绿',
    icon: <Leaf size={16} />,
    panelBg: '#E1EDDD',
  },
  night: {
    bg: '#1A1A1E',
    text: '#D8D8DC',
    label: '夜间',
    icon: <Moon size={16} />,
    panelBg: '#1A1A1E',
  },
};

const USER_MARK = '#000daa';
const TA_MARK = '#daa000';

interface Paragraph {
  index: number;
  text: string;
  startOffset: number;
  endOffset: number;
}

function genId(prefix: string) {
  return `${prefix}_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function parseParagraphs(rawText: string): Paragraph[] {
  const text = rawText.replace(/\r\n?/g, '\n');
  const result: Paragraph[] = [];
  const re = /\n\s*\n/g;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text))) {
    const chunk = text.slice(last, match.index).trim();
    if (chunk) {
      const leading = text.slice(last, match.index).indexOf(chunk);
      const start = last + Math.max(0, leading);
      result.push({
        index: result.length,
        text: chunk,
        startOffset: start,
        endOffset: start + chunk.length,
      });
    }
    last = match.index + match[0].length;
  }

  const tail = text.slice(last).trim();
  if (tail) {
    const leading = text.slice(last).indexOf(tail);
    const start = last + Math.max(0, leading);
    result.push({
      index: result.length,
      text: tail,
      startOffset: start,
      endOffset: start + tail.length,
    });
  }

  // 某些 TXT 是“一行一个段落”，没有空行；这时再按单换行拆。
  if (result.length <= 1 && /\n/.test(text)) {
    const lines = text.split(/\n+/);
    const lineResult: Paragraph[] = [];
    let cursor = 0;
    for (const line of lines) {
      const clean = line.trim();
      const rawIndex = text.indexOf(line, cursor);
      if (clean) {
        const start = rawIndex + line.indexOf(clean);
        lineResult.push({
          index: lineResult.length,
          text: clean,
          startOffset: start,
          endOffset: start + clean.length,
        });
      }
      cursor = rawIndex + line.length;
    }
    if (lineResult.length > 1) return lineResult;
  }

  return result.length
    ? result
    : [{
        index: 0,
        text: text.trim(),
        startOffset: 0,
        endOffset: text.trim().length,
      }];
}

/**
 * 用真实的 DOM 位置换算「读到第几个字了」。
 *
 * 以前这里是 scrollTop ÷ 可滚动高度 × 全书字数。那个值虽然随滚动单调递增，
 * 但和真实位置的误差能到几百上千字：段落长短不均、字号可调、批注高亮还会撑高
 * 行盒。像「判断有没有读完这一章」这种要求精确的地方，估算值一律不能用。
 *
 * edge 取 'top' 是视口顶端（回来时接着读的位置），取 'bottom' 是视口底端
 * （已经读完的位置）。段落在文档流里自上而下排列，位置单调，所以可以二分，
 * 不用每次滚动都遍历几千个段落。
 */
function offsetAtViewportEdge(
  container: HTMLElement,
  nodes: HTMLElement[],
  paragraphs: Paragraph[],
  edge: 'top' | 'bottom',
): number {
  if (!nodes.length || !paragraphs.length) return 0;

  const box = container.getBoundingClientRect();
  const line = edge === 'top' ? box.top : box.bottom;

  let lo = 0;
  let hi = nodes.length - 1;
  let hit = edge === 'top' ? 0 : nodes.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (nodes[mid].getBoundingClientRect().bottom < line) {
      lo = mid + 1;
    } else {
      hit = mid;
      hi = mid - 1;
    }
  }

  const paragraph = paragraphs[Number(nodes[hit].dataset.mlParagraph)];
  if (!paragraph) return 0;

  return edge === 'top' ? paragraph.startOffset : paragraph.endOffset;
}

/** 滚到某个字符位置所在的那一段。目录跳转和恢复进度共用这一个实现。 */
function scrollToOffset(
  container: HTMLElement,
  paragraphs: Paragraph[],
  offset: number,
  totalLength: number,
  behavior: ScrollBehavior,
) {
  const target =
    paragraphs.find(p => p.endOffset > offset) ||
    paragraphs[paragraphs.length - 1];

  const node = target
    ? (container.querySelector(
        `[data-ml-paragraph="${target.index}"]`,
      ) as HTMLElement | null)
    : null;

  if (node) {
    const top =
      node.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop;

    container.scrollTo({ top: Math.max(0, top - 8), behavior });
    return;
  }

  // 段落还没渲染出来时的兜底
  const ratio = offset / Math.max(1, totalLength);
  container.scrollTo({
    top: ratio * Math.max(0, container.scrollHeight - container.clientHeight),
    behavior,
  });
}

function getParagraphAnnotationRange(
  annotation: MingLightAnnotation,
  paragraph: Paragraph,
) {
  const start = Math.max(
    0,
    annotation.startOffset - paragraph.startOffset,
  );
  const end = Math.min(
    paragraph.text.length,
    annotation.endOffset - paragraph.startOffset,
  );
  return start < end ? { start, end } : null;
}

function getRangeLocalOffsets(
  range: Range,
  paragraphElement: HTMLElement,
): { start: number; end: number } | null {
  const walker = document.createTreeWalker(
    paragraphElement,
    NodeFilter.SHOW_TEXT,
  );

  let node: Node | null;
  let start = -1;
  let end = -1;
  let total = 0;

  while ((node = walker.nextNode())) {
    const textLength = node.textContent?.length || 0;
    if (node === range.startContainer) {
      start = total + range.startOffset;
    }
    if (node === range.endContainer) {
      end = total + range.endOffset;
    }
    total += textLength;
  }

  if (start < 0 || end < 0 || start === end) return null;
  return start < end ? { start, end } : { start: end, end: start };
}

function selectionParagraph(
  selection: Selection,
): HTMLElement | null {
  const node = selection.anchorNode;
  const el = node?.parentElement;
  return el?.closest('[data-ml-paragraph]') as HTMLElement | null;
}

function normalizeThread(annotation: MingLightAnnotation) {
  return [
    {
      id: `${annotation.id}_initial`,
      author: annotation.source,
      content: annotation.comment,
      createdAt: annotation.createdAt,
    },
    ...(annotation.thread || []),
  ];
}

const MingLightApp: React.FC = () => {
  const {
    activeCharacterId,
    characters,
    closeApp,
    addToast,
    apiConfig,
    memoryPalaceConfig,
  } = useOS();

  // 缩小成悬浮球 / 重新展开时，跟悬浮球互相通知
  const resumeTriedRef = useRef(false);

  const char = characters.find(
    c => c.id === activeCharacterId,
  );

  const [books, setBooks] = useState<MingLightBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeBook, setActiveBook] =
    useState<MingLightBook | null>(null);
  const [progress, setProgress] =
    useState<MingLightProgress | null>(null);

  const [showImportModal, setShowImportModal] = useState(false);
  const [showChapters, setShowChapters] = useState(false);
  const [chapterSummaries, setChapterSummaries] = useState<Record<number, MingLightChapterSummary>>({});
  const [generatingSummaryFor, setGeneratingSummaryFor] = useState<number | null>(null);
  const [viewingSummaryFor, setViewingSummaryFor] = useState<number | null>(null);
  const [selectedAnnotation, setSelectedAnnotation] =
    useState<MingLightAnnotation | null>(null);
  const [selectionQuote, setSelectionQuote] = useState('');
  const [selectionStart, setSelectionStart] = useState(0);
  const [selectionEnd, setSelectionEnd] = useState(0);
  const [selectionParagraphIndex, setSelectionParagraphIndex] = useState(-1);
  const [showSelectionMenu, setShowSelectionMenu] = useState(false);
  const [showUserNoteComposer, setShowUserNoteComposer] = useState(false);
  const [userNote, setUserNote] = useState('');
  const [replyText, setReplyText] = useState('');
  const [sendingReply, setSendingReply] = useState(false);
  const [savingMemory, setSavingMemory] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const saveTimer = useRef<number | null>(null);
  const restoringRef = useRef(false);
  const lastAutoCheckRef = useRef(0);
  const autoBusyRef = useRef(false);
  const summaryBusyRef = useRef(false);
  /** 已经读过的最远位置。章末总结靠「这一轮滚动有没有跨过章尾」来判定。 */
  const readHighWaterRef = useRef(0);
  /** 段落 DOM 节点缓存，供滚动时二分查找当前阅读位置。 */
  const paragraphNodesRef = useRef<HTMLElement[]>([]);
  /** 翻页模式下的正文容器（多栏那一层）。 */
  const contentRef = useRef<HTMLDivElement>(null);
  /** 字号、宽度、模式变化后需要按 charOffset 重新定位到对应页。 */
  const relocateRef = useRef(false);
  const swipeRef = useRef<{ x: number; y: number } | null>(null);

  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [settings, setSettings] = useState<MingLightSettings>(
    DEFAULT_MINGLIGHT_SETTINGS,
  );
  const [showSettings, setShowSettings] = useState(false);
  const [pageInfo, setPageInfo] = useState({
    total: 1,
    chapterPage: 1,
    chapterTotal: 1,
    percent: 0,
    chapterTitle: '',
  });

  const paragraphs = useMemo(
    () => (activeBook ? parseParagraphs(activeBook.rawText) : []),
    [activeBook],
  );

  const annotations = activeBook?.annotations || [];

  const paragraphAnnotations = useMemo(() => {
    const map = new Map<number, MingLightAnnotation[]>();
    for (const annotation of annotations) {
      const list = map.get(annotation.paragraphIndex) || [];
      list.push(annotation);
      map.set(annotation.paragraphIndex, list);
    }
    return map;
  }, [annotations]);

  const isPaged = progress?.readingMode === 'paged';

  /**
   * 后台任务用的 API：填了副 API 就走副的，没填就回退主 API。
   * TA 主动划线、章末总结、记忆归档这些是自动跑的、量大且不吃质量，
   * 适合挂在便宜账户上；你点开批注跟 TA 对话仍然走主 API。
   */
  const bgApi = useMemo(() => {
    const sub = settings.subApi;
    if (sub.baseUrl.trim() && sub.model.trim()) {
      return {
        ...apiConfig,
        baseUrl: sub.baseUrl.trim(),
        apiKey: sub.apiKey.trim(),
        model: sub.model.trim(),
      };
    }
    return apiConfig;
  }, [settings.subApi, apiConfig]);
  const pageWidth = Math.max(0, viewport.w - PAGE_PAD_X * 2);
  const pageHeight = Math.max(0, viewport.h - PAGE_PAD_Y * 2);
  /** 内部一律用 0 起的页号，存进 progress.page 时再转成 1 起的。 */
  const pageIndex = Math.max(0, (progress?.page || 1) - 1);

  const getParagraphNodes = useCallback(
    (root: HTMLElement) => {
      // React 的 key 稳定，DOM 节点会被复用，所以只在数量变化时重建一次。
      if (paragraphNodesRef.current.length !== paragraphs.length) {
        paragraphNodesRef.current = Array.from(
          root.querySelectorAll<HTMLElement>('[data-ml-paragraph]'),
        );
      }
      return paragraphNodesRef.current;
    },
    [paragraphs.length],
  );

  // ---------------- 书架 ----------------

  useEffect(() => {
    let alive = true;
    getMingLightSettings()
      .then(s => {
        if (alive) setSettings(s);
      })
      .catch(() => {
        /* 读不到就用默认值，不打断使用 */
      });
    return () => {
      alive = false;
    };
  }, []);

  const refreshBooks = useCallback(async () => {
    if (!activeCharacterId) return;
    setLoading(true);
    try {
      const list = await getBooksForChar(activeCharacterId);
      setBooks(
        list.sort((a, b) => b.createdAt - a.createdAt),
      );
    } catch {
      addToast?.('书架加载失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [activeCharacterId, addToast]);

  useEffect(() => {
    refreshBooks();
  }, [refreshBooks]);

  // ---------------- 保存进度 ----------------

  const scheduleSaveProgress = useCallback(
    (next: MingLightProgress) => {
      setProgress(next);
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
      }
      saveTimer.current = window.setTimeout(() => {
        saveProgress(next).catch(() => {});
      }, 500);
    },
    [],
  );

  // ---------------- 打开书 ----------------

  const openBook = useCallback(
    async (book: MingLightBook) => {
      if (!activeCharacterId) return;
      const existing = await getProgress(
        book.id,
        activeCharacterId,
      );
      const next: MingLightProgress = existing || {
        id: `${book.id}__${activeCharacterId}`,
        bookId: book.id,
        charId: activeCharacterId,
        charOffset: 0,
        theme: 'day',
        fontSize: 18,
        readingMode: 'scroll',
        page: 1,
        taCheckedOffset: 0,
        updatedAt: Date.now(),
      };
      setActiveBook(book);
      setProgress(next);
      lastAutoCheckRef.current = next.taCheckedOffset || 0;
      readHighWaterRef.current = next.charOffset || 0;
      paragraphNodesRef.current = [];
      restoringRef.current = true;
      setShowChapters(false);
      setSelectedAnnotation(null);
      setShowSelectionMenu(false);
      notifyMingLightOpened(book.id);

      getChapterSummariesForBook(book.id)
        .then(list => {
          const map: Record<number, MingLightChapterSummary> = {};
          list.forEach(s => { map[s.chapterIndex] = s; });
          setChapterSummaries(map);
        })
        .catch(() => {});
    },
    [activeCharacterId],
  );

  // 从悬浮球点回来的：书架加载完之后，如果之前缩小时留了「最近这本书」，
  // 自动帮用户跳回去，不用再从书架重新点一次。
  useEffect(() => {
    if (loading || resumeTriedRef.current || activeBook) return;
    resumeTriedRef.current = true;
    const lastId = getMingLightLastBook();
    if (lastId) {
      const found = books.find(b => b.id === lastId);
      if (found) openBook(found);
    }
  }, [loading, books, activeBook, openBook]);

  // ---------------- 文件导入 ----------------

  const handleFileChosen = useCallback(
    async (file: File) => {
      if (!activeCharacterId) return;
      try {
        const fileName = file.name.toLowerCase();

        if (fileName.endsWith('.txt')) {
          const reader = new FileReader();
          reader.onload = async () => {
            try {
              const text = String(reader.result || '');
              if (!text.trim()) {
                addToast?.('这个文件读不到文字内容', 'error');
                return;
              }
              const title = file.name.replace(/\.txt$/i, '');
              const book: MingLightBook = {
                id: genId('ml'),
                charId: activeCharacterId,
                title,
                author: '',
                coverUrl: '',
                rawText: text,
                chapters: splitIntoChapters(text),
                annotations: [],
                createdAt: Date.now(),
              };
              await saveBook(book);
              setShowImportModal(false);
              addToast?.(`《${title}》导入成功`, 'success');
              await refreshBooks();
            } catch {
              addToast?.('TXT 导入失败', 'error');
            }
          };
          reader.onerror = () => addToast?.('读取文件失败', 'error');
          reader.readAsText(file, 'utf-8');
          return;
        }

        if (fileName.endsWith('.epub')) {
          addToast?.('正在读取 EPUB…', 'success');
          const imported = await importEpub(file);
          const book: MingLightBook = {
            id: genId('ml'),
            charId: activeCharacterId,
            title:
              imported.title ||
              file.name.replace(/\.epub$/i, ''),
            author: imported.author || '',
            coverUrl: imported.coverUrl || '',
            rawText: imported.rawText,
            chapters:
              imported.chapters?.length
                ? imported.chapters
                : splitIntoChapters(imported.rawText),
            annotations: [],
            createdAt: Date.now(),
          };
          await saveBook(book);
          setShowImportModal(false);
          addToast?.(`《${book.title}》导入成功`, 'success');
          await refreshBooks();
          return;
        }

        addToast?.('目前只支持 TXT 和 EPUB', 'error');
      } catch (error) {
        addToast?.(
          error instanceof Error ? error.message : '文件导入失败',
          'error',
        );
      }
    },
    [activeCharacterId, addToast, refreshBooks],
  );

  const handleDeleteBook = useCallback(
    async (bookId: string) => {
      await deleteBook(bookId);
      if (activeBook?.id === bookId) {
        setActiveBook(null);
        setProgress(null);
      }
      await refreshBooks();
    },
    [activeBook, refreshBooks],
  );

  // ---------------- 恢复阅读位置 ----------------

  useEffect(() => {
    if (!activeBook || !progress || !restoringRef.current) return;
    if (progress.readingMode === 'paged') {
      // 翻页模式不靠滚动定位，交给分页那套按 charOffset 算页号
      restoringRef.current = false;
      relocateRef.current = true;
      return;
    }
    const timer = window.setTimeout(() => {
      const el = readerRef.current;
      if (!el) return;
      scrollToOffset(
        el,
        paragraphs,
        progress.charOffset,
        activeBook.rawText.length,
        'auto',
      );
      restoringRef.current = false;
    }, 150);
    return () => window.clearTimeout(timer);
  }, [activeBook, progress, paragraphs]);

  // ---------------- TA 自动共读 ----------------

  const createTaAnnotation = useCallback(
    async (
      quote: string,
      comment: string,
      visibleStart: number,
    ) => {
      if (!activeBook || !activeCharacterId) return;

      const absoluteStart =
        activeBook.rawText.indexOf(quote, visibleStart);
      if (absoluteStart < 0) return;
      const absoluteEnd = absoluteStart + quote.length;

      const paragraph = paragraphs.find(
        p =>
          absoluteStart >= p.startOffset &&
          absoluteStart < p.endOffset,
      );
      if (!paragraph) return;

      const existingDuplicate = annotations.some(
        a =>
          a.source === 'ta' &&
          a.quotedText === quote &&
          Math.abs(a.startOffset - absoluteStart) < 4,
      );
      if (existingDuplicate) return;

      const annotation: MingLightAnnotation = {
        id: genId('ann'),
        bookId: activeBook.id,
        charId: activeCharacterId,
        paragraphIndex: paragraph.index,
        startOffset: absoluteStart,
        endOffset: absoluteEnd,
        quotedText: quote,
        source: 'ta',
        comment,
        thread: [],
        createdAt: Date.now(),
      };

      const updated = {
        ...activeBook,
        annotations: [...annotations, annotation],
      };

      await saveBook(updated);
      setActiveBook(updated);
    },
    [
      activeBook,
      activeCharacterId,
      annotations,
      paragraphs,
    ],
  );

  const maybeAskTa = useCallback(
    async (offset: number) => {
      if (
        !activeBook ||
        !progress ||
        autoBusyRef.current ||
        !apiConfig?.baseUrl ||
        !apiConfig?.model
      ) {
        return;
      }

      // 间隔可以在设置里调。默认 750 字太密了——20 万字的书一趟读下来
      // 光这一项就是两百多次调用。
      const interval = Math.max(TA_CHECK_INTERVAL, settings.taInterval);

      const checked = lastAutoCheckRef.current;
      if (offset - checked < interval) return;

      autoBusyRef.current = true;

      try {
        // 只看最近一小段，并且终点就是用户当前已经读到的位置。
        const from = Math.max(0, offset - interval);
        const visibleText = activeBook.rawText.slice(from, offset);

        const result = await askTaForInsight({
          api: bgApi,
          char: char!,
          visibleText,
        });

        if (result) {
          await createTaAnnotation(
            result.quote,
            result.comment,
            from,
          );
        }

        lastAutoCheckRef.current = offset;

        const nextProgress = {
          ...progress,
          taCheckedOffset: offset,
          updatedAt: Date.now(),
        };
        scheduleSaveProgress(nextProgress);
      } catch (error) {
        console.warn('MingLight TA auto note failed:', error);
      } finally {
        autoBusyRef.current = false;
      }
    },
    [
      activeBook,
      progress,
      apiConfig,
      bgApi,
      settings.taInterval,
      char,
      createTaAnnotation,
      scheduleSaveProgress,
    ],
  );

  // ---------------- 章末总结 ----------------

  /** 真正干活的那一步。自动触发和手动「重写」共用，区别只在要不要跳过已存在的检查。 */
  const runChapterSummary = useCallback(
    async (chapter: MingLightChapter) => {
      if (!activeBook || !activeCharacterId || !char) return;
      if (!apiConfig?.baseUrl || !apiConfig?.model) {
        addToast?.('还没配置好接口，生成不了读后感', 'error');
        return;
      }

      summaryBusyRef.current = true;
      setGeneratingSummaryFor(chapter.index);

      try {
        const chapterText = activeBook.rawText.slice(chapter.startOffset, chapter.endOffset);

        // 注意这里读的是「当前」的批注。所以事后补讨论几句再点重写，
        // 新讨论会被一起带进去——这正是重写按钮要解决的场景。
        const discussionExcerpt = (activeBook.annotations || [])
          .filter(a => a.startOffset >= chapter.startOffset && a.startOffset < chapter.endOffset)
          .map(a => {
            const lines = [`原句：${a.quotedText}`, `${a.source === 'ta' ? char.name : '用户'}：${a.comment}`];
            a.thread.forEach(m => lines.push(`${m.author === 'ta' ? char.name : '用户'}：${m.content}`));
            return lines.join('\n');
          })
          .join('\n\n')
          .slice(0, 3000);

        const result = await generateChapterSummary({
          api: bgApi,
          char,
          chapterText,
          discussionExcerpt,
        });

        const summary: MingLightChapterSummary = {
          id: `${activeBook.id}__${chapter.index}__${activeCharacterId}`,
          bookId: activeBook.id,
          charId: activeCharacterId,
          chapterIndex: chapter.index,
          subjective: result.subjective,
          objective: result.objective,
          createdAt: Date.now(),
        };

        await saveChapterSummary(summary);
        setChapterSummaries(prev => ({ ...prev, [chapter.index]: summary }));
        addToast?.(`《${chapter.title || '本章'}》读后感已生成`, 'success');
      } catch (error) {
        console.warn('MingLight chapter summary failed:', error);
        addToast?.('读后感生成失败，待会儿再试试', 'error');
      } finally {
        summaryBusyRef.current = false;
        setGeneratingSummaryFor(null);
      }
    },
    [activeBook, activeCharacterId, apiConfig, bgApi, char, addToast],
  );

  /** 手动重写：丢掉旧的那份，拿现在的讨论重新生成一次。 */
  const regenerateChapterSummary = useCallback(
    async (chapterIndex: number) => {
      if (!activeBook || summaryBusyRef.current) return;
      const chapter = activeBook.chapters.find(ch => ch.index === chapterIndex);
      if (!chapter) return;
      await runChapterSummary(chapter);
    },
    [activeBook, runChapterSummary],
  );

  const maybeGenerateChapterSummary = useCallback(
    async (offset: number) => {
      if (!activeBook || !activeCharacterId) return;

      const prev = readHighWaterRef.current;
      if (offset <= prev) return; // 往回翻不算读完

      // 目录跳转、恢复进度这类大跨度移动不能算「读完」，否则会把中间跳过的
      // 章节一次性全部补生成一遍。直接把水位挪过去。
      if (offset - prev > CHAPTER_CROSS_LIMIT) {
        readHighWaterRef.current = offset;
        return;
      }

      // 真正的判定：这一轮滚动有没有跨过某一章的结尾。
      // 以前是 `offset >= ch.endOffset && offset < 下一章.startOffset + 1`，
      // 也就是要求估算出来的 offset 正好落在章节交界那两三个字符里。而 offset
      // 是按滚动比例换算的，每次滚动事件往前跳好几十甚至上百字，这个窗口基本
      // 撞不上——除了最后一章（下一章起点是 Infinity，条件退化成「滚到底」），
      // 所以之前只有读完整本书时才偶尔弹一次。
      const finishedChapter = [...activeBook.chapters]
        .reverse()
        .find(
          ch =>
            ch.endOffset > ch.startOffset &&
            ch.endOffset > prev &&
            ch.endOffset <= offset,
        );

      if (!finishedChapter) {
        readHighWaterRef.current = offset;
        return;
      }

      // 跨过章尾了但这会儿生成不了（正在生成 / 没配好接口）：先不推进水位，
      // 等条件具备时下一次滚动还能补上，不至于永久错过这一章。
      if (
        summaryBusyRef.current ||
        !apiConfig?.baseUrl ||
        !apiConfig?.model
      ) {
        return;
      }

      if (chapterSummaries[finishedChapter.index]) {
        readHighWaterRef.current = offset; // 已经生成过
        return;
      }

      // 关掉自动生成后，读完只是记下位置，等你在目录里点「生成读后感」再跑。
      // 一本书里真正想看读后感的章节往往没几个，这一项能省掉大部分调用。
      if (!settings.autoSummary) {
        readHighWaterRef.current = offset;
        return;
      }

      readHighWaterRef.current = offset;
      await runChapterSummary(finishedChapter);
    },
    [
      activeBook,
      activeCharacterId,
      apiConfig,
      chapterSummaries,
      settings.autoSummary,
      runChapterSummary,
    ],
  );

  // ---------------- 横版翻页 ----------------

  // 量的是阅读视口本身。多栏容器的宽高必须是具体像素值——用 height:100% 的话，
  // 父级是 flex-1 撑开的，百分比高度在某些情况下会被当成 auto，容器就会跟着内容
  // 一直往下长，永远只有一栏，总页数算出来就是 1，也就翻不动页了。
  useEffect(() => {
    if (!isPaged) return;
    const el = readerRef.current;
    if (!el) return;

    const update = () =>
      setViewport(prev =>
        prev.w === el.clientWidth && prev.h === el.clientHeight
          ? prev
          : { w: el.clientWidth, h: el.clientHeight },
      );
    update();

    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [isPaged, activeBook]);

  // 字号、栏宽、模式一变，分页结果整个不一样，得按 charOffset 重新找回原来的位置
  useEffect(() => {
    relocateRef.current = true;
    paragraphNodesRef.current = [];
  }, [pageWidth, pageHeight, progress?.fontSize, isPaged, activeBook?.id]);

  useEffect(() => {
    if (!isPaged || !activeBook || !progress) return;
    if (pageWidth <= 0 || pageHeight <= 0) return;
    const el = contentRef.current;
    if (!el) return;

    // 等浏览器把多栏排完再测量，否则拿到的是上一次布局的数值
    const frame = window.requestAnimationFrame(() => {
      const nodes = getParagraphNodes(el);
      if (!nodes.length) return;

      const metrics: PageMetrics = {
        pageWidth,
        stride: pageWidth + PAGE_GAP,
      };
      const contentLeft = el.getBoundingClientRect().left;

      // 总页数取两种测量的较大值：一是最后一段落在第几栏，二是整体溢出宽度。
      // 单靠任何一个都可能在某些排版下失真，取 max 更稳。
      const byLastNode =
        nodePageRange(nodes[nodes.length - 1], contentLeft, metrics).end + 1;
      const byScrollWidth = Math.round(
        (el.scrollWidth + PAGE_GAP) / metrics.stride,
      );
      const total = Math.max(1, byLastNode, byScrollWidth);

      let page = Math.min(pageIndex, total - 1);

      if (relocateRef.current) {
        relocateRef.current = false;
        const idx = paragraphs.findIndex(
          p => p.endOffset > progress.charOffset,
        );
        const node = nodes[idx < 0 ? nodes.length - 1 : idx];
        if (node) {
          page = Math.min(
            nodePageRange(node, contentLeft, metrics).start,
            total - 1,
          );
        }
        if (page !== pageIndex) {
          scheduleSaveProgress({
            ...progress,
            page: page + 1,
            updatedAt: Date.now(),
          });
        }
      }

      const firstIdx = firstNodeOnPage(nodes, contentLeft, metrics, page);
      const lastIdx = lastNodeOnPage(nodes, contentLeft, metrics, page);
      const headOffset = paragraphs[firstIdx]?.startOffset ?? 0;
      const readOffset = paragraphs[lastIdx]?.endOffset ?? 0;

      const chapter =
        activeBook.chapters.find(
          ch => headOffset >= ch.startOffset && headOffset < ch.endOffset,
        ) || activeBook.chapters[0];

      let chapterPage = page + 1;
      let chapterTotal = total;

      if (chapter) {
        const startIdx = paragraphs.findIndex(
          p => p.endOffset > chapter.startOffset,
        );
        const endIdx = paragraphs.findIndex(
          p => p.endOffset >= chapter.endOffset,
        );
        const startPage =
          startIdx >= 0 && nodes[startIdx]
            ? nodePageRange(nodes[startIdx], contentLeft, metrics).start
            : 0;
        const endPage =
          endIdx >= 0 && nodes[endIdx]
            ? nodePageRange(nodes[endIdx], contentLeft, metrics).end
            : total - 1;
        chapterPage = Math.max(1, page - startPage + 1);
        chapterTotal = Math.max(chapterPage, endPage - startPage + 1);
      }

      const percent = Math.min(
        100,
        Math.round((readOffset / Math.max(1, activeBook.rawText.length)) * 100),
      );

      setPageInfo(prev =>
        prev.total === total &&
        prev.chapterPage === chapterPage &&
        prev.chapterTotal === chapterTotal &&
        prev.percent === percent &&
        prev.chapterTitle === (chapter?.title || '')
          ? prev
          : {
              total,
              chapterPage,
              chapterTotal,
              percent,
              chapterTitle: chapter?.title || '',
            },
      );
    });

    return () => window.cancelAnimationFrame(frame);
  }, [
    isPaged,
    pageWidth,
    pageHeight,
    pageIndex,
    paragraphs,
    activeBook,
    progress,
    getParagraphNodes,
    scheduleSaveProgress,
  ]);

  const goToPage = useCallback(
    (next: number) => {
      if (!activeBook || !progress || !isPaged) return;
      const el = contentRef.current;
      if (!el || pageWidth <= 0 || pageHeight <= 0) return;

      const target = Math.min(Math.max(0, next), Math.max(0, pageInfo.total - 1));
      if (target === pageIndex) return;

      const nodes = getParagraphNodes(el);
      if (!nodes.length) return;

      const metrics: PageMetrics = { pageWidth, stride: pageWidth + PAGE_GAP };
      const contentLeft = el.getBoundingClientRect().left;

      const firstIdx = firstNodeOnPage(nodes, contentLeft, metrics, target);
      const lastIdx = lastNodeOnPage(nodes, contentLeft, metrics, target);

      scheduleSaveProgress({
        ...progress,
        page: target + 1,
        charOffset: paragraphs[firstIdx]?.startOffset ?? progress.charOffset,
        updatedAt: Date.now(),
      });

      // 翻页模式下没有 scroll 事件，TA 主动划线和章末总结改由这里驱动，
      // 判定口径和滚动模式一致：都用「当前可见范围的末尾」当作已读位置。
      const readOffset = paragraphs[lastIdx]?.endOffset ?? 0;
      void maybeAskTa(readOffset);
      void maybeGenerateChapterSummary(readOffset);
    },
    [
      activeBook,
      progress,
      isPaged,
      pageWidth,
      pageHeight,
      pageIndex,
      pageInfo.total,
      paragraphs,
      getParagraphNodes,
      scheduleSaveProgress,
      maybeAskTa,
      maybeGenerateChapterSummary,
    ],
  );

  // ---------------- 选择文字 ----------------

  const captureSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const quote = selection.toString().trim();
    if (!quote) return;

    const paragraphEl = selectionParagraph(selection);
    if (!paragraphEl) return;

    const paragraphIndex = Number(
      paragraphEl.dataset.mlParagraph || '-1',
    );
    if (paragraphIndex < 0 || !paragraphs[paragraphIndex]) return;

    const local = getRangeLocalOffsets(
      selection.getRangeAt(0),
      paragraphEl,
    );
    if (!local) return;

    const paragraph = paragraphs[paragraphIndex];
    const absStart = paragraph.startOffset + local.start;
    const absEnd = paragraph.startOffset + local.end;

    setSelectionQuote(quote);
    setSelectionStart(absStart);
    setSelectionEnd(absEnd);
    setSelectionParagraphIndex(paragraphIndex);
    setShowSelectionMenu(true);
  }, [paragraphs]);

  // 桌面端没有触摸事件，补一套键盘左右键
  useEffect(() => {
    if (!isPaged) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        goToPage(pageIndex + 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        goToPage(pageIndex - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isPaged, goToPage, pageIndex]);

  const handlePageTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!isPaged) return;
      const touch = e.touches[0];
      swipeRef.current = { x: touch.clientX, y: touch.clientY };
    },
    [isPaged],
  );

  const handlePageTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      window.setTimeout(captureSelection, 80);

      const start = swipeRef.current;
      swipeRef.current = null;
      if (!isPaged || !start) return;

      // 长按选字再拖动也会产生位移，这时候不能当成翻页
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed) return;

      const touch = e.changedTouches[0];
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;

      if (Math.abs(dx) < SWIPE_THRESHOLD) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.5) return; // 更像是上下划

      goToPage(pageIndex + (dx < 0 ? 1 : -1));
    },
    [isPaged, captureSelection, goToPage, pageIndex],
  );

  // ---------------- 用户创建批注 ----------------

  /** 只保存批注，不调用 API 让 TA 回应。 */
  const saveUserAnnotationOnly = useCallback(async () => {
    if (
      !activeBook ||
      !activeCharacterId ||
      !selectionQuote ||
      selectionParagraphIndex < 0
    ) {
      return;
    }

    const comment = userNote.trim();
    if (!comment) return;

    const annotation: MingLightAnnotation = {
      id: genId('ann'),
      bookId: activeBook.id,
      charId: activeCharacterId,
      paragraphIndex: selectionParagraphIndex,
      startOffset: selectionStart,
      endOffset: selectionEnd,
      quotedText: selectionQuote,
      source: 'user',
      comment,
      thread: [],
      createdAt: Date.now(),
    };

    const updated: MingLightBook = {
      ...activeBook,
      annotations: [
        ...(activeBook.annotations || []),
        annotation,
      ],
    };

    await saveBook(updated);
    setActiveBook(updated);
    setSelectedAnnotation(annotation);
    setShowUserNoteComposer(false);
    setShowSelectionMenu(false);
    setUserNote('');
    window.getSelection()?.removeAllRanges();
  }, [
    activeBook,
    activeCharacterId,
    selectionQuote,
    selectionParagraphIndex,
    selectionStart,
    selectionEnd,
    userNote,
  ]);

  /** 保存批注，同时让 TA 立即回应。 */
  const saveUserAnnotationAndAskTa = useCallback(async () => {
    if (
      !activeBook ||
      !activeCharacterId ||
      !selectionQuote ||
      selectionParagraphIndex < 0
    ) {
      return;
    }

    const comment = userNote.trim();
    if (!comment) return;

    const annotation: MingLightAnnotation = {
      id: genId('ann'),
      bookId: activeBook.id,
      charId: activeCharacterId,
      paragraphIndex: selectionParagraphIndex,
      startOffset: selectionStart,
      endOffset: selectionEnd,
      quotedText: selectionQuote,
      source: 'user',
      comment,
      thread: [],
      createdAt: Date.now(),
    };

    let updated: MingLightBook = {
      ...activeBook,
      annotations: [
        ...(activeBook.annotations || []),
        annotation,
      ],
    };

    await saveBook(updated);
    setActiveBook(updated);
    setSelectedAnnotation(annotation);
    setShowUserNoteComposer(false);
    setShowSelectionMenu(false);
    setUserNote('');
    window.getSelection()?.removeAllRanges();

    // 让 TA 回应
    try {
      if (apiConfig?.baseUrl && apiConfig.model && char) {
        const paragraph = paragraphs[selectionParagraphIndex];
        const reply = await askTaToReply({
          api: apiConfig,
          char,
          quotedText: annotation.quotedText,
          paragraphText: paragraph?.text || annotation.quotedText,
          thread: [],
        });

        if (reply) {
          const taMessage = {
            id: genId('msg'),
            author: 'ta' as const,
            content: reply,
            createdAt: Date.now(),
          };

          updated = {
            ...updated,
            annotations: (updated.annotations || []).map(a =>
              a.id === annotation.id
                ? { ...a, thread: [taMessage] }
                : a,
            ),
          };

          await saveBook(updated);
          setActiveBook(updated);
          setSelectedAnnotation(
            updated.annotations!.find(a => a.id === annotation.id) || annotation,
          );
        }
      }
    } catch (error) {
      addToast?.(
        error instanceof Error ? error.message : 'TA 暂时没有回应',
        'error',
      );
    }
  }, [
    activeBook,
    activeCharacterId,
    selectionQuote,
    selectionParagraphIndex,
    selectionStart,
    selectionEnd,
    userNote,
    apiConfig,
    char,
    paragraphs,
    addToast,
  ]);

  // ---------------- 回复讨论 ----------------

  const sendReply = useCallback(async () => {
    if (
      !activeBook ||
      !selectedAnnotation ||
      !replyText.trim() ||
      !apiConfig?.baseUrl ||
      !apiConfig.model ||
      !char
    ) {
      return;
    }

    const text = replyText.trim();
    setReplyText('');
    setSendingReply(true);

    try {
      const baseThread = normalizeThread(selectedAnnotation);
      const paragraph = paragraphs[selectedAnnotation.paragraphIndex];

      const userMessage = {
        id: genId('msg'),
        author: 'user' as const,
        content: text,
        createdAt: Date.now(),
      };

      let updatedAnnotation: MingLightAnnotation = {
        ...selectedAnnotation,
        thread: [
          ...(selectedAnnotation.thread || []),
          userMessage,
        ],
      };

      let updatedBook: MingLightBook = {
        ...activeBook,
        annotations: (activeBook.annotations || []).map(a =>
          a.id === selectedAnnotation.id
            ? updatedAnnotation
            : a,
        ),
      };

      await saveBook(updatedBook);
      setActiveBook(updatedBook);
      setSelectedAnnotation(updatedAnnotation);

      const reply = await askTaToReply({
        api: apiConfig,
        char,
        quotedText: selectedAnnotation.quotedText,
        paragraphText: paragraph?.text || selectedAnnotation.quotedText,
        thread: baseThread.concat(userMessage),
        userMessage: text,
      });

      if (reply) {
        const taMessage = {
          id: genId('msg'),
          author: 'ta' as const,
          content: reply,
          createdAt: Date.now(),
        };

        updatedAnnotation = {
          ...updatedAnnotation,
          thread: [
            ...(updatedAnnotation.thread || []),
            taMessage,
          ],
        };

        updatedBook = {
          ...updatedBook,
          annotations: (updatedBook.annotations || []).map(a =>
            a.id === selectedAnnotation.id
              ? updatedAnnotation
              : a,
          ),
        };

        await saveBook(updatedBook);
        setActiveBook(updatedBook);
        setSelectedAnnotation(updatedAnnotation);
      }
    } catch (error) {
      addToast?.(
        error instanceof Error ? error.message : '讨论失败',
        'error',
      );
    } finally {
      setSendingReply(false);
    }
  }, [
    activeBook,
    selectedAnnotation,
    replyText,
    apiConfig,
    char,
    paragraphs,
    addToast,
  ]);

  // ---------------- 收藏进记忆宫殿 ----------------

  const archiveSelectedAnnotation = useCallback(async () => {
    if (
      !selectedAnnotation ||
      !char ||
      !activeBook ||
      savingMemory
    ) {
      return;
    }

    setSavingMemory(true);
    try {
      await archiveAnnotationThread({
        lightLLM: memoryPalaceConfig?.lightLLM,
        annotation: selectedAnnotation,
        char,
        bookTitle: activeBook.title,
      });

      const archived = {
        ...selectedAnnotation,
        archivedAt: Date.now(),
      };

      const updated = {
        ...activeBook,
        annotations: (activeBook.annotations || []).map(a =>
          a.id === archived.id ? archived : a,
        ),
      };

      await saveBook(updated);
      setActiveBook(updated);
      setSelectedAnnotation(archived);
      addToast?.('已收藏进记忆宫殿', 'success');
    } catch (error) {
      addToast?.(
        error instanceof Error
          ? error.message
          : '收藏失败，请检查记忆宫殿副 API 配置',
        'error',
      );
    } finally {
      setSavingMemory(false);
    }
  }, [
    selectedAnnotation,
    char,
    activeBook,
    savingMemory,
    memoryPalaceConfig,
    addToast,
  ]);

  // ---------------- 阅读滚动 ----------------

  const handleReaderScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (!activeBook || !progress) return;

      const el = e.currentTarget;
      const nodes = getParagraphNodes(el);

      // 视口顶端 = 下次回来接着读的地方；视口底端 = 已经读完的地方。
      // 章末判定要用底端，否则得等章尾滚到屏幕最上面才算读完，会偏晚一整屏。
      const topOffset = offsetAtViewportEdge(el, nodes, paragraphs, 'top');
      const readOffset = offsetAtViewportEdge(el, nodes, paragraphs, 'bottom');

      scheduleSaveProgress({
        ...progress,
        charOffset: topOffset,
        updatedAt: Date.now(),
      });

      // 不提前读后文：只在当前阅读位置已经跨过约 750 字时检查。
      void maybeAskTa(readOffset);
      void maybeGenerateChapterSummary(readOffset);
    },
    [
      activeBook,
      progress,
      paragraphs,
      getParagraphNodes,
      scheduleSaveProgress,
      maybeAskTa,
      maybeGenerateChapterSummary,
    ],
  );

  // ---------------- 目录跳转 ----------------

  const jumpToChapter = useCallback(
    (startOffset: number) => {
      if (!activeBook || !progress) return;

      // 跳章之后把已读水位挪到这一章开头，否则会被当成「一口气读完了中间所有章」
      readHighWaterRef.current = Math.max(
        readHighWaterRef.current,
        startOffset,
      );
      setShowChapters(false);

      if (isPaged) {
        // 翻页模式没有滚动，改成算出这一章落在第几页然后直接翻过去
        const el = contentRef.current;
        const nodes = el ? getParagraphNodes(el) : [];

        if (el && nodes.length && pageWidth > 0) {
          const metrics: PageMetrics = {
            pageWidth,
            stride: pageWidth + PAGE_GAP,
          };
          const contentLeft = el.getBoundingClientRect().left;
          const idx = paragraphs.findIndex(p => p.endOffset > startOffset);
          const node = nodes[idx < 0 ? 0 : idx];

          if (node) {
            const page = Math.min(
              nodePageRange(node, contentLeft, metrics).start,
              Math.max(0, pageInfo.total - 1),
            );
            scheduleSaveProgress({
              ...progress,
              page: page + 1,
              charOffset: startOffset,
              updatedAt: Date.now(),
            });
            return;
          }
        }
      }

      const el = readerRef.current;
      if (el) {
        // 找到这一章的第一段，直接滚到它真实的 DOM 位置。
        // 以前是用「起始字符数 ÷ 全书字数 × 可滚动高度」估的，段落长短不一、
        // 字号一调行高就变，估出来的位置必然和章节开头对不上。
        scrollToOffset(
          el,
          paragraphs,
          startOffset,
          activeBook.rawText.length,
          'smooth',
        );
      }

      scheduleSaveProgress({
        ...progress,
        charOffset: startOffset,
        updatedAt: Date.now(),
      });
    },
    [
      activeBook,
      progress,
      paragraphs,
      isPaged,
      pageWidth,
      pageInfo.total,
      getParagraphNodes,
      scheduleSaveProgress,
    ],
  );

  // ---------------- 选中操作定位 ----------------

  useEffect(() => {
    if (!showSelectionMenu) return;
    const hide = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('[data-ml-selection-menu]')) return;
      setShowSelectionMenu(false);
    };
    window.addEventListener('mousedown', hide);
    return () => window.removeEventListener('mousedown', hide);
  }, [showSelectionMenu]);

  if (!activeCharacterId || !char) {
    return (
      <div className="h-full flex items-center justify-center text-center px-8 text-sm text-gray-400">
        请先在聊天列表选择一个角色，再打开「眠光」。
      </div>
    );
  }

  // ==================================================
  // 阅读页
  // ==================================================

  if (activeBook && progress) {
    const theme = THEME_STYLES[progress.theme];

    return (
      <div
        className="h-full flex flex-col relative"
        style={{
          background: theme.bg,
          color: theme.text,
        }}
      >
        <style>
          {`
            .minglight-reader::-webkit-scrollbar {
              width: 16px;
              height: 16px;
            }
            .minglight-reader::-webkit-scrollbar-track {
              background: transparent;
            }
            .minglight-reader::-webkit-scrollbar-thumb {
              background: rgba(100,100,100,.45);
              border-radius: 10px;
              border: 3px solid transparent;
              background-clip: padding-box;
              min-height: 56px;
            }
            .minglight-reader::-webkit-scrollbar-thumb:hover,
            .minglight-reader::-webkit-scrollbar-thumb:active {
              background: rgba(100,100,100,.60);
              background-clip: padding-box;
            }
            .minglight-reader {
              scrollbar-width: auto;
              scrollbar-color: rgba(100,100,100,.45) transparent;
              -webkit-overflow-scrolling: touch;
            }
            .minglight-paragraph {
              position: relative;
              margin: 0 0 1.15em 0;
              padding-left: 10px;
              border-left: 3px solid transparent;
              scroll-margin-top: 24px;
            }
            .minglight-paragraph.has-user {
              border-left-color: ${USER_MARK};
            }
            .minglight-paragraph.has-ta {
              border-left-color: ${TA_MARK};
            }
            .minglight-selectable {
              user-select: text;
              -webkit-user-select: text;
              -webkit-touch-callout: default;
            }
          `}
        </style>

        {/* 顶部 */}
        <div
          className="flex items-center justify-between px-4 py-3 shrink-0"
          style={{ borderBottom: `1px solid ${theme.text}18` }}
        >
          <button
            onClick={() => {
              setActiveBook(null);
              setProgress(null);
              setSelectedAnnotation(null);
              setShowChapters(false);
            }}
            className="p-1"
          >
            <CaretLeft size={22} />
          </button>

          <div className="text-sm font-medium truncate max-w-[60%] text-center">
            {activeBook.title}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                notifyMingLightMinimized(activeBook.id);
                closeApp();
              }}
              className="p-1 text-xs border rounded-full px-2"
              style={{ borderColor: `${theme.text}40` }}
              aria-label="缩小成悬浮球"
            >
              缩小
            </button>
            <button
              onClick={() => {
                notifyMingLightClosed();
                closeApp();
              }}
              className="p-1"
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* 工具栏 */}
        <div
          className="flex items-center justify-center gap-2 py-2 flex-wrap shrink-0"
          style={{ borderBottom: `1px solid ${theme.text}18` }}
        >
          {(Object.keys(THEME_STYLES) as MingLightTheme[]).map(t => (
            <button
              key={t}
              onClick={() =>
                scheduleSaveProgress({
                  ...progress,
                  theme: t,
                  updatedAt: Date.now(),
                })
              }
              className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs border ${
                progress.theme === t
                  ? 'border-current'
                  : 'border-transparent opacity-50'
              }`}
            >
              {THEME_STYLES[t].icon}
              {THEME_STYLES[t].label}
            </button>
          ))}

          <div className="flex items-center gap-1 ml-2">
            <TextAa size={14} />
            <input
              type="range"
              min={14}
              max={28}
              value={progress.fontSize}
              onChange={e =>
                scheduleSaveProgress({
                  ...progress,
                  fontSize: Number(e.target.value),
                  updatedAt: Date.now(),
                })
              }
              className="w-20"
            />
          </div>

          <button
            onClick={() => {
              const nextMode = isPaged ? 'scroll' : 'paged';
              // 切回滚动模式要让恢复逻辑跑一次，把 charOffset 还原成滚动位置
              if (nextMode === 'scroll') restoringRef.current = true;
              scheduleSaveProgress({
                ...progress,
                readingMode: nextMode,
                page: 1,
                updatedAt: Date.now(),
              });
            }}
            className="flex items-center gap-1 px-2 py-1 rounded-full text-xs border"
            style={{ borderColor: `${theme.text}25` }}
          >
            <BookOpen size={14} />
            {isPaged ? '滚动' : '翻页'}
          </button>

          <button
            onClick={() => setShowChapters(v => !v)}
            className="flex items-center gap-1 px-2 py-1 rounded-full text-xs border"
            style={{ borderColor: `${theme.text}25` }}
          >
            <List size={14} />
            目录
          </button>
        </div>

        {/* 正文：按段落渲染，批注默认不展开 */}
        <div
          ref={readerRef}
          className={`minglight-reader flex-1 ${
            isPaged
              ? 'relative overflow-hidden'
              : 'overflow-y-auto overflow-x-hidden px-5 py-6'
          }`}
          style={{ fontSize: progress.fontSize }}
          onScroll={isPaged ? undefined : handleReaderScroll}
          onMouseUp={() => window.setTimeout(captureSelection, 0)}
          onTouchStart={handlePageTouchStart}
          onTouchEnd={
            isPaged
              ? handlePageTouchEnd
              : () => window.setTimeout(captureSelection, 80)
          }
        >
          <div
            ref={contentRef}
            className={isPaged ? '' : 'max-w-3xl mx-auto'}
            style={
              isPaged && pageWidth > 0 && pageHeight > 0
                ? {
                    position: 'absolute',
                    left: PAGE_PAD_X,
                    top: PAGE_PAD_Y,
                    // 宽高都给具体像素。栏宽等于容器宽度 → 一屏正好一栏，
                    // 排不下的内容自动生成溢出栏往右排，再用 translateX 把要看的
                    // 那一栏平移进视口。
                    width: pageWidth,
                    height: pageHeight,
                    columnWidth: `${pageWidth}px`,
                    columnGap: `${PAGE_GAP}px`,
                    columnFill: 'auto',
                    transform: `translateX(-${pageIndex * (pageWidth + PAGE_GAP)}px)`,
                    transition: 'transform 220ms ease',
                    willChange: 'transform',
                  }
                : undefined
            }
          >
            {paragraphs.map(paragraph => {
              const anns = paragraphAnnotations.get(paragraph.index) || [];
              const hasTa = anns.some(a => a.source === 'ta');
              const hasUser = anns.some(a => a.source === 'user');

              // 用区间把被批注的部分下划出来，批注正文本身永不直接显示。
              const boundaries = new Set<number>([0, paragraph.text.length]);
              const ranges = anns
                .map(a => ({
                  annotation: a,
                  range: getParagraphAnnotationRange(a, paragraph),
                }))
                .filter(
                  (x): x is { annotation: MingLightAnnotation; range: { start: number; end: number } } =>
                    !!x.range,
                );

              for (const item of ranges) {
                boundaries.add(item.range.start);
                boundaries.add(item.range.end);
              }

              const points = [...boundaries].sort((a, b) => a - b);

              return (
                <p
                  key={paragraph.index}
                  data-ml-paragraph={paragraph.index}
                  className={`minglight-paragraph minglight-selectable ${
                    hasTa ? 'has-ta' : hasUser ? 'has-user' : ''
                  } leading-relaxed`}
                >
                  {points.slice(0, -1).map((start, i) => {
                    const end = points[i + 1];
                    const segment = paragraph.text.slice(start, end);
                    const covering = ranges.filter(
                      x => x.range.start <= start && x.range.end >= end,
                    );
                    const annotation = covering[0]?.annotation;

                    if (!annotation) {
                      return (
                        <React.Fragment key={`${paragraph.index}_${start}`}>
                          {segment}
                        </React.Fragment>
                      );
                    }

                    return (
                      <span
                        key={`${paragraph.index}_${start}`}
                        style={{
                          textDecorationLine: 'underline',
                          textDecorationThickness: '2px',
                          textUnderlineOffset: '3px',
                          textDecorationColor:
                            annotation.source === 'ta'
                              ? TA_MARK
                              : USER_MARK,
                        }}
                      >
                        {segment}
                      </span>
                    );
                  })}

                  {anns.length > 0 && (
                    <span className="inline-flex items-center gap-1 ml-2 align-middle not-italic">
                      {anns.map(annotation => (
                        <button
                          key={annotation.id}
                          type="button"
                          title="查看批注"
                          onClick={e => {
                            e.stopPropagation();
                            setSelectedAnnotation(annotation);
                          }}
                          className="inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] shadow-sm"
                          style={{
                            background:
                              annotation.source === 'ta'
                                ? `${TA_MARK}35`
                                : `${USER_MARK}35`,
                            color:
                              annotation.source === 'ta'
                                ? TA_MARK
                                : USER_MARK,
                          }}
                        >
                          {annotation.source === 'ta' ? (
                            <Sparkle size={11} />
                          ) : (
                            <Quotes size={11} />
                          )}
                        </button>
                      ))}
                    </span>
                  )}
                </p>
              );
            })}
          </div>
        </div>

        {/* 页码条：章内页码 + 全书百分比 */}
        {isPaged && (
          <div
            className="flex items-center justify-between px-4 py-2 text-xs shrink-0"
            style={{ borderTop: `1px solid ${theme.text}15` }}
          >
            <button
              onClick={() => goToPage(pageIndex - 1)}
              disabled={pageIndex <= 0}
              className="px-2 py-1 rounded-full disabled:opacity-25"
              aria-label="上一页"
            >
              <CaretLeft size={16} />
            </button>

            <div className="flex-1 text-center truncate opacity-70">
              {pageInfo.chapterTitle ? `${pageInfo.chapterTitle} · ` : ''}
              {pageInfo.chapterPage}/{pageInfo.chapterTotal}
              <span className="mx-2 opacity-40">|</span>
              全书 {pageInfo.percent}%
            </div>

            <button
              onClick={() => goToPage(pageIndex + 1)}
              disabled={pageIndex >= pageInfo.total - 1}
              className="px-2 py-1 rounded-full disabled:opacity-25 rotate-180"
              aria-label="下一页"
            >
              <CaretLeft size={16} />
            </button>
          </div>
        )}

        {/* 文字选择菜单 */}
        {showSelectionMenu && selectionQuote && (
          <div
            data-ml-selection-menu
            className="absolute z-40 left-1/2 bottom-5 -translate-x-1/2 rounded-full shadow-lg px-3 py-2 flex items-center gap-2"
            style={{ background: theme.text, color: theme.bg }}
          >
            <button
              onClick={() => {
                setShowUserNoteComposer(true);
                setShowSelectionMenu(false);
              }}
              className="flex items-center gap-1 text-sm"
            >
              <Quotes size={15} />
              下划线＋批注
            </button>
          </div>
        )}

        {/* 左下角目录 */}
        <button
          onClick={() => setShowChapters(v => !v)}
          className="absolute bottom-4 left-4 z-20 w-11 h-11 rounded-full backdrop-blur flex items-center justify-center shadow"
          style={{ background: `${theme.text}18` }}
          aria-label="目录"
        >
          <List size={20} />
        </button>

        {/* 目录：跟随阅读主题 */}
        {showChapters && (
          <div
            className="absolute inset-0 z-30"
            style={{ background: `${theme.text}30` }}
            onClick={() => setShowChapters(false)}
          >
            <div
              className="absolute left-0 top-0 bottom-0 w-[82%] max-w-[380px] shadow-xl flex flex-col"
              style={{ background: theme.panelBg, color: theme.text }}
              onClick={e => e.stopPropagation()}
            >
              <div
                className="flex items-center justify-between px-4 py-4 shrink-0"
                style={{ borderBottom: `1px solid ${theme.text}18` }}
              >
                <div className="font-semibold">目录</div>
                <button
                  onClick={() => setShowChapters(false)}
                  className="p-1"
                >
                  <X size={20} />
                </button>
              </div>

              <div
                className="px-4 py-3 text-xs opacity-60 shrink-0"
                style={{ borderBottom: `1px solid ${theme.text}18` }}
              >
                {activeBook.title}
                {activeBook.author ? ` · ${activeBook.author}` : ''}
              </div>

              <div className="flex-1 overflow-y-auto">
                {activeBook.chapters.map((chapter, index) => {
                  const summary = chapterSummaries[chapter.index];
                  const generating = generatingSummaryFor === chapter.index;
                  return (
                    <div
                      key={`${chapter.index}_${index}`}
                      className="w-full flex items-center justify-between pr-4 py-3 text-sm active:opacity-60"
                      style={{
                        borderBottom: `1px solid ${theme.text}12`,
                        paddingLeft: 16 + (chapter.level || 0) * 16,
                        opacity: (chapter.level || 0) > 0 ? 0.75 : 1,
                      }}
                    >
                      <button
                        onClick={() => jumpToChapter(chapter.startOffset)}
                        className="flex-1 text-left truncate"
                      >
                        {chapter.title || `第 ${index + 1} 章`}
                      </button>
                      {generating ? (
                        <span className="text-xs opacity-50 shrink-0 ml-2">生成中…</span>
                      ) : summary ? (
                        <button
                          onClick={() => setViewingSummaryFor(chapter.index)}
                          className="text-xs shrink-0 ml-2 px-2 py-1 rounded-full border"
                          style={{ borderColor: `${theme.text}30` }}
                        >
                          读后感
                        </button>
                      ) : progress.charOffset >= chapter.endOffset ? (
                        // 已经读过但还没生成：关掉自动生成时靠这个按钮按需补
                        <button
                          onClick={() => runChapterSummary(chapter)}
                          disabled={generatingSummaryFor !== null}
                          className="text-xs shrink-0 ml-2 px-2 py-1 rounded-full border opacity-50 disabled:opacity-25"
                          style={{ borderColor: `${theme.text}25` }}
                        >
                          生成
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* 章末总结弹窗 */}
        {viewingSummaryFor !== null && chapterSummaries[viewingSummaryFor] && (
          <div
            className="absolute inset-0 z-40 flex items-center justify-center px-6"
            style={{ background: `${theme.text}30` }}
            onClick={() => setViewingSummaryFor(null)}
          >
            <div
              className="w-full max-w-sm max-h-[75%] overflow-y-auto rounded-2xl p-5 shadow-xl"
              style={{ background: theme.panelBg, color: theme.text }}
              onClick={e => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-3">
                <div className="font-semibold text-sm">
                  {activeBook.chapters[viewingSummaryFor]?.title || `第 ${viewingSummaryFor + 1} 章`} · 读后感
                </div>
                <div className="flex items-center gap-2 shrink-0 ml-2">
                  <button
                    onClick={() => regenerateChapterSummary(viewingSummaryFor)}
                    disabled={generatingSummaryFor !== null}
                    className="flex items-center gap-1 text-xs px-2 py-1 rounded-full border disabled:opacity-40"
                    style={{ borderColor: `${theme.text}30` }}
                  >
                    <ArrowClockwise
                      size={13}
                      className={
                        generatingSummaryFor === viewingSummaryFor
                          ? 'animate-spin'
                          : ''
                      }
                    />
                    {generatingSummaryFor === viewingSummaryFor ? '重写中' : '重写'}
                  </button>
                  <button onClick={() => setViewingSummaryFor(null)}><X size={18} /></button>
                </div>
              </div>

              <div className="mb-4">
                <div className="text-xs opacity-60 mb-1">{char?.name} 的感想</div>
                <div className="text-sm leading-relaxed whitespace-pre-wrap">
                  {chapterSummaries[viewingSummaryFor].subjective}
                </div>
              </div>

              <div>
                <div className="text-xs opacity-60 mb-1">客观内容总结</div>
                <div className="text-sm leading-relaxed whitespace-pre-wrap opacity-80">
                  {chapterSummaries[viewingSummaryFor].objective}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* 用户批注输入框 */}
        {showUserNoteComposer && (
          <div
            className="absolute inset-0 z-50 flex items-end justify-center bg-black/30 p-4"
            onClick={() => setShowUserNoteComposer(false)}
          >
            <div
              className="w-full max-w-xl rounded-2xl p-4 shadow-2xl"
              style={{
                background: theme.panelBg,
                color: theme.text,
              }}
              onClick={e => e.stopPropagation()}
            >
              <div className="text-xs opacity-50 mb-2">你划下来的句子</div>
              <div className="text-sm leading-relaxed mb-3 opacity-80">
                “{selectionQuote}”
              </div>

              <textarea
                autoFocus
                value={userNote}
                onChange={e => setUserNote(e.target.value)}
                placeholder="写下你的感想……"
                className="w-full min-h-[100px] rounded-xl border border-black/10 bg-transparent p-3 text-sm outline-none resize-none"
              />

              <div className="flex justify-end gap-2 mt-3">
                <button
                  onClick={() => setShowUserNoteComposer(false)}
                  className="px-4 py-2 text-sm opacity-60"
                >
                  取消
                </button>
                <button
                  onClick={saveUserAnnotationOnly}
                  disabled={!userNote.trim()}
                  className="px-4 py-2 rounded-full text-sm disabled:opacity-30"
                  style={{ background: `${USER_MARK}18`, color: theme.text }}
                >
                  仅保存
                </button>
                <button
                  onClick={saveUserAnnotationAndAskTa}
                  disabled={!userNote.trim()}
                  className="px-4 py-2 rounded-full text-sm disabled:opacity-30"
                  style={{ background: `${TA_MARK}30`, color: theme.text }}
                >
                  保存并让 TA 回应
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 批注 / 讨论框：点击标识后才出现 */}
        {selectedAnnotation && (
          <div
            className="absolute inset-0 z-50 flex items-end justify-center bg-black/30 p-4"
            onClick={() => setSelectedAnnotation(null)}
          >
            <div
              className="w-full max-w-xl max-h-[78%] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
              style={{
                background: theme.panelBg,
                color: theme.text,
              }}
              onClick={e => e.stopPropagation()}
            >
              <div
                className="flex items-center justify-between px-4 py-3 shrink-0"
                style={{ borderBottom: `1px solid ${theme.text}18` }}
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  {selectedAnnotation.source === 'ta' ? (
                    <Sparkle size={16} />
                  ) : (
                    <ChatCircleText size={16} />
                  )}
                  {selectedAnnotation.source === 'ta'
                    ? char.name
                    : '我的批注'}
                </div>

                <button
                  onClick={() => setSelectedAnnotation(null)}
                  className="p-1"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-4">
                <div className="text-xs opacity-50 mb-2">原句</div>
                <div className="text-sm leading-relaxed mb-4 pl-3 border-l-2 opacity-80">
                  “{selectedAnnotation.quotedText}”
                </div>

                {/* 首条批注 */}
                <div
                  className={`flex mb-3 ${
                    selectedAnnotation.source === 'user'
                      ? 'justify-end'
                      : 'justify-start'
                  }`}
                >
                  <div
                    className="max-w-[88%] rounded-2xl px-3 py-2 text-sm leading-relaxed"
                    style={{
                      background:
                        selectedAnnotation.source === 'ta'
                          ? `${TA_MARK}20`
                          : `${USER_MARK}20`,
                    }}
                  >
                    {selectedAnnotation.comment}
                  </div>
                </div>

                {/* 后续讨论 */}
                {(selectedAnnotation.thread || []).map(message => (
                  <div
                    key={message.id}
                    className={`flex mb-3 ${
                      message.author === 'user'
                        ? 'justify-end'
                        : 'justify-start'
                    }`}
                  >
                    <div
                      className="max-w-[88%] rounded-2xl px-3 py-2 text-sm leading-relaxed"
                      style={{
                        background:
                          message.author === 'ta'
                            ? `${TA_MARK}20`
                            : `${USER_MARK}20`,
                      }}
                    >
                      {message.content}
                    </div>
                  </div>
                ))}
              </div>

              {/* 底部操作：收藏明确由用户手动触发 */}
              <div
                className="px-4 py-3 shrink-0"
                style={{ borderTop: `1px solid ${theme.text}18` }}
              >
                <div className="flex items-center gap-2 mb-3">
                  <button
                    onClick={archiveSelectedAnnotation}
                    disabled={savingMemory || !!selectedAnnotation.archivedAt}
                    className="text-[11px] px-3 py-1.5 rounded-full border flex items-center gap-1 disabled:opacity-40"
                    style={{ borderColor: `${theme.text}20` }}
                  >
                    <BookmarkSimple size={13} />
                    {selectedAnnotation.archivedAt
                      ? '已收藏进记忆宫殿'
                      : savingMemory
                        ? '收藏中…'
                        : '收藏进记忆宫殿'}
                  </button>
                </div>

                <div className="flex items-end gap-2">
                  <textarea
                    value={replyText}
                    onChange={e => setReplyText(e.target.value)}
                    placeholder="回复这句话……"
                    className="flex-1 min-h-[44px] max-h-[100px] rounded-xl border border-black/10 bg-transparent p-2.5 text-sm outline-none resize-none"
                  />
                  <button
                    onClick={sendReply}
                    disabled={!replyText.trim() || sendingReply}
                    className="w-10 h-10 rounded-full flex items-center justify-center bg-black/10 disabled:opacity-30"
                    aria-label="发送"
                  >
                    <PaperPlaneTilt size={17} />
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ==================================================
  // 书架
  // ==================================================

  return (
    <div className="h-full flex flex-col bg-[#F7F2EA] relative overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={() => {
            notifyMingLightClosed();
            closeApp();
          }}
          className="p-1"
        >
          <CaretLeft size={22} />
        </button>

        <div className="text-base font-semibold">
          眠光 · 和{char.name}的书架
        </div>

        <div className="flex items-center gap-1">
          <button onClick={() => setShowSettings(true)} className="p-1">
            <Gear size={20} />
          </button>

          <button
            onClick={() => setShowImportModal(true)}
            className="p-1"
          >
            <Plus size={22} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
          加载中…
        </div>
      ) : books.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-gray-400 gap-3 px-8 text-center">
          <BookOpen size={40} />
          <div className="text-sm">
            书架还是空的，导入一本 TXT 或 EPUB 开始共读吧
          </div>
          <button
            onClick={() => setShowImportModal(true)}
            className="px-4 py-2 bg-amber-700 text-white rounded-full text-sm"
          >
            导入第一本书
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto grid grid-cols-3 gap-4 p-4">
          {books.map(book => (
            <div
              key={book.id}
              className="flex flex-col items-center gap-1"
              onClick={() => openBook(book)}
            >
              <div className="w-full aspect-[3/4] rounded-md bg-amber-100 border border-amber-300 flex items-center justify-center overflow-hidden relative group">
                {book.coverUrl ? (
                  <img
                    src={book.coverUrl}
                    alt={book.title}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <BookOpen
                    size={28}
                    className="text-amber-700"
                  />
                )}

                <button
                  onClick={e => {
                    e.stopPropagation();
                    handleDeleteBook(book.id);
                  }}
                  className="absolute top-1 right-1 bg-black/40 text-white rounded-full p-0.5 opacity-0 group-active:opacity-100"
                >
                  <Trash size={12} />
                </button>
              </div>

              <div className="text-xs text-center truncate w-full">
                {book.title}
              </div>

              {book.author && (
                <div className="text-[10px] text-gray-400 text-center truncate w-full">
                  {book.author}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 导入弹窗 */}
      {showSettings && (
        <MingLightSettingsPanel
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSave={async next => {
            setSettings(next);
            try {
              await saveMingLightSettings(next);
            } catch {
              addToast?.('设置保存失败', 'error');
            }
          }}
        />
      )}

      {showImportModal && (
        <div
          className="absolute inset-0 bg-black/40 flex items-center justify-center z-10"
          onClick={() => setShowImportModal(false)}
        >
          <div
            className="bg-white rounded-xl p-5 w-[80%] flex flex-col items-center gap-3"
            onClick={e => e.stopPropagation()}
          >
            <div className="text-sm text-gray-600 text-center">
              支持导入 TXT 和 EPUB
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,text/plain,.epub,application/epub+zip"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) handleFileChosen(f);
                e.currentTarget.value = '';
              }}
            />

            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-4 py-2 bg-amber-700 text-white rounded-full text-sm w-full"
            >
              选择文件
            </button>

            <button
              onClick={() => setShowImportModal(false)}
              className="text-xs text-gray-400"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default MingLightApp;

// ==================================================
// 设置面板：副 API + 省调用开关
// ==================================================

const MingLightSettingsPanel: React.FC<{
  settings: MingLightSettings;
  onSave: (next: MingLightSettings) => void;
  onClose: () => void;
}> = ({ settings, onSave, onClose }) => {
  const [baseUrl, setBaseUrl] = useState(settings.subApi.baseUrl);
  const [apiKey, setApiKey] = useState(settings.subApi.apiKey);
  const [model, setModel] = useState(settings.subApi.model);
  const [taInterval, setTaInterval] = useState(settings.taInterval);
  const [autoSummary, setAutoSummary] = useState(settings.autoSummary);

  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  const filled = !!(baseUrl.trim() && apiKey.trim() && model.trim());

  const inputClass =
    'w-full px-3 py-2 rounded-lg border border-gray-200 text-sm bg-white outline-none focus:border-amber-400';
  const labelClass =
    'block text-[11px] font-semibold text-gray-500 mb-1 pl-1 tracking-wide';

  const handleSave = () => {
    onSave({
      ...settings,
      subApi: {
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        model: model.trim(),
      },
      taInterval,
      autoSummary,
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  };

  const handleTest = async () => {
    if (!filled) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(
        `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey.trim()}`,
          },
          body: JSON.stringify({
            model: model.trim(),
            messages: [{ role: 'user', content: 'Hi' }],
            max_tokens: 5,
          }),
        },
      );

      if (res.ok) {
        const data = await res.json();
        const reply = String(data?.choices?.[0]?.message?.content || '');
        setTestResult({
          ok: true,
          text: `连接成功 — 模型回复：“${reply.slice(0, 30)}”`,
        });
      } else {
        const text = await res.text().catch(() => '');
        setTestResult({
          ok: false,
          text: `HTTP ${res.status}：${text.slice(0, 120)}`,
        });
      }
    } catch (err) {
      setTestResult({
        ok: false,
        text: `连接失败：${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-end justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="w-full max-h-[88%] overflow-y-auto rounded-t-2xl bg-[#FBF8F3] p-5"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm font-semibold">眠光设置</div>
          <button onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* 副 API */}
        <div className="rounded-2xl bg-white border border-amber-100 p-4 mb-4">
          <div className="text-xs font-bold text-amber-700 mb-2">
            副 API（OpenAI 兼容格式）
          </div>

          <div className="text-[11px] leading-relaxed text-gray-500 mb-3">
            只作用于后台自动任务：TA 主动划线、章末读后感。你点开批注跟 TA 对话仍然走主
            API，那是要看质量的。
            <br />
            <b>留空则自动回退用主 API</b>。想省主号额度就填一个便宜的对话模型，后台任务不需要多强的推理。
          </div>

          <div className="flex flex-col gap-3">
            <div>
              <label className={labelClass}>BASE URL</label>
              <input
                type="text"
                value={baseUrl}
                onChange={e => setBaseUrl(e.target.value)}
                placeholder="https://..."
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>API KEY</label>
              <input
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder="sk-..."
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>MODEL</label>
              <input
                type="text"
                value={model}
                onChange={e => setModel(e.target.value)}
                placeholder="一个便宜的对话模型名"
                className={inputClass}
              />
              <div className="text-[10px] text-gray-400 mt-1 pl-1">
                要的是<b>对话</b>模型，不是 embedding 向量模型。
              </div>
            </div>
          </div>

          <button
            onClick={handleTest}
            disabled={testing || !filled}
            className="w-full mt-3 py-2 rounded-xl text-sm font-semibold border border-amber-300 text-amber-700 bg-white disabled:opacity-40"
          >
            {testing ? (
              '测试中…'
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <Flask size={14} />
                测试 API 连接
              </span>
            )}
          </button>

          {testResult && (
            <div
              className="mt-2 text-xs px-3 py-2 rounded-lg"
              style={{
                background: testResult.ok ? '#f0fdf4' : '#fef2f2',
                color: testResult.ok ? '#16a34a' : '#dc2626',
              }}
            >
              {testResult.text}
            </div>
          )}

          {!filled && (
            <div className="mt-2 text-[11px] text-amber-700 font-medium">
              副 API 未配置 — 后台任务会回退使用主 API（功能正常，但会占主号额度）
            </div>
          )}
        </div>

        {/* 省调用 */}
        <div className="rounded-2xl bg-white border border-gray-100 p-4 mb-4">
          <div className="text-xs font-bold text-gray-600 mb-3">调用频率</div>

          <div className="mb-4">
            <div className="flex items-center justify-between text-xs mb-1">
              <span>TA 主动开口的间隔</span>
              <span className="font-semibold text-amber-700">
                每 {taInterval} 字
              </span>
            </div>
            <input
              type="range"
              min={750}
              max={8000}
              step={250}
              value={taInterval}
              onChange={e => setTaInterval(Number(e.target.value))}
              className="w-full"
            />
            <div className="text-[10px] text-gray-400 mt-1">
              20 万字的书读一遍，750 字约 267 次调用，2500 字约 80 次，5000 字约 40 次。
            </div>
          </div>

          <button
            onClick={() => setAutoSummary(v => !v)}
            className="w-full flex items-center justify-between text-xs"
          >
            <div className="text-left">
              <div>读完一章自动生成读后感</div>
              <div className="text-[10px] text-gray-400 mt-0.5">
                关掉之后改成在目录里手动点，只给你真正想看的章节生成
              </div>
            </div>
            <div
              className="w-10 h-6 rounded-full p-0.5 shrink-0 ml-3 transition-colors"
              style={{ background: autoSummary ? '#b45309' : '#d1d5db' }}
            >
              <div
                className="w-5 h-5 rounded-full bg-white transition-transform"
                style={{
                  transform: autoSummary
                    ? 'translateX(16px)'
                    : 'translateX(0)',
                }}
              />
            </div>
          </button>
        </div>

        <button
          onClick={handleSave}
          className="w-full py-2.5 rounded-xl text-sm font-bold text-white bg-amber-700"
        >
          {saved ? '✓ 已保存' : '保存副 API 配置'}
        </button>
      </div>
    </div>
  );
};
