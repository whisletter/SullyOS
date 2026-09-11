/**
 * 「眠光」—— 和角色一起共读的阅读器。
 *
 * 这是第一版骨架，先做通：书架 / 导入纯文本 / 全屏阅读 / 主题与字号 / 进度保存。
 * 划线批注对话、章节自动总结（读后感+客观总结）、收藏进记忆宫殿，放在下一版加。
 */
/**
 * 「眠光」—— 和角色一起共读的阅读器。
 *
 * 当前版本：
 * - 导入 TXT
 * - 导入 EPUB
 * - EPUB 自动读取书名、作者、封面
 * - 全屏阅读
 * - 四种主题
 * - 字号调整
 * - 阅读进度自动保存
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
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
} from '@phosphor-icons/react';

import { useOS } from '../context/OSContext';

import {
  MingLightBook,
  MingLightProgress,
  MingLightTheme,
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
  return `ml_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const MingLightApp: React.FC = () => {
  const { activeCharacterId, characters, closeApp, addToast } = useOS();

  const char = characters.find(
    c => c.id === activeCharacterId
  );

  const [books, setBooks] = useState<MingLightBook[]>([]);
  const [loading, setLoading] = useState(true);

  const [activeBook, setActiveBook] =
    useState<MingLightBook | null>(null);

  const [progress, setProgress] =
    useState<MingLightProgress | null>(null);

  const [showImportModal, setShowImportModal] =
    useState(false);

  const fileInputRef =
    useRef<HTMLInputElement>(null);

  const refreshBooks = useCallback(async () => {
    if (!activeCharacterId) return;

    setLoading(true);

    try {
      const list = await getBooksForChar(
        activeCharacterId
      );

      setBooks(
        list.sort(
          (a, b) => b.createdAt - a.createdAt
        )
      );
    } catch (e) {
      addToast?.('书架加载失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [activeCharacterId, addToast]);

  useEffect(() => {
    refreshBooks();
  }, [refreshBooks]);

  // 打开一本书
  const openBook = useCallback(
    async (book: MingLightBook) => {
      if (!activeCharacterId) return;

      const existing = await getProgress(
        book.id,
        activeCharacterId
      );

      setActiveBook(book);

      setProgress(
        existing || {
          id: `${book.id}__${activeCharacterId}`,
          bookId: book.id,
          charId: activeCharacterId,
          charOffset: 0,
          theme: 'day',
          fontSize: 18,
          updatedAt: Date.now(),
        }
      );
    },
    [activeCharacterId]
  );

  // 导入 TXT / EPUB
  const handleFileChosen = useCallback(
    async (file: File) => {
      if (!activeCharacterId) return;

      try {
        const fileName = file.name.toLowerCase();

        // ---------------- TXT ----------------
        if (fileName.endsWith('.txt')) {
          const reader = new FileReader();

          reader.onload = async () => {
            try {
              const text = String(
                reader.result || ''
              );

              if (!text.trim()) {
                addToast?.(
                  '这个文件读不到文字内容，换一个试试',
                  'error'
                );
                return;
              }

              const defaultTitle =
                file.name.replace(/\.txt$/i, '');

              const book: MingLightBook = {
                id: genId(),
                charId: activeCharacterId,
                title: defaultTitle,
                author: '',
                coverUrl: '',
                rawText: text,
                chapters:
                  splitIntoChapters(text),
                createdAt: Date.now(),
              };

              await saveBook(book);

              setShowImportModal(false);

              addToast?.(
                `《${defaultTitle}》导入成功`,
                'success'
              );

              await refreshBooks();
            } catch (e) {
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

          reader.readAsText(file, 'utf-8');

          return;
        }

        // ---------------- EPUB ----------------
        if (fileName.endsWith('.epub')) {
          addToast?.(
            '正在读取 EPUB…',
            'success'
          );

          const imported =
            await importEpub(file);

          const book: MingLightBook = {
            id: genId(),
            charId: activeCharacterId,
            title:
              imported.title ||
              file.name.replace(/\.epub$/i, ''),
            author: imported.author || '',
            coverUrl:
              imported.coverUrl || '',
            rawText: imported.rawText,
            chapters:
              splitIntoChapters(
                imported.rawText
              ),
            createdAt: Date.now(),
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
          '目前只支持 TXT 和 EPUB 文件',
          'error'
        );
      } catch (error) {
        console.error(
          'MingLight import error:',
          error
        );

        const message =
          error instanceof Error
            ? error.message
            : '文件导入失败';

        addToast?.(message, 'error');
      }
    },
    [
      activeCharacterId,
      addToast,
      refreshBooks,
    ]
  );

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

  // 阅读进度防抖保存
  const saveTimer =
    useRef<number | null>(null);

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

  // =====================================================
  // 阅读页
  // =====================================================

  if (activeBook && progress) {
    const theme =
      THEME_STYLES[progress.theme];

    return (
      <div
        className="h-full flex flex-col"
        style={{
          background: theme.bg,
          color: theme.text,
        }}
      >
        {/* 顶部栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-black/10">
          <button
            onClick={() => {
              setActiveBook(null);
              setProgress(null);
            }}
            className="p-1"
          >
            <CaretLeft size={22} />
          </button>

          <div className="text-sm font-medium truncate max-w-[60%]">
            {activeBook.title}
          </div>

          <button
            onClick={closeApp}
            className="p-1"
          >
            <X size={20} />
          </button>
        </div>

        {/* 书籍信息 */}
        {(activeBook.author ||
          activeBook.coverUrl) && (
          <div className="px-5 pt-3 text-xs opacity-60">
            {activeBook.author && (
              <span>
                {activeBook.author}
              </span>
            )}
          </div>
        )}

        {/* 主题 + 字号 */}
        <div className="flex items-center justify-center gap-2 py-2 border-b border-black/10 flex-wrap">
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
                  fontSize:
                    Number(
                      e.target.value
                    ),
                  updatedAt: Date.now(),
                })
              }
              className="w-20"
            />
          </div>
        </div>

        {/* 正文 */}
        <div
          className="flex-1 overflow-y-auto px-5 py-4 whitespace-pre-wrap leading-relaxed"
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

            const offset = Math.round(
              ratio *
                activeBook.rawText.length
            );

            scheduleSaveProgress({
              ...progress,
              charOffset: offset,
              updatedAt: Date.now(),
            });
          }}
        >
          {activeBook.rawText}
        </div>
      </div>
    );
  }

  // =====================================================
  // 书架页
  // =====================================================

  return (
    <div className="h-full flex flex-col bg-[#F7F2EA]">
      {/* 顶部 */}
      <div className="flex items-center justify-between px-4 py-3">
        <button
          onClick={closeApp}
          className="p-1"
        >
          <CaretLeft size={22} />
        </button>

        <div className="text-base font-semibold">
          眠光 · 和{char.name}的书架
        </div>

        <button
          onClick={() =>
            setShowImportModal(true)
          }
          className="p-1"
        >
          <Plus size={22} />
        </button>
      </div>

      {/* 书架 */}
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
              setShowImportModal(true)
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
      {showImportModal && (
        <div
          className="absolute inset-0 bg-black/40 flex items-center justify-center z-10"
          onClick={() =>
            setShowImportModal(false)
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
                  handleFileChosen(f);
                }

                // 允许连续选择同一个文件
                e.currentTarget.value = '';
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
                setShowImportModal(false)
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
