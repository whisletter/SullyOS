
/**
 * 「眠光」—— 和角色一起共读的阅读器
 *
 * 当前功能：
 * - TXT / EPUB
 * - EPUB 书名 / 作者 / 封面 / 章节
 * - 目录跳转
 * - 滚动阅读
 * - 单页分页阅读
 * - 手机 / 平板都使用单页
 * - 左右滑动翻页
 * - 页码显示
 * - 四种阅读主题
 * - 字号调整
 * - 阅读进度自动保存
 */

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
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
 * 根据当前阅读区域，把全文切成“页”。
 *
 * 这里不再使用 CSS columns。
 * 每一页都是一个真正独立的 DOM 页面，
 * 因此 page / swipe / directory jump 三者可以直接绑定。
 */
function paginateText(
  text: string,
  width: number,
  height: number,
  fontSize: number
): {
  text: string;
  startOffset: number;
}[] {
  if (!text || width <= 0 || height <= 0) {
    return [
      {
        text,
        startOffset: 0,
      },
    ];
  }

  const horizontalPadding = 56;
  const verticalPadding = 48;

  const contentWidth = Math.max(
    100,
    width - horizontalPadding
  );

  const contentHeight = Math.max(
    100,
    height - verticalPadding
  );

  const lineHeight = fontSize * 1.9;

  const charsPerLine = Math.max(
    8,
    Math.floor(
      contentWidth /
        Math.max(fontSize * 0.92, 1)
    )
  );

  const linesPerPage = Math.max(
    5,
    Math.floor(
      contentHeight /
        lineHeight
    )
  );

  const approxCharsPerPage =
    Math.max(
      40,
      charsPerLine *
        linesPerPage
    );

  const pages: {
    text: string;
    startOffset: number;
  }[] = [];

  let start = 0;

  while (start < text.length) {
    let end = Math.min(
      text.length,
      start + approxCharsPerPage
    );

    // 尽量不要把单词切断
    if (
      end < text.length &&
      !/\s/.test(text[end])
    ) {
      const breakAt = text.lastIndexOf(
        ' ',
        end
      );

      if (
        breakAt > start + 20
      ) {
        end = breakAt + 1;
      }
    }

    // 尽量在段落/换行处结束
    const newline =
      text.lastIndexOf(
        '\n',
        end
      );

    if (
      newline > start + 20 &&
      end - newline < 120
    ) {
      end = newline + 1;
    }

    if (end <= start) {
      end = Math.min(
        text.length,
        start + approxCharsPerPage
      );
    }

    pages.push({
      text: text.slice(
        start,
        end
      ),
      startOffset: start,
    });

    start = end;
  }

  if (pages.length === 0) {
    pages.push({
      text: '',
      startOffset: 0,
    });
  }

  return pages;
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
    useState<MingLightBook | null>(
      null
    );

  const [progress, setProgress] =
    useState<MingLightProgress | null>(
      null
    );

  const [
    showImportModal,
    setShowImportModal,
  ] = useState(false);

  const [
    showChapters,
    setShowChapters,
  ] = useState(false);

  const [pages, setPages] =
    useState<
      {
        text: string;
        startOffset: number;
      }[]
    >([]);

  const [currentPage, setCurrentPage] =
    useState(1);

  const fileInputRef =
    useRef<HTMLInputElement>(null);

  const readerRef =
    useRef<HTMLDivElement>(null);

  const saveTimer =
    useRef<number | null>(null);

  const touchStartX =
    useRef<number | null>(null);

  const touchStartY =
    useRef<number | null>(null);

  const restoringRef =
    useRef(false);

  // ----------------------------------------------
  // 书架
  // ----------------------------------------------

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
              b.createdAt -
              a.createdAt
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

  // ----------------------------------------------
  // 保存进度
  // ----------------------------------------------

  const scheduleSaveProgress =
    useCallback(
      (
        p: MingLightProgress
      ) => {
        setProgress(p);

        if (saveTimer.current) {
          window.clearTimeout(
            saveTimer.current
          );
        }

        saveTimer.current =
          window.setTimeout(() => {
            saveProgress(p).catch(
              () => {}
            );
          }, 500);
      },
      []
    );

  // ----------------------------------------------
  // 打开书
  // ----------------------------------------------

  const openBook = useCallback(
    async (
      book: MingLightBook
    ) => {
      if (!activeCharacterId)
        return;

      const existing =
        await getProgress(
          book.id,
          activeCharacterId
        );

      const nextProgress: MingLightProgress =
        existing || {
          id: `${book.id}__${activeCharacterId}`,
          bookId: book.id,
          charId:
            activeCharacterId,
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

      restoringRef.current = true;
      setShowChapters(false);
    },
    [activeCharacterId]
  );

  // ----------------------------------------------
  // 导入
  // ----------------------------------------------

  const handleFileChosen =
    useCallback(
      async (file: File) => {
        if (!activeCharacterId)
          return;

        try {
          const fileName =
            file.name.toLowerCase();

          // TXT
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
                      reader.result ||
                        ''
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

            reader.onerror =
              () => {
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

          // EPUB
          if (
            fileName.endsWith('.epub')
          ) {
            addToast?.(
              '正在读取 EPUB…',
              'success'
            );

            const imported =
              await importEpub(
                file
              );

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

            setShowImportModal(
              false
            );

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

  // ----------------------------------------------
  // 删除
  // ----------------------------------------------

  const handleDeleteBook =
    useCallback(
      async (
        bookId: string
      ) => {
        await deleteBook(bookId);

        if (
          activeBook?.id ===
          bookId
        ) {
          setActiveBook(null);
          setProgress(null);
          setPages([]);
        }

        await refreshBooks();
      },
      [
        activeBook,
        refreshBooks,
      ]
    );

  // ----------------------------------------------
  // 当前阅读区域尺寸
  // ----------------------------------------------

  const [readerSize, setReaderSize] =
    useState({
      width: 0,
      height: 0,
    });

  useEffect(() => {
    if (!activeBook) return;

    const updateSize = () => {
      const el =
        readerRef.current;

      if (!el) return;

      setReaderSize({
        width: el.clientWidth,
        height: el.clientHeight,
      });
    };

    updateSize();

    window.addEventListener(
      'resize',
      updateSize
    );

    const observer =
      typeof ResizeObserver !==
      'undefined'
        ? new ResizeObserver(
            updateSize
          )
        : null;

    if (
      observer &&
      readerRef.current
    ) {
      observer.observe(
        readerRef.current
      );
    }

    return () => {
      window.removeEventListener(
        'resize',
        updateSize
      );

      observer?.disconnect();
    };
  }, [activeBook]);

  // ----------------------------------------------
  // 生成分页
  // ----------------------------------------------

  useEffect(() => {
    if (
      !activeBook ||
      !progress ||
      progress.readingMode !==
        'paged'
    ) {
      setPages([]);
      return;
    }

    if (
      readerSize.width <= 0 ||
      readerSize.height <= 0
    ) {
      return;
    }

    const newPages =
      paginateText(
        activeBook.rawText,
        readerSize.width,
        readerSize.height,
        progress.fontSize
      );

    setPages(newPages);

    const savedPage =
      progress.page || 1;

    setCurrentPage(
      Math.min(
        Math.max(
          1,
          savedPage
        ),
        Math.max(
          1,
          newPages.length
        )
      )
    );
  }, [
    activeBook,
    progress?.readingMode,
    progress?.fontSize,
    readerSize.width,
    readerSize.height,
  ]);

  // ----------------------------------------------
  // 进入分页模式后恢复页码
  // ----------------------------------------------

  useEffect(() => {
    if (
      !activeBook ||
      !progress ||
      progress.readingMode !==
        'paged' ||
      !pages.length
    ) {
      return;
    }

    if (!restoringRef.current)
      return;

    const pageFromOffset =
      pages.findIndex(
        p =>
          p.startOffset >=
          progress.charOffset
      );

    const target =
      pageFromOffset >= 0
        ? pageFromOffset + 1
        : 1;

    setCurrentPage(
      Math.min(
        target,
        pages.length
      )
    );

    restoringRef.current = false;
  }, [
    pages,
    progress,
    activeBook,
  ]);

  // ----------------------------------------------
  // 切换阅读模式
  // ----------------------------------------------

  const changeReadingMode =
    useCallback(
      (
        mode: MingLightReadingMode
      ) => {
        if (!progress) return;

        if (
          mode === 'paged'
        ) {
          restoringRef.current = true;

          scheduleSaveProgress({
            ...progress,
            readingMode:
              'paged',
            updatedAt:
              Date.now(),
          });

          setCurrentPage(
            1
          );
        } else {
          restoringRef.current =
            false;

          scheduleSaveProgress({
            ...progress,
            readingMode:
              'scroll',
            updatedAt:
              Date.now(),
          });
        }
      },
      [
        progress,
        scheduleSaveProgress,
      ]
    );

  // ----------------------------------------------
  // 翻页
  // ----------------------------------------------

  const goToPage =
    useCallback(
      (
        page: number
      ) => {
        if (
          !activeBook ||
          !progress ||
          !pages.length
        ) {
          return;
        }

        const nextPage =
          Math.min(
            Math.max(
              1,
              page
            ),
            pages.length
          );

        const pageData =
          pages[
            nextPage - 1
          ];

        setCurrentPage(
          nextPage
        );

        scheduleSaveProgress({
          ...progress,
          page: nextPage,
          charOffset:
            pageData.startOffset,
          updatedAt:
            Date.now(),
        });
      },
      [
        activeBook,
        progress,
        pages,
        scheduleSaveProgress,
      ]
    );

  // ----------------------------------------------
  // 左右滑动
  // ----------------------------------------------

  const handleTouchStart =
    useCallback(
      (
        e: React.TouchEvent
      ) => {
        const touch =
          e.touches[0];

        touchStartX.current =
          touch.clientX;

        touchStartY.current =
          touch.clientY;
      },
      []
    );

  const handleTouchEnd =
    useCallback(
      (
        e: React.TouchEvent
      ) => {
        if (
          touchStartX.current ===
            null ||
          touchStartY.current ===
            null
        ) {
          return;
        }

        const touch =
          e.changedTouches[0];

        const dx =
          touch.clientX -
          touchStartX.current;

        const dy =
          touch.clientY -
          touchStartY.current;

        touchStartX.current = null;
        touchStartY.current = null;

        // 只处理明显的水平滑动
        if (
          Math.abs(dx) <
            50 ||
          Math.abs(dx) <
            Math.abs(dy)
        ) {
          return;
        }

        if (
          dx < 0
        ) {
          goToPage(
            currentPage + 1
          );
        } else {
          goToPage(
            currentPage - 1
          );
        }
      },
      [
        currentPage,
        goToPage,
      ]
    );

  // ----------------------------------------------
  // 目录跳转
  // ----------------------------------------------

  const jumpToChapter =
    useCallback(
      (
        offset: number
      ) => {
        if (
          !activeBook ||
          !progress
        ) {
          return;
        }

        setShowChapters(
          false
        );

        if (
          progress.readingMode ===
          'paged'
        ) {
          if (!pages.length)
            return;

          let targetIndex =
            pages.findIndex(
              p =>
                p.startOffset >=
                offset
            );

          if (
            targetIndex < 0
          ) {
            targetIndex =
              pages.length - 1;
          }

          const targetPage =
            targetIndex + 1;

          goToPage(
            targetPage
          );

          return;
        }

        const el =
          readerRef.current;

        if (!el) return;

        const ratio =
          offset /
          Math.max(
            1,
            activeBook
              .rawText.length
          );

        el.scrollTo({
          top:
            ratio *
            Math.max(
              0,
              el.scrollHeight -
                el.clientHeight
            ),
          behavior:
            'smooth',
        });

        scheduleSaveProgress({
          ...progress,
          charOffset:
            offset,
          updatedAt:
            Date.now(),
        });
      },
      [
        activeBook,
        progress,
        pages,
        goToPage,
        scheduleSaveProgress,
      ]
    );

  // ----------------------------------------------
  // 预计算页码
  // ----------------------------------------------

  const pageInfo = useMemo(() => {
    const total =
      pages.length || 1;

    const current =
      Math.min(
        Math.max(
          1,
          currentPage
        ),
        total
      );

    return {
      current,
      total,
    };
  }, [
    pages.length,
    currentPage,
  ]);

  // ----------------------------------------------
  // 无角色
  // ----------------------------------------------

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

  // =================================================
  // 阅读页
  // =================================================

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

    const currentPageText =
      pages[
        pageInfo.current - 1
      ]?.text || '';

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
        {/* 更宽的滚动条 */}
        <style>
          {`
            .minglight-scroll::-webkit-scrollbar {
              width: 16px;
              height: 16px;
            }

            .minglight-scroll::-webkit-scrollbar-track {
              background: transparent;
            }

            .minglight-scroll::-webkit-scrollbar-thumb {
              background: rgba(100,100,100,.45);
              border-radius: 10px;
              border: 3px solid transparent;
              background-clip: padding-box;
              min-height: 48px;
            }

            .minglight-scroll::-webkit-scrollbar-thumb:hover {
              background: rgba(100,100,100,.60);
              border: 2px solid transparent;
              background-clip: padding-box;
            }

            .minglight-scroll {
              scrollbar-width: auto;
              scrollbar-color: rgba(100,100,100,.45) transparent;
              -webkit-overflow-scrolling: touch;
            }
          `}
        </style>

        {/* 顶部栏 */}
        <div
          className="flex items-center justify-between px-4 py-3 shrink-0"
          style={{
            borderBottom:
              `1px solid ${theme.text}18`,
          }}
        >
          <button
            onClick={() => {
              setActiveBook(
                null
              );
              setProgress(
                null
              );
              setPages([]);
              setShowChapters(
                false
              );
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
        <div
          className="flex items-center justify-center gap-2 py-2 flex-wrap shrink-0"
          style={{
            borderBottom:
              `1px solid ${theme.text}18`,
          }}
        >
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
                progress.theme ===
                t
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
            <TextAa
              size={14}
            />

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
                      e.target
                        .value
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
            className="flex items-center gap-1 px-2 py-1 rounded-full text-xs border"
            style={{
              borderColor:
                `${theme.text}25`,
            }}
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
            className="flex items-center gap-1 px-2 py-1 rounded-full text-xs border"
            style={{
              borderColor:
                `${theme.text}25`,
            }}
          >
            <List size={14} />
            目录
          </button>
        </div>

        {/* 阅读区 */}
        {readingMode ===
        'paged' ? (
          <div
            className="flex-1 min-h-0 relative select-none"
            style={{
              background:
                theme.bg,
            }}
            onTouchStart={
              handleTouchStart
            }
            onTouchEnd={
              handleTouchEnd
            }
          >
            <div
              className="h-full overflow-hidden px-7 py-6 whitespace-pre-wrap leading-relaxed"
              style={{
                fontSize:
                  progress.fontSize,
              }}
            >
              {currentPageText}
            </div>

            {/* 左右点击区域 */}
            <button
              onClick={() =>
                goToPage(
                  currentPage - 1
                )
              }
              disabled={
                currentPage <= 1
              }
              aria-label="上一页"
              className="absolute left-0 top-0 bottom-0 w-[22%] disabled:pointer-events-none"
            />

            <button
              onClick={() =>
                goToPage(
                  currentPage + 1
                )
              }
              disabled={
                currentPage >=
                pageInfo.total
              }
              aria-label="下一页"
              className="absolute right-0 top-0 bottom-0 w-[22%] disabled:pointer-events-none"
            />
          </div>
        ) : (
          <div
            ref={readerRef}
            className="minglight-scroll flex-1 overflow-y-auto overflow-x-hidden px-5 py-6 whitespace-pre-wrap leading-relaxed"
            style={{
              fontSize:
                progress.fontSize,
            }}
            onScroll={e => {
              const el =
                e.currentTarget;

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
                    activeBook
                      .rawText
                      .length
                );

              scheduleSaveProgress(
                {
                  ...progress,
                  charOffset:
                    offset,
                  updatedAt:
                    Date.now(),
                }
              );
            }}
          >
            {activeBook.rawText}
          </div>
        )}

        {/* 分页底栏 */}
        {readingMode ===
          'paged' && (
          <div
            className="flex items-center justify-center gap-5 py-3 shrink-0"
            style={{
              borderTop:
                `1px solid ${theme.text}18`,
            }}
          >
            <button
              onClick={() =>
                goToPage(
                  currentPage - 1
                )
              }
              disabled={
                currentPage <= 1
              }
              className="w-9 h-9 rounded-full border flex items-center justify-center disabled:opacity-25"
              style={{
                borderColor:
                  `${theme.text}25`,
              }}
            >
              <PrevIcon
                size={18}
              />
            </button>

            <div
              className="text-xs opacity-60 min-w-[70px] text-center"
            >
              {pageInfo.current}{' '}
              /{' '}
              {pageInfo.total}
            </div>

            <button
              onClick={() =>
                goToPage(
                  currentPage + 1
                )
              }
              disabled={
                currentPage >=
                pageInfo.total
              }
              className="w-9 h-9 rounded-full border flex items-center justify-center disabled:opacity-25"
              style={{
                borderColor:
                  `${theme.text}25`,
              }}
            >
              <NextIcon
                size={18}
              />
            </button>
          </div>
        )}

        {/* 左下角目录按钮 */}
        <button
          onClick={() =>
            setShowChapters(
              v => !v
            )
          }
          className="absolute bottom-16 left-4 z-20 w-11 h-11 rounded-full backdrop-blur flex items-center justify-center shadow"
          style={{
            background:
              `${theme.text}18`,
          }}
          aria-label="目录"
        >
          <List size={20} />
        </button>

        {/* 目录面板：颜色跟随当前阅读主题 */}
        {showChapters && (
          <div
            className="absolute inset-0 z-30"
            style={{
              background:
                `${theme.text}30`,
            }}
            onClick={() =>
              setShowChapters(
                false
              )
            }
          >
            <div
              className="absolute left-0 top-0 bottom-0 w-[82%] max-w-[380px] shadow-xl flex flex-col"
              style={{
                background:
                  theme.bg,
                color:
                  theme.text,
              }}
              onClick={e =>
                e.stopPropagation()
              }
            >
              <div
                className="flex items-center justify-between px-4 py-4 shrink-0"
                style={{
                  borderBottom:
                    `1px solid ${theme.text}18`,
                }}
              >
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

              <div
                className="px-4 py-3 text-xs opacity-60 shrink-0"
                style={{
                  borderBottom:
                    `1px solid ${theme.text}18`,
                }}
              >
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
                      onClick={() =>
                        jumpToChapter(
                          chapter.startOffset
                        )
                      }
                      className="w-full text-left px-4 py-3 text-sm"
                      style={{
                        borderBottom:
                          `1px solid ${theme.text}12`,
                      }}
                    >
                      {chapter.title ||
                        `第 ${
                          index +
                          1
                        } 章`}
                    </button>
                  )
                )}

                {activeBook.chapters
                  .length === 0 && (
                  <div className="p-5 text-sm opacity-50">
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

  // =================================================
  // 书架
  // =================================================

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
          眠光 · 和
          {char.name}
          的书架
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
      ) : books.length ===
        0 ? (
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

      {/* 导入 */}
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
