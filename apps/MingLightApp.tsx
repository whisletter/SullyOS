/**
 * 「眠光」—— 和角色一起共读的阅读器
 *
 * 功能：
 * - TXT / EPUB 导入
 * - EPUB 自动获取书名、作者、封面、章节
 * - 目录跳转
 * - 滚动阅读 / 分页阅读
 * - 手机单页 / 平板双页自适应
 * - 页码显示
 * - 四种主题
 * - 字号调整
 * - 阅读进度自动保存
 */

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
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
  ArrowsLeftRight,
  CaretLeft as PrevIcon,
  CaretRight as NextIcon,
} from '@phosphor-icons/react';

import { useOS } from '../context/OSContext';

import {
  MingLightBook,
  MingLightProgress,
  MingLightTheme,
  MingLightReadingMode,
  getBooksForChar,
  saveBook,
  deleteBook,
  getProgress,
  saveProgress,
  splitIntoChapters,
  importEpub,
} from '../utils/mingLightDb';

const THEME_STYLES: Record<
  MingLightTheme,
  {
    bg: string;
    text: string;
    label: string;
    icon: React.ReactNode;
  }
> = {
  day: {
    bg: '#FFFFFF',
    text: '#1F2937',
    label: '日间',
    icon: <Sun size={16} />,
  },
  sepia: {
    bg: '#F3E6D0',
    text: '#4A3B2A',
    label: '暖黄',
    icon: <Coffee size={16} />,
  },
  green: {
    bg: '#E1EDDD',
    text: '#2E402C',
    label: '护眼绿',
    icon: <Leaf size={16} />,
  },
  night: {
    bg: '#1A1A1E',
    text: '#D8D8DC',
    label: '夜间',
    icon: <Moon size={16} />,
  },
};

function genId() {
  return `ml_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

/**
 * 判断当前设备是否适合双页：
 * - 手机：始终单页
 * - 平板：双页
 * - 桌面：宽度足够则双页
 *
 * 通过“屏幕最短边”判断触屏设备，
 * 避免手机横屏时误判为平板。
 */
function detectTwoPageMode(
  readerWidth: number
): boolean {
  if (!readerWidth) return false;

  const coarse =
    window.matchMedia?.(
      '(pointer: coarse)'
    ).matches ?? false;

  if (coarse) {
    const shortestScreenSide =
      Math.min(
        window.screen.width,
        window.screen.height
      );

    return (
      shortestScreenSide >= 600 &&
      readerWidth >= 650
    );
  }

  return readerWidth >= 850;
}

const MingLightApp: React.FC = () => {
  const {
    activeCharacterId,
    characters,
    closeApp,
    addToast,
  } = useOS();

  const char = characters.find(
    c => c.id === activeCharacterId
  );

  const [books, setBooks] =
    useState<MingLightBook[]>([]);

  const [loading, setLoading] =
    useState(true);

  const [activeBook, setActiveBook] =
    useState<MingLightBook | null>(null);

  const [progress, setProgress] =
    useState<MingLightProgress | null>(null);

  const [showImportModal, setShowImportModal] =
    useState(false);

  const [showChapters, setShowChapters] =
    useState(false);

  const [pageCount, setPageCount] =
    useState(1);

  const [totalPages, setTotalPages] =
    useState(1);

  const [currentPage, setCurrentPage] =
    useState(1);

  const [isTwoPage, setIsTwoPage] =
    useState(false);

  const fileInputRef =
    useRef<HTMLInputElement>(null);

  const readerRef =
    useRef<HTMLDivElement>(null);

  const textRef =
    useRef<HTMLDivElement>(null);

  const saveTimer =
    useRef<number | null>(null);

  const restoringRef =
    useRef(false);

  const [readerReady, setReaderReady] =
    useState(false);

  // --------------------------------------------------
  // 书架
  // --------------------------------------------------

  const refreshBooks = useCallback(
    async () => {
      if (!activeCharacterId) return;

      setLoading(true);

      try {
        const list =
          await getBooksForChar(
            activeCharacterId
          );

        setBooks(
          list.sort(
            (a, b) =>
              b.createdAt - a.createdAt
          )
        );
      } catch {
        addToast?.(
          '书架加载失败',
          'error'
        );
      } finally {
        setLoading(false);
      }
    },
    [activeCharacterId, addToast]
  );

  useEffect(() => {
    refreshBooks();
  }, [refreshBooks]);

  // --------------------------------------------------
  // 保存进度
  // --------------------------------------------------

  const scheduleSaveProgress =
    useCallback(
      (p: MingLightProgress) => {
        setProgress(p);

        if (saveTimer.current) {
          window.clearTimeout(
            saveTimer.current
          );
        }

        saveTimer.current =
          window.setTimeout(() => {
            saveProgress(p).catch(() => {});
          }, 500);
      },
      []
    );

  // --------------------------------------------------
  // 打开书
  // --------------------------------------------------

  const openBook = useCallback(
    async (book: MingLightBook) => {
      if (!activeCharacterId) return;

      const existing =
        await getProgress(
          book.id,
          activeCharacterId
        );

      const nextProgress: MingLightProgress =
        existing || {
          id: `${book.id}__${activeCharacterId}`,
          bookId: book.id,
          charId: activeCharacterId,
          charOffset: 0,
          theme: 'day',
          fontSize: 18,
          readingMode: 'scroll',
          page: 1,
          updatedAt: Date.now(),
        };

      setActiveBook(book);
      setProgress(nextProgress);
      setCurrentPage(
        nextProgress.page || 1
      );

      setReaderReady(false);
      restoringRef.current = true;
      setShowChapters(false);
    },
    [activeCharacterId]
  );

  // --------------------------------------------------
  // 导入 TXT / EPUB
  // --------------------------------------------------

  const handleFileChosen =
    useCallback(
      async (file: File) => {
        if (!activeCharacterId) return;

        try {
          const fileName =
            file.name.toLowerCase();

          // ---------------- TXT ----------------

          if (
            fileName.endsWith('.txt')
          ) {
            const reader =
              new FileReader();

            reader.onload =
              async () => {
                try {
                  const text =
                    String(
                      reader.result || ''
                    );

                  if (!text.trim()) {
                    addToast?.(
                      '这个文件读不到文字内容',
                      'error'
                    );
                    return;
                  }

                  const title =
                    file.name.replace(
                      /\.txt$/i,
                      ''
                    );

                  const book: MingLightBook =
                    {
                      id: genId(),
                      charId:
                        activeCharacterId,
                      title,
                      author: '',
                      coverUrl: '',
                      rawText: text,
                      chapters:
                        splitIntoChapters(
                          text
                        ),
                      createdAt:
                        Date.now(),
                    };

                  await saveBook(book);

                  setShowImportModal(
                    false
                  );

                  addToast?.(
                    `《${title}》导入成功`,
                    'success'
                  );

                  await refreshBooks();
                } catch {
                  addToast?.(
                    'TXT 导入失败',
                    'error'
                  );
                }
              };

            reader.onerror = () => {
              addToast?.(
                '读取文件失败',
                'error'
              );
            };

            reader.readAsText(
              file,
              'utf-8'
            );

            return;
          }

          // ---------------- EPUB ----------------

          if (
            fileName.endsWith('.epub')
          ) {
            addToast?.(
              '正在读取 EPUB…',
              'success'
            );

            const imported =
              await importEpub(file);

            const book: MingLightBook =
              {
                id: genId(),
                charId:
                  activeCharacterId,
                title:
                  imported.title ||
                  file.name.replace(
                    /\.epub$/i,
                    ''
                  ),
                author:
                  imported.author ||
                  '',
                coverUrl:
                  imported.coverUrl ||
                  '',
                rawText:
                  imported.rawText,
                chapters:
                  imported.chapters?.length
                    ? imported.chapters
                    : splitIntoChapters(
                        imported.rawText
                      ),
                createdAt:
                  Date.now(),
              };

            await saveBook(book);

            setShowImportModal(false);

            addToast?.(
              `《${book.title}》导入成功`,
              'success'
            );

            await refreshBooks();

            return;
          }

          addToast?.(
            '目前只支持 TXT 和 EPUB',
            'error'
          );
        } catch (error) {
          console.error(
            'MingLight import error:',
            error
          );

          addToast?.(
            error instanceof Error
              ? error.message
              : '文件导入失败',
            'error'
          );
        }
      },
      [
        activeCharacterId,
        addToast,
        refreshBooks,
      ]
    );

  // --------------------------------------------------
  // 删除书籍
  // --------------------------------------------------

  const handleDeleteBook =
    useCallback(
      async (bookId: string) => {
        await deleteBook(bookId);

        if (
          activeBook?.id === bookId
        ) {
          setActiveBook(null);
          setProgress(null);
        }

        await refreshBooks();
      },
      [activeBook, refreshBooks]
    );

  // --------------------------------------------------
  // 判断单双页
  // --------------------------------------------------

  const updateDeviceLayout =
    useCallback(() => {
      const el =
        readerRef.current;

      if (!el) return;

      setIsTwoPage(
        detectTwoPageMode(
          el.clientWidth
        )
      );
    }, []);

  useEffect(() => {
    if (!activeBook) return;

    const timer =
      window.setTimeout(
        updateDeviceLayout,
        80
      );

    window.addEventListener(
      'resize',
      updateDeviceLayout
    );

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(
        'resize',
        updateDeviceLayout
      );
    };
  }, [
    activeBook,
    updateDeviceLayout,
  ]);

  // --------------------------------------------------
  // 重新计算分页
  // --------------------------------------------------

  const updatePagination =
    useCallback(() => {
      const el =
        readerRef.current;

      if (
        !el ||
        !progress ||
        progress.readingMode !==
          'paged'
      ) {
        return;
      }

      const pagesPerSpread =
        isTwoPage ? 2 : 1;

      const columnWidth =
        Math.max(
          1,
          el.clientWidth /
            pagesPerSpread
        );

      const pages = Math.max(
        1,
        Math.round(
          el.scrollWidth /
            columnWidth
        )
      );

      const spreads =
        Math.max(
          1,
          Math.ceil(
            pages /
              pagesPerSpread
          )
        );

      setTotalPages(pages);
      setPageCount(spreads);

      setCurrentPage(p => {
        return Math.min(
          Math.max(1, p),
          spreads
        );
      });

      setReaderReady(true);
    },
    [
      progress,
      isTwoPage,
    ]);

  useEffect(() => {
    if (
      !activeBook ||
      !progress
    ) {
      return;
    }

    const timer =
      window.setTimeout(
        updatePagination,
        150
      );

    window.addEventListener(
      'resize',
      updatePagination
    );

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(
        'resize',
        updatePagination
      );
    };
  }, [
    activeBook,
    progress?.fontSize,
    progress?.readingMode,
    isTwoPage,
    updatePagination,
  ]);

  // --------------------------------------------------
  // 根据字符位置寻找真实页面
  // --------------------------------------------------

  const getTextOffsetPosition =
    useCallback(
      (offset: number) => {
        const container =
          textRef.current;

        if (!container) {
          return null;
        }

        const node =
          container.firstChild;

        if (
          !node ||
          node.nodeType !==
            Node.TEXT_NODE
        ) {
          return null;
        }

        const text =
          node.textContent || '';

        const safeOffset =
          Math.min(
            Math.max(
              0,
              offset
            ),
            text.length
          );

        try {
          const range =
            document.createRange();

          range.setStart(
            node,
            safeOffset
          );

          range.setEnd(
            node,
            safeOffset
          );

          const rect =
            range.getBoundingClientRect();

          const readerRect =
            readerRef.current?.getBoundingClientRect();

          if (!readerRect) {
            return null;
          }

          return {
            left:
              rect.left -
              readerRect.left,
            top:
              rect.top -
              readerRect.top,
          };
        } catch {
          return null;
        }
      },
      []
    );

  // --------------------------------------------------
  // 恢复上次阅读位置
  // --------------------------------------------------

  useEffect(() => {
    if (
      !activeBook ||
      !progress ||
      !readerReady ||
      !restoringRef.current
    ) {
      return;
    }

    const timer =
      window.setTimeout(() => {
        const el =
          readerRef.current;

        if (!el) return;

        const position =
          getTextOffsetPosition(
            progress.charOffset
          );

        if (
          progress.readingMode ===
          'paged'
        ) {
          if (
            position &&
            el.clientWidth
          ) {
            const spread =
              Math.max(
                0,
                Math.floor(
                  position.left /
                    el.clientWidth
                )
              );

            const page =
              Math.min(
                pageCount,
                spread + 1
              );

            setCurrentPage(page);

            el.scrollLeft =
              spread *
              el.clientWidth;
          } else {
            const ratio =
              progress.charOffset /
              Math.max(
                1,
                activeBook.rawText
                  .length
              );

            el.scrollLeft =
              ratio *
              Math.max(
                0,
                el.scrollWidth -
                  el.clientWidth
              );
          }
        } else {
          if (position) {
            el.scrollTop =
              Math.max(
                0,
                position.top
              );
          } else {
            const ratio =
              progress.charOffset /
              Math.max(
                1,
                activeBook.rawText
                  .length
              );

            el.scrollTop =
              ratio *
              Math.max(
                0,
                el.scrollHeight -
                  el.clientHeight
              );
          }
        }

        restoringRef.current = false;
      }, 120);

    return () =>
      window.clearTimeout(timer);
  }, [
    activeBook,
    progress,
    readerReady,
    pageCount,
    getTextOffsetPosition,
  ]);

  // --------------------------------------------------
  // 跳转到指定章节
  // --------------------------------------------------

  const jumpToOffset =
    useCallback(
      (
        offset: number
      ) => {
        const el =
          readerRef.current;

        if (!el) return;

        const mode =
          progress?.readingMode ||
          'scroll';

        const position =
          getTextOffsetPosition(
            offset
          );

        if (
          mode === 'paged'
        ) {
          if (
            position &&
            el.clientWidth
          ) {
            const spread =
              Math.max(
                0,
                Math.floor(
                  position.left /
                    el.clientWidth
                )
              );

            const page =
              Math.min(
                pageCount,
                spread + 1
              );

            setCurrentPage(page);

            el.scrollTo({
              left:
                spread *
                el.clientWidth,
              behavior: 'smooth',
            });

            if (progress) {
              scheduleSaveProgress({
                ...progress,
                page,
                charOffset: offset,
                updatedAt:
                  Date.now(),
              });
            }
          }

          return;
        }

        if (position) {
          el.scrollTo({
            top: Math.max(
              0,
              position.top
            ),
            behavior: 'smooth',
          });
        }

        if (progress) {
          scheduleSaveProgress({
            ...progress,
            charOffset: offset,
            updatedAt:
              Date.now(),
          });
        }
      },
      [
        progress,
        pageCount,
        getTextOffsetPosition,
        scheduleSaveProgress,
      ]
    );

  // --------------------------------------------------
  // 翻页
  // --------------------------------------------------

  const goToPage =
    useCallback(
      (page: number) => {
        const el =
          readerRef.current;

        if (!el) return;

        const next =
          Math.min(
            Math.max(1, page),
            pageCount
          );

        el.scrollTo({
          left:
            (next - 1) *
            el.clientWidth,
          behavior: 'smooth',
        });

        setCurrentPage(next);

        if (
          activeBook &&
          progress
        ) {
          const ratio =
            (next - 1) /
            Math.max(
              1,
              pageCount
            );

          const offset =
            Math.round(
              ratio *
                activeBook.rawText
                  .length
            );

          scheduleSaveProgress({
            ...progress,
            page: next,
            charOffset: offset,
            updatedAt:
              Date.now(),
          });
        }
      },
      [
        pageCount,
        activeBook,
        progress,
        scheduleSaveProgress,
      ]
    );

  // --------------------------------------------------
  // 阅读区滚动
  // --------------------------------------------------

  const handleReaderScroll =
    useCallback(
      (
        e: React.UIEvent<HTMLDivElement>
      ) => {
        const el =
          e.currentTarget;

        if (
          !activeBook ||
          !progress
        ) {
          return;
        }

        if (
          progress.readingMode ===
          'paged'
        ) {
          const spread =
            Math.max(
              0,
              Math.round(
                el.scrollLeft /
                  Math.max(
                    1,
                    el.clientWidth
                  )
              )
            );

          const page =
            Math.min(
              pageCount,
              spread + 1
            );

          if (
            page !== currentPage
          ) {
            setCurrentPage(page);
          }

          const ratio =
            spread /
            Math.max(
              1,
              pageCount
            );

          const offset =
            Math.round(
              ratio *
                activeBook.rawText
                  .length
            );

          scheduleSaveProgress({
            ...progress,
            page,
            charOffset: offset,
            updatedAt:
              Date.now(),
          });

          return;
        }

        const ratio =
          el.scrollTop /
          Math.max(
            1,
            el.scrollHeight -
              el.clientHeight
          );

        const offset =
          Math.round(
            ratio *
              activeBook.rawText
                .length
          );

        scheduleSaveProgress({
          ...progress,
          charOffset: offset,
          updatedAt:
            Date.now(),
        });
      },
      [
        activeBook,
        progress,
        pageCount,
        currentPage,
        scheduleSaveProgress,
      ]
    );

  // --------------------------------------------------
  // 切换阅读模式
  // --------------------------------------------------

  const changeReadingMode =
    useCallback(
      (
        mode: MingLightReadingMode
      ) => {
        if (!progress) return;

        restoringRef.current = false;

        scheduleSaveProgress({
          ...progress,
          readingMode: mode,
          page: 1,
          updatedAt: Date.now(),
        });

        setCurrentPage(1);

        requestAnimationFrame(() => {
          const el =
            readerRef.current;

          if (!el) return;

          el.scrollTop = 0;
          el.scrollLeft = 0;

          setReaderReady(false);

          window.setTimeout(() => {
            updateDeviceLayout();
            updatePagination();
          }, 120);
        });
      },
      [
        progress,
        scheduleSaveProgress,
        updateDeviceLayout,
        updatePagination,
      ]
    );

  // --------------------------------------------------
  // 无角色
  // --------------------------------------------------

  if (
    !activeCharacterId ||
    !char
  ) {
    return (
      <div className="h-full flex items-center justify-center text-center px-8 text-sm text-gray-400">
        请先在聊天列表选择一个角色，再打开「眠光」。
      </div>
    );
  }

  // ==================================================
  // 阅读页
  // ==================================================

  if (
    activeBook &&
    progress
  ) {
    const theme =
      THEME_STYLES[
        progress.theme
      ];

    const readingMode =
      progress.readingMode ||
      'scroll';

    const pagesPerSpread =
      isTwoPage ? 2 : 1;

    const firstVisiblePage =
      isTwoPage
        ? currentPage * 2 - 1
        : currentPage;

    const lastVisiblePage =
      Math.min(
        totalPages,
        firstVisiblePage +
          pagesPerSpread -
          1
      );

    return (
      <div
        className="h-full flex flex-col relative"
        style={{
          background:
            theme.bg,
          color:
            theme.text,
        }}
      >
        {/* 自定义滚动条 */}
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
              background: rgba(100,100,100,.42);
              border-radius: 10px;
              border: 3px solid transparent;
              background-clip: padding-box;
              min-height: 48px;
            }

            .minglight-reader::-webkit-scrollbar-thumb:hover,
            .minglight-reader::-webkit-scrollbar-thumb:active {
              background: rgba(100,100,100,.62);
              border: 2px solid transparent;
              background-clip: padding-box;
            }

            .minglight-reader {
              scrollbar-width: auto;
              scrollbar-color:
                rgba(100,100,100,.42)
                transparent;
              -webkit-overflow-scrolling: touch;
            }
          `}
        </style>

        {/* 顶部栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-black/10 shrink-0">
          <button
            onClick={() => {
              setActiveBook(null);
              setProgress(null);
              setShowChapters(false);
            }}
            className="p-1"
          >
            <CaretLeft
              size={22}
            />
          </button>

          <div className="text-sm font-medium truncate max-w-[60%] text-center">
            {activeBook.title}
          </div>

          <button
            onClick={closeApp}
            className="p-1"
          >
            <X size={20} />
          </button>
        </div>

        {/* 工具栏 */}
        <div className="flex items-center justify-center gap-2 py-2 border-b border-black/10 flex-wrap shrink-0">
          {(
            Object.keys(
              THEME_STYLES
            ) as MingLightTheme[]
          ).map(t => (
            <button
              key={t}
              onClick={() =>
                scheduleSaveProgress({
                  ...progress,
                  theme: t,
                  updatedAt:
                    Date.now(),
                })
              }
              className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs border ${
                progress.theme === t
                  ? 'border-current'
                  : 'border-transparent opacity-50'
              }`}
            >
              {
                THEME_STYLES[t]
                  .icon
              }
              {
                THEME_STYLES[t]
                  .label
              }
            </button>
          ))}

          {/* 字号 */}
          <div className="flex items-center gap-1 ml-2">
            <TextAa size={14} />

            <input
              type="range"
              min={14}
              max={28}
              value={
                progress.fontSize
              }
              onChange={e =>
                scheduleSaveProgress({
                  ...progress,
                  fontSize:
                    Number(
                      e.target.value
                    ),
                  updatedAt:
                    Date.now(),
                })
              }
              className="w-20"
            />
          </div>

          {/* 阅读模式 */}
          <button
            onClick={() =>
              changeReadingMode(
                readingMode ===
                  'scroll'
                  ? 'paged'
                  : 'scroll'
              )
            }
            className="flex items-center gap-1 px-2 py-1 rounded-full text-xs border border-black/10"
          >
            <ArrowsLeftRight
              size={14}
            />
            {readingMode ===
            'scroll'
              ? '翻页'
              : '滚动'}
          </button>

          {/* 目录 */}
          <button
            onClick={() =>
              setShowChapters(
                v => !v
              )
            }
            className="flex items-center gap-1 px-2 py-1 rounded-full text-xs border border-black/10"
          >
            <List size={14} />
            目录
          </button>
        </div>

        {/* 正文阅读区 */}
        <div
          ref={readerRef}
          className={`minglight-reader flex-1 ${
            readingMode ===
            'paged'
              ? 'overflow-x-auto overflow-y-hidden'
              : 'overflow-y-auto overflow-x-hidden'
          }`}
          onScroll={
            handleReaderScroll
          }
          style={{
            scrollSnapType:
              readingMode ===
              'paged'
                ? 'x mandatory'
                : undefined,
            overscrollBehavior:
              'contain',
          }}
        >
          {readingMode ===
          'paged' ? (
            <div
              ref={textRef}
              className="h-full"
              style={{
                columnWidth: isTwoPage
                  ? '50%'
                  : '100%',
                columnGap: 0,
                columnFill: 'auto',
                height: '100%',
                width: '100%',
                padding:
                  '24px 28px',
                fontSize:
                  progress.fontSize,
                lineHeight: 1.9,
                whiteSpace:
                  'pre-wrap',
              }}
            >
              {activeBook.rawText}
            </div>
          ) : (
            <div
              ref={textRef}
              className="px-5 py-6 whitespace-pre-wrap leading-relaxed"
              style={{
                fontSize:
                  progress.fontSize,
                minHeight:
                  '100%',
              }}
            >
              {activeBook.rawText}
            </div>
          )}
        </div>

        {/* 分页底栏 */}
        {readingMode ===
          'paged' && (
          <div className="flex items-center justify-center gap-4 py-3 border-t border-black/10 shrink-0">
            <button
              onClick={() =>
                goToPage(
                  currentPage - 1
                )
              }
              disabled={
                currentPage <= 1
              }
              className="w-9 h-9 rounded-full border border-black/10 flex items-center justify-center disabled:opacity-25"
            >
              <PrevIcon
                size={18}
              />
            </button>

            <div className="text-xs opacity-60 min-w-[70px] text-center">
              {isTwoPage &&
              firstVisiblePage <
                totalPages
                ? `${firstVisiblePage}–${lastVisiblePage}`
                : `${firstVisiblePage}`}
              {' / '}
              {totalPages}
            </div>

            <button
              onClick={() =>
                goToPage(
                  currentPage + 1
                )
              }
              disabled={
                currentPage >=
                pageCount
              }
              className="w-9 h-9 rounded-full border border-black/10 flex items-center justify-center disabled:opacity-25"
            >
              <NextIcon
                size={18}
              />
            </button>
          </div>
        )}

        {/* 左下角目录 */}
        <button
          onClick={() =>
            setShowChapters(
              v => !v
            )
          }
          className="fixed bottom-16 left-4 z-20 w-11 h-11 rounded-full bg-black/10 backdrop-blur flex items-center justify-center shadow"
          aria-label="目录"
        >
          <List size={20} />
        </button>

        {/* 目录面板 */}
        {showChapters && (
          <div
            className="fixed inset-0 z-30 bg-black/30"
            onClick={() =>
              setShowChapters(
                false
              )
            }
          >
            <div
              className="absolute left-0 top-0 bottom-0 w-[82%] max-w-[380px] bg-white text-gray-800 shadow-xl flex flex-col"
              onClick={e =>
                e.stopPropagation()
              }
            >
              <div className="flex items-center justify-between px-4 py-4 border-b">
                <div className="font-semibold">
                  目录
                </div>

                <button
                  onClick={() =>
                    setShowChapters(
                      false
                    )
                  }
                  className="p-1"
                >
                  <X size={20} />
                </button>
              </div>

              <div className="px-4 py-3 border-b text-xs text-gray-400">
                {activeBook.title}
                {activeBook.author
                  ? ` · ${activeBook.author}`
                  : ''}
              </div>

              <div className="flex-1 overflow-y-auto">
                {activeBook.chapters.map(
                  (
                    chapter,
                    index
                  ) => (
                    <button
                      key={`${chapter.index}_${index}`}
                      onClick={() => {
                        setShowChapters(
                          false
                        );

                        requestAnimationFrame(
                          () => {
                            jumpToOffset(
                              chapter.startOffset
                            );
                          }
                        );
                      }}
                      className="w-full text-left px-4 py-3 border-b border-gray-100 text-sm hover:bg-gray-50 active:bg-gray-100"
                    >
                      {chapter.title ||
                        `第 ${
                          index + 1
                        } 章`}
                    </button>
                  )
                )}

                {activeBook.chapters
                  .length === 0 && (
                  <div className="p-5 text-sm text-gray-400">
                    暂无目录
                  </div>
                )}
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
    <div className="h-full flex flex-col bg-[#F7F2EA]">
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={closeApp}
          className="p-1"
        >
          <CaretLeft
            size={22}
          />
        </button>

        <div className="text-base font-semibold">
          眠光 · 和{char.name}的书架
        </div>

        <button
          onClick={() =>
            setShowImportModal(
              true
            )
          }
          className="p-1"
        >
          <Plus size={22} />
        </button>
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
            onClick={() =>
              setShowImportModal(
                true
              )
            }
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
              onClick={() =>
                openBook(book)
              }
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
                    handleDeleteBook(
                      book.id
                    );
                  }}
                  className="absolute top-1 right-1 bg-black/40 text-white rounded-full p-0.5 opacity-0 group-active:opacity-100"
                >
                  <Trash
                    size={12}
                  />
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
      {showImportModal && (
        <div
          className="absolute inset-0 bg-black/40 flex items-center justify-center z-10"
          onClick={() =>
            setShowImportModal(
              false
            )
          }
        >
          <div
            className="bg-white rounded-xl p-5 w-[80%] flex flex-col items-center gap-3"
            onClick={e =>
              e.stopPropagation()
            }
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
                const f =
                  e.target.files?.[0];

                if (f) {
                  handleFileChosen(
                    f
                  );
                }

                e.currentTarget.value =
                  '';
              }}
            />

            <button
              onClick={() =>
                fileInputRef.current?.click()
              }
              className="px-4 py-2 bg-amber-700 text-white rounded-full text-sm w-full"
            >
              选择文件
            </button>

            <button
              onClick={() =>
                setShowImportModal(
                  false
                )
              }
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
