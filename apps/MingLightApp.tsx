/**
 * 「眠光」—— 和角色一起共读的阅读器
 *
 * 第二步：
 * - TXT / EPUB
 * - 目录
 * - 连续滚动
 * - 四种阅读主题 / 字号
 * - 阅读进度保存
 * - 你主动划线 + 批注
 * - TA 主动划线 + 批注
 * - 批注内独立讨论
 * - 讨论底部手动「收藏进记忆宫殿」
 * - TA 每约 750 字检查一次，但永远只看用户当前已经读到的位置
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
  ChatCircleDots,
  PaperPlaneTilt,
  Brain,
} from '@phosphor-icons/react';

import { useOS } from '../context/OSContext';

import {
  MingLightBook,
  MingLightProgress,
  MingLightTheme,
  MingLightAnnotation,
  MingLightThreadMessage,
  getBooksForChar,
  saveBook,
  deleteBook,
  getProgress,
  saveProgress,
  splitIntoChapters,
  importEpub,
} from '../utils/mingLightDb';

import {
  TA_REVIEW_INTERVAL,
  TA_REVIEW_WINDOW,
  askTaForSpontaneousComment,
  askTaToReplyToUserAnnotation,
  askTaToContinueDiscussion,
  archiveAnnotationDiscussion,
  makeAnnotationId,
  makeThreadId,
} from '../utils/mingLightAnnotations';

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

type SelectionState = {
  startOffset: number;
  endOffset: number;
  quote: string;
  left: number;
  top: number;
};

type AnnotationComposer = {
  quote: string;
  startOffset: number;
  endOffset: number;
};

function makeTextPieces(
  text: string
): {
  text: string;
  startOffset: number;
  endOffset: number;
}[] {
  const result: {
    text: string;
    startOffset: number;
    endOffset: number;
  }[] = [];

  const re =
    /[^。！？!?]+[。！？!?]+|[^。！？!?]+$/g;

  let match: RegExpExecArray | null;

  while ((match = re.exec(text))) {
    const value = match[0];

    if (!value) continue;

    result.push({
      text: value,
      startOffset: match.index,
      endOffset:
        match.index + value.length,
    });
  }

  if (
    result.length === 0 &&
    text.length > 0
  ) {
    result.push({
      text,
      startOffset: 0,
      endOffset: text.length,
    });
  }

  return result;
}

function getCurrentChapterTitle(
  book: MingLightBook,
  offset: number
) {
  const chapter =
    book.chapters.find(
      c =>
        offset >= c.startOffset &&
        offset < c.endOffset
    );

  return (
    chapter?.title ||
    '正文'
  );
}

function getNodeTextOffset(
  root: HTMLElement,
  node: Node,
  nodeOffset: number
): number | null {
  const walker =
    document.createTreeWalker(
      root,
      NodeFilter.SHOW_TEXT
    );

  let total = 0;
  let current: Node | null;

  while (
    (current = walker.nextNode())
  ) {
    if (current === node) {
      return total + nodeOffset;
    }

    total +=
      current.textContent?.length ||
      0;
  }

  return null;
}

const MingLightApp: React.FC = () => {
  const {
    activeCharacterId,
    characters,
    closeApp,
    addToast,
    apiConfig,
    memoryPalaceConfig,
    userProfile,
  } = useOS();

  const char =
    characters.find(
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

  const [showImportModal, setShowImportModal] =
    useState(false);

  const [showChapters, setShowChapters] =
    useState(false);

  const [selection, setSelection] =
    useState<SelectionState | null>(
      null
    );

  const [
    composer,
    setComposer,
  ] = useState<AnnotationComposer | null>(
    null
  );

  const [composerText, setComposerText] =
    useState('');

  const [selectedAnnotationId, setSelectedAnnotationId] =
    useState<string | null>(null);

  const [threadInput, setThreadInput] =
    useState('');

  const [threadSending, setThreadSending] =
    useState(false);

  const [taReviewing, setTaReviewing] =
    useState(false);

  const fileInputRef =
    useRef<HTMLInputElement>(null);

  const readerRef =
    useRef<HTMLDivElement>(null);

  const saveTimer =
    useRef<number | null>(null);

  const taReviewInFlightRef =
    useRef(false);

  const textPiecesRef =
    useRef<
      ReturnType<typeof makeTextPieces>
    >([]);

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

  // --------------------------------------------------
  // 进度保存
  // --------------------------------------------------

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

  // --------------------------------------------------
  // 打开书
  // --------------------------------------------------

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
          taCheckedOffset: 0,
          updatedAt: Date.now(),
        };

      setActiveBook(book);
      setProgress(nextProgress);
      setSelectedAnnotationId(null);
      setShowChapters(false);

      requestAnimationFrame(() => {
        const el =
          readerRef.current;

        if (!el) return;

        const ratio =
          nextProgress.charOffset /
          Math.max(
            1,
            book.rawText.length
          );

        window.setTimeout(() => {
          el.scrollTop =
            ratio *
            Math.max(
              0,
              el.scrollHeight -
                el.clientHeight
            );
        }, 100);
      });
    },
    [activeCharacterId]
  );

  // --------------------------------------------------
  // 导入
  // --------------------------------------------------

  const handleFileChosen =
    useCallback(
      async (file: File) => {
        if (!activeCharacterId)
          return;

        try {
          const fileName =
            file.name.toLowerCase();

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
                      annotations: [],
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
                annotations: [],
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
  // 删除
  // --------------------------------------------------

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
          setSelectedAnnotationId(
            null
          );
        }

        await refreshBooks();
      },
      [
        activeBook,
        refreshBooks,
      ]
    );

  // --------------------------------------------------
  // 当前正文片段
  // --------------------------------------------------

  useEffect(() => {
    if (!activeBook) {
      textPiecesRef.current = [];
      return;
    }

    textPiecesRef.current =
      makeTextPieces(
        activeBook.rawText
      );
  }, [activeBook]);

  // --------------------------------------------------
  // 选中文字
  // --------------------------------------------------

  const handleTextSelection =
    useCallback(() => {
      const root =
        readerRef.current;

      const sel =
        window.getSelection();

      if (
        !root ||
        !sel ||
        sel.rangeCount === 0 ||
        sel.isCollapsed
      ) {
        return;
      }

      const range =
        sel.getRangeAt(0);

      if (
        !root.contains(
          range.startContainer
        ) ||
        !root.contains(
          range.endContainer
        )
      ) {
        return;
      }

      const start =
        getNodeTextOffset(
          root,
          range.startContainer,
          range.startOffset
        );

      const end =
        getNodeTextOffset(
          root,
          range.endContainer,
          range.endOffset
        );

      if (
        start === null ||
        end === null ||
        end <= start
      ) {
        return;
      }

      const quote =
        activeBook?.rawText.slice(
          start,
          end
        ).trim();

      if (!quote) return;

      const rect =
        range.getBoundingClientRect();

      setSelection({
        startOffset: start,
        endOffset: end,
        quote,
        left: Math.min(
          Math.max(8, rect.left),
          window.innerWidth - 130
        ),
        top: Math.max(
          8,
          rect.top - 44
        ),
      });
    }, [activeBook]);

  // --------------------------------------------------
  // 创建用户批注
  // --------------------------------------------------

  const submitUserAnnotation =
    useCallback(
      async () => {
        if (
          !activeBook ||
          !activeCharacterId ||
          !composer
        ) {
          return;
        }

        const userComment =
          composerText.trim();

        if (!userComment) {
          addToast?.(
            '先写一点你的想法吧',
            'info'
          );
          return;
        }

        const now =
          Date.now();

        const userMessage:
          MingLightThreadMessage =
          {
            id: makeThreadId(),
            role: 'user',
            text: userComment,
            createdAt: now,
          };

        const annotation:
          MingLightAnnotation =
          {
            id: makeAnnotationId(),
            startOffset:
              composer.startOffset,
            endOffset:
              composer.endOffset,
            quotedText:
              composer.quote,
            source: 'user',
            comment: userComment,
            thread: [userMessage],
            createdAt: now,
            archivedToMemory: false,
          };

        const nextBook = {
          ...activeBook,
          annotations: [
            ...(activeBook.annotations ||
              []),
            annotation,
          ],
        };

        setActiveBook(
          nextBook
        );

        await saveBook(
          nextBook
        );

        setComposer(null);
        setComposerText('');
        setSelection(null);

        // 用户主动发起 → TA 立即回应
        if (
          apiConfig?.baseUrl &&
          apiConfig?.apiKey &&
          apiConfig?.model &&
          char
        ) {
          try {
            setThreadSending(
              true
            );

            const reply =
              await askTaToReplyToUserAnnotation(
                apiConfig,
                char,
                userProfile?.name ||
                  '用户',
                activeBook.title,
                composer.quote,
                userComment,
                [userMessage],
              );

            const updatedAnnotation =
              {
                ...annotation,
                thread: [
                  userMessage,
                  {
                    id: makeThreadId(),
                    role: 'assistant',
                    text: reply,
                    createdAt:
                      Date.now(),
                  },
                ],
              };

            const savedBook =
              {
                ...nextBook,
                annotations:
                  (nextBook.annotations ||
                    []
                  ).map(a =>
                    a.id ===
                    annotation.id
                      ? updatedAnnotation
                      : a
                  ),
              };

            setActiveBook(
              savedBook
            );

            await saveBook(
              savedBook
            );

            setSelectedAnnotationId(
              annotation.id
            );
          } catch {
            addToast?.(
              'TA暂时没有回应，但你的批注已经保存了',
              'error'
            );

            setSelectedAnnotationId(
              annotation.id
            );
          } finally {
            setThreadSending(
              false
            );
          }
        } else {
          setSelectedAnnotationId(
            annotation.id
          );
        }
      },
      [
        activeBook,
        activeCharacterId,
        composer,
        composerText,
        apiConfig,
        char,
        userProfile,
        addToast,
      ]
    );

  // --------------------------------------------------
  // TA 主动评论
  // --------------------------------------------------

  const trySpontaneousTaReview =
    useCallback(
      async (
        visibleEndOffset: number
      ) => {
        if (
          !activeBook ||
          !progress ||
          !char ||
          taReviewInFlightRef.current
        ) {
          return;
        }

        if (
          visibleEndOffset <=
          (progress.taCheckedOffset ||
            0) +
            TA_REVIEW_INTERVAL
        ) {
          return;
        }

        if (
          !apiConfig?.baseUrl ||
          !apiConfig?.apiKey ||
          !apiConfig?.model
        ) {
          return;
        }

        taReviewInFlightRef.current =
          true;

        setTaReviewing(true);

        try {
          /*
           * 只取“用户已经看到的最后一小段”。
           * visibleEndOffset 之后的任何文字都不会传给 TA。
           */
          const end =
            Math.min(
              visibleEndOffset,
              activeBook.rawText
                .length
            );

          const start =
            Math.max(
              0,
              end -
                TA_REVIEW_WINDOW
            );

          const excerpt =
            activeBook.rawText.slice(
              start,
              end
            );

          if (!excerpt.trim()) {
            return;
          }

          const result =
            await askTaForSpontaneousComment(
              apiConfig,
              char,
              userProfile?.name ||
                '用户',
              activeBook.title,
              getCurrentChapterTitle(
                activeBook,
                end
              ),
              excerpt,
            );

          let nextBook =
            activeBook;

          if (
            result.hasComment &&
            result.quote &&
            result.comment
          ) {
            const localIndex =
              excerpt.indexOf(
                result.quote
              );

            if (localIndex >= 0) {
              const startOffset =
                start +
                localIndex;

              const endOffset =
                startOffset +
                result.quote
                  .length;

              const exists =
                (
                  activeBook.annotations ||
                  []
                ).some(
                  a =>
                    a.source ===
                      'ta' &&
                    a.startOffset ===
                      startOffset &&
                    a.endOffset ===
                      endOffset
                );

              if (!exists) {
                const annotation:
                  MingLightAnnotation =
                  {
                    id: makeAnnotationId(),
                    startOffset,
                    endOffset,
                    quotedText:
                      result.quote,
                    source: 'ta',
                    comment:
                      result.comment,
                    thread: [],
                    createdAt:
                      Date.now(),
                    archivedToMemory:
                      false,
                  };

                nextBook = {
                  ...activeBook,
                  annotations: [
                    ...(activeBook.annotations ||
                      []),
                    annotation,
                  ],
                };

                setActiveBook(
                  nextBook
                );

                await saveBook(
                  nextBook
                );
              }
            }
          }

          const updatedProgress =
            {
              ...progress,
              taCheckedOffset:
                visibleEndOffset,
              updatedAt:
                Date.now(),
            };

          scheduleSaveProgress(
            updatedProgress
          );
        } catch (error) {
          console.warn(
            '眠光 TA 自动批注失败',
            error
          );
        } finally {
          taReviewInFlightRef.current =
            false;

          setTaReviewing(false);
        }
      },
      [
        activeBook,
        progress,
        char,
        apiConfig,
        userProfile,
        scheduleSaveProgress,
      ]
    );

  // --------------------------------------------------
  // 滚动
  // --------------------------------------------------

  const handleReaderScroll =
    useCallback(
      (
        e: React.UIEvent<HTMLDivElement>
      ) => {
        if (
          !activeBook ||
          !progress
        ) {
          return;
        }

        const el =
          e.currentTarget;

        const scrollBottom =
          el.scrollTop +
          el.clientHeight;

        const ratio =
          scrollBottom /
          Math.max(
            1,
            el.scrollHeight
          );

        const visibleEndOffset =
          Math.min(
            activeBook.rawText
              .length,
            Math.round(
              ratio *
                activeBook
                  .rawText
                  .length
            )
          );

        const progressOffset =
          Math.round(
            (
              el.scrollTop /
              Math.max(
                1,
                el.scrollHeight -
                  el.clientHeight
              )
            ) *
              activeBook.rawText
                .length
          );

        scheduleSaveProgress({
          ...progress,
          charOffset:
            progressOffset,
          updatedAt:
            Date.now(),
        });

        void trySpontaneousTaReview(
          visibleEndOffset
        );
      },
      [
        activeBook,
        progress,
        scheduleSaveProgress,
        trySpontaneousTaReview,
      ]
    );

  // --------------------------------------------------
  // 点击已有批注
  // --------------------------------------------------

  const openAnnotation =
    useCallback(
      (
        annotationId: string
      ) => {
        setSelectedAnnotationId(
          annotationId
        );

        setSelection(null);
        setComposer(null);
      },
      []
    );

  // --------------------------------------------------
  // 继续讨论
  // --------------------------------------------------

  const sendThreadMessage =
    useCallback(
      async () => {
        if (
          !activeBook ||
          !char ||
          !selectedAnnotationId ||
          !threadInput.trim()
        ) {
          return;
        }

        const annotation =
          (
            activeBook.annotations ||
            []
          ).find(
            a =>
              a.id ===
              selectedAnnotationId
          );

        if (!annotation) return;

        if (
          !apiConfig?.baseUrl ||
          !apiConfig?.apiKey ||
          !apiConfig?.model
        ) {
          addToast?.(
            '聊天 API 尚未配置完整',
            'error'
          );
          return;
        }

        const message:
          MingLightThreadMessage =
          {
            id: makeThreadId(),
            role: 'user',
            text:
              threadInput.trim(),
            createdAt:
              Date.now(),
          };

        const history =
          [
            ...annotation.thread,
            message,
          ];

        setThreadInput('');
        setThreadSending(
          true
        );

        const optimisticBook =
          {
            ...activeBook,
            annotations:
              (
                activeBook.annotations ||
                []
              ).map(a =>
                a.id ===
                annotation.id
                  ? {
                      ...a,
                      thread:
                        history,
                    }
                  : a
              ),
          };

        setActiveBook(
          optimisticBook
        );

        await saveBook(
          optimisticBook
        );

        try {
          const reply =
            await askTaToContinueDiscussion(
              apiConfig,
              char,
              userProfile?.name ||
                '用户',
              activeBook.title,
              annotation.quotedText,
              history,
            );

          const finalBook =
            {
              ...optimisticBook,
              annotations:
                (
                  optimisticBook
                    .annotations ||
                  []
                ).map(a =>
                  a.id ===
                  annotation.id
                    ? {
                        ...a,
                        thread: [
                          ...history,
                          {
                            id: makeThreadId(),
                            role: 'assistant',
                            text: reply,
                            createdAt:
                              Date.now(),
                          },
                        ],
                      }
                    : a
                ),
            };

          setActiveBook(
            finalBook
          );

          await saveBook(
            finalBook
          );
        } catch {
          addToast?.(
            'TA暂时没有回应',
            'error'
          );
        } finally {
          setThreadSending(
            false
          );
        }
      },
      [
        activeBook,
        char,
        selectedAnnotationId,
        threadInput,
        apiConfig,
        userProfile,
        addToast,
      ]
    );

  // --------------------------------------------------
  // 收藏进记忆宫殿
  // --------------------------------------------------

  const archiveSelectedAnnotation =
    useCallback(
      async () => {
        if (
          !activeBook ||
          !char ||
          !selectedAnnotationId
        ) {
          return;
        }

        const annotation =
          (
            activeBook.annotations ||
            []
          ).find(
            a =>
              a.id ===
              selectedAnnotationId
          );

        if (!annotation) return;

        if (
          annotation.archivedToMemory
        ) {
          addToast?.(
            '这段讨论已经收藏过了',
            'info'
          );
          return;
        }

        try {
          await archiveAnnotationDiscussion(
            char,
            userProfile?.name ||
              '用户',
            annotation.quotedText,
            annotation.comment,
            annotation.thread,
            memoryPalaceConfig
          );

          const updatedBook =
            {
              ...activeBook,
              annotations:
                (
                  activeBook.annotations ||
                  []
                ).map(a =>
                  a.id ===
                  annotation.id
                    ? {
                        ...a,
                        archivedToMemory:
                          true,
                      }
                    : a
                ),
            };

          setActiveBook(
            updatedBook
          );

          await saveBook(
            updatedBook
          );

          addToast?.(
            '已收藏进记忆宫殿',
            'success'
          );
        } catch (error) {
          addToast?.(
            error instanceof Error
              ? error.message
              : '收藏失败，请检查记忆宫殿 API 设置',
            'error'
          );
        }
      },
      [
        activeBook,
        char,
        selectedAnnotationId,
        userProfile,
        memoryPalaceConfig,
        addToast,
      ]
    );

  // --------------------------------------------------
  // 目录跳转
  // --------------------------------------------------

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

        const el =
          readerRef.current;

        if (!el) return;

        const ratio =
          offset /
          Math.max(
            1,
            activeBook.rawText
              .length
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

        setShowChapters(
          false
        );
      },
      [
        activeBook,
        progress,
        scheduleSaveProgress,
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

    const annotations =
      [
        ...(activeBook.annotations ||
          []),
      ].sort(
        (a, b) =>
          a.startOffset -
          b.startOffset
      );

    const selectedAnnotation =
      annotations.find(
        a =>
          a.id ===
          selectedAnnotationId
      ) || null;

    const pieces =
      textPiecesRef.current.length
        ? textPiecesRef.current
        : makeTextPieces(
            activeBook.rawText
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
        {/* 滚动条 */}
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

            .minglight-reader::-webkit-scrollbar-thumb:hover {
              background: rgba(100,100,100,.60);
              background-clip: padding-box;
            }

            .minglight-reader {
              scrollbar-width: auto;
              scrollbar-color: rgba(100,100,100,.45) transparent;
              -webkit-overflow-scrolling: touch;
            }

            .minglight-annotated {
              text-decoration-line: underline;
              text-decoration-thickness: 2px;
              text-underline-offset: 3px;
              cursor: pointer;
            }
          `}
        </style>

        {/* 顶部 */}
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
              setSelectedAnnotationId(
                null
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

          {taReviewing && (
            <div className="text-[10px] opacity-50 flex items-center gap-1">
              <ChatCircleDots
                size={13}
              />
              TA正在共读
            </div>
          )}
        </div>

        {/* 正文 */}
        <div
          ref={readerRef}
          className="minglight-reader flex-1 overflow-y-auto overflow-x-hidden px-5 py-6 leading-relaxed select-text"
          style={{
            fontSize:
              progress.fontSize,
          }}
          onPointerUp={
            handleTextSelection
          }
          onScroll={
            handleReaderScroll
          }
        >
          <div
            data-ml-text-root="true"
          >
            {pieces.map(
              piece => {
                const matched =
                  annotations.filter(
                    a =>
                      piece.startOffset <
                        a.endOffset &&
                      piece.endOffset >
                        a.startOffset
                  );

                const primary =
                  matched[0];

                return (
                  <React.Fragment
                    key={`${piece.startOffset}_${piece.endOffset}`}
                  >
                    <span
                      data-ml-start={
                        piece.startOffset
                      }
                      className={
                        primary
                          ? 'minglight-annotated'
                          : ''
                      }
                      style={
                        primary
                          ? {
                              textDecorationColor:
                                primary.source ===
                                'ta'
                                  ? '#B7791F'
                                  : '#6B7280',
                            }
                          : undefined
                      }
                      onClick={() => {
                        if (
                          primary
                        ) {
                          openAnnotation(
                            primary.id
                          );
                        }
                      }}
                    >
                      {piece.text}
                    </span>

                    {matched.map(
                      annotation => {
                        if (
                          piece.endOffset !==
                          annotation.endOffset
                        ) {
                          return null;
                        }

                        return (
                          <button
                            key={`${annotation.id}_marker`}
                            onClick={e => {
                              e.stopPropagation();
                              openAnnotation(
                                annotation.id
                              );
                            }}
                            className="inline-flex align-super ml-1 opacity-70"
                            style={{
                              color:
                                theme.text,
                            }}
                            aria-label="打开批注"
                          >
                            <ChatCircleDots
                              size={13}
                            />
                          </button>
                        );
                      }
                    )}
                  </React.Fragment>
                );
              }
            )}
          </div>
        </div>

        {/* TA / 用户选择文字后的划线按钮 */}
        {selection && (
          <div
            className="fixed z-40 px-2 py-1 rounded-lg shadow-lg"
            style={{
              left:
                selection.left,
              top:
                selection.top,
              background:
                theme.bg,
              color:
                theme.text,
              border:
                `1px solid ${theme.text}25`,
            }}
          >
            <button
              onClick={() => {
                setComposer({
                  quote:
                    selection.quote,
                  startOffset:
                    selection.startOffset,
                  endOffset:
                    selection.endOffset,
                });

                setComposerText(
                  ''
                );

                setSelectedAnnotationId(
                  null
                );

                setSelection(null);

                window
                  .getSelection()
                  ?.removeAllRanges();
              }}
              className="px-3 py-1 text-xs"
            >
              下划线＋批注
            </button>
          </div>
        )}

        {/* 选择后的批注编辑框 */}
        {composer && (
          <div
            className="absolute inset-0 z-40 flex items-end bg-black/30"
            onClick={() =>
              setComposer(null)
            }
          >
            <div
              className="w-full p-4 rounded-t-2xl shadow-xl"
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
              <div className="text-xs opacity-50 mb-2">
                「{composer.quote}」
              </div>

              <textarea
                value={
                  composerText
                }
                onChange={e =>
                  setComposerText(
                    e.target.value
                  )
                }
                placeholder="写下你对这句话的想法……"
                className="w-full min-h-[90px] rounded-xl border p-3 text-sm bg-transparent outline-none"
                autoFocus
              />

              <div className="flex justify-end gap-2 mt-3">
                <button
                  onClick={() =>
                    setComposer(
                      null
                    )
                  }
                  className="px-4 py-2 text-xs opacity-60"
                >
                  取消
                </button>

                <button
                  onClick={
                    submitUserAnnotation
                  }
                  className="px-4 py-2 bg-amber-700 text-white rounded-full text-xs"
                >
                  发布并听听 TA 的想法
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 批注讨论面板 */}
        {selectedAnnotation && (
          <div
            className="absolute inset-x-0 bottom-0 z-30 shadow-2xl"
            style={{
              background:
                theme.bg,
              color:
                theme.text,
              borderTop:
                `1px solid ${theme.text}20`,
            }}
          >
            <div className="max-h-[58vh] flex flex-col">
              <div
                className="flex items-center justify-between px-4 py-3"
                style={{
                  borderBottom:
                    `1px solid ${theme.text}15`,
                }}
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  <ChatCircleDots
                    size={18}
                  />
                  {selectedAnnotation.source ===
                  'ta'
                    ? 'TA 的批注'
                    : '你的批注'}
                </div>

                <button
                  onClick={() =>
                    setSelectedAnnotationId(
                      null
                    )
                  }
                  className="p-1"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="overflow-y-auto px-4 py-3">
                <div
                  className="text-sm mb-3 px-3 py-2 rounded-lg"
                  style={{
                    background:
                      `${theme.text}10`,
                  }}
                >
                  「
                  {
                    selectedAnnotation.quotedText
                  }
                  」
                </div>

                {/* TA 原始批注 / 用户原始批注 */}
                <div className="mb-3">
                  <div className="text-[10px] opacity-45 mb-1">
                    {selectedAnnotation.source ===
                    'ta'
                      ? char.name
                      : userProfile?.name ||
                        '你'}
                  </div>

                  <div className="text-sm leading-relaxed">
                    {
                      selectedAnnotation.comment
                    }
                  </div>
                </div>

                {/* 讨论线程 */}
                {selectedAnnotation.thread.map(
                  message => (
                    <div
                      key={
                        message.id
                      }
                      className={`mb-3 ${
                        message.role ===
                        'user'
                          ? 'text-right'
                          : 'text-left'
                      }`}
                    >
                      <div className="text-[10px] opacity-45 mb-1">
                        {message.role ===
                        'user'
                          ? userProfile?.name ||
                            '你'
                          : char.name}
                      </div>

                      <div
                        className="inline-block max-w-[88%] px-3 py-2 rounded-xl text-sm text-left"
                        style={{
                          background:
                            message.role ===
                            'user'
                              ? `${theme.text}14`
                              : `${theme.text}0A`,
                        }}
                      >
                        {
                          message.text
                        }
                      </div>
                    </div>
                  )
                )}
              </div>

              {/* 底部操作区 */}
              <div
                className="px-4 pt-2 pb-3"
                style={{
                  borderTop:
                    `1px solid ${theme.text}15`,
                }}
              >
                <div className="flex items-center gap-2">
                  <input
                    value={
                      threadInput
                    }
                    onChange={e =>
                      setThreadInput(
                        e.target
                          .value
                      )
                    }
                    onKeyDown={e => {
                      if (
                        e.key ===
                          'Enter' &&
                        !e.shiftKey
                      ) {
                        e.preventDefault();
                        void sendThreadMessage();
                      }
                    }}
                    placeholder="继续和 TA 讨论……"
                    className="flex-1 rounded-full border px-4 py-2 text-sm bg-transparent outline-none"
                  />

                  <button
                    onClick={() =>
                      void sendThreadMessage()
                    }
                    disabled={
                      threadSending ||
                      !threadInput.trim()
                    }
                    className="w-9 h-9 rounded-full flex items-center justify-center border disabled:opacity-30"
                  >
                    <PaperPlaneTilt
                      size={16}
                    />
                  </button>
                </div>

                <button
                  onClick={() =>
                    void archiveSelectedAnnotation()
                  }
                  className="mt-2 text-[11px] flex items-center gap-1 opacity-55"
                >
                  <Brain
                    size={13}
                  />

                  {selectedAnnotation.archivedToMemory
                    ? '已收藏进记忆宫殿'
                    : '收藏进记忆宫殿'}
                </button>

                {threadSending && (
                  <div className="text-[10px] opacity-40 mt-1">
                    TA 正在回复……
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 左下角目录 */}
        <button
          onClick={() =>
            setShowChapters(
              v => !v
            )
          }
          className="absolute bottom-4 left-4 z-20 w-11 h-11 rounded-full backdrop-blur flex items-center justify-center shadow"
          style={{
            background:
              `${theme.text}18`,
          }}
          aria-label="目录"
        >
          <List size={20} />
        </button>

        {/* 目录：颜色跟随阅读主题 */}
        {showChapters && (
          <div
            className="absolute inset-0 z-40"
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
                      className="w-full text-left px-4 py-3 text-sm active:opacity-60"
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

                    void handleDeleteBook(
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

              {!!book.annotations?.length && (
                <div className="text-[10px] text-gray-400">
                  {book.annotations.length} 条批注
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
                  void handleFileChosen(
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
