/**
 * 文章全文阅读页（公众号推送风）—— 朋友圈 App 与聊天框转发卡片共用同一份。
 *
 * 为什么抽出来：朋友圈里点文章卡片、聊天框里点转发过来的朋友圈卡片，应该看到
 * 同一个页面。之前这段只存在于 apps/MomentsApp.tsx 的 renderArticleReader 里，
 * MessageItem.tsx 那边完全没有「全屏详情页」的机制。抽成独立组件后两边引用同一份，
 * 以后改排版只改这里，不会再出现两套长得不一样的详情页。
 *
 * 关注点分离：本组件只负责「渲染 + 触发生成虚拟评论区」，生成结果通过
 * onCommentsGenerated 回调交还调用方，由调用方自己决定存哪：
 *   - 朋友圈 App → 写回 MomentPost.article，savePost 落 SullyOS_Moments 库
 *   - 聊天框    → 写回那条 moment_card 消息 content 里的 JSON（见 MomentArticleReaderHost）
 * 组件本身不碰任何持久化。
 */

import React, { useCallback, useState } from 'react';
import { CaretLeft } from '@phosphor-icons/react';
import TokenImg from '../os/TokenImg';
import type { CharacterProfile, UserProfile, APIConfig } from '../../types';
import type { MomentArticleCard } from '../../utils/momentsDb';
import { generateFakeArticleComments } from '../../utils/momentsAi';

export interface ArticleReaderProps {
  article: MomentArticleCard;
  onClose: () => void;
  /**
   * 生成完虚拟评论区后回调，参数是「带上 fakeComments 的新 article 对象」。
   * 调用方负责持久化 + 把新对象回灌给本组件的 article prop（本组件不自己缓存）。
   */
  onCommentsGenerated?: (updatedArticle: MomentArticleCard) => void | Promise<void>;
  char: CharacterProfile | null;
  userProfile: UserProfile;
  apiConfig: APIConfig;
  onToast?: (message: string, type?: 'info' | 'success' | 'error') => void;
  /**
   * 覆盖层 z-index。朋友圈 App 内部 50 就够；聊天框里要压过输入区那一堆
   * z-[105]~z-[120] 的浮层，传 140（仍低于 Chat 里 150/200 的模态）。
   */
  zIndex?: number;
}

const ArticleReader: React.FC<ArticleReaderProps> = ({
  article,
  onClose,
  onCommentsGenerated,
  char,
  userProfile,
  apiConfig,
  onToast,
  zIndex = 50,
}) => {
  const [generating, setGenerating] = useState(false);

  const text = article.fullText?.trim() || article.body?.trim() || '（这篇文章没有留下更多内容）';
  const threads = article.fakeComments;

  /**
   * 点评论区中间那个不明显的「网络不好，刷新试试...」按钮：生成一次虚拟评论区，
   * 结果通过 onCommentsGenerated 交给调用方缓存，之后重复打开不用再生成。
   */
  const handleGenerateComments = useCallback(async () => {
    if (!char) return;
    if (!apiConfig.apiKey || !apiConfig.baseUrl) {
      onToast?.('请先配置 API', 'info');
      return;
    }
    setGenerating(true);
    try {
      const generated = await generateFakeArticleComments({ char, userProfile, apiConfig, article });
      await onCommentsGenerated?.({ ...article, fakeComments: generated });
    } catch (e: any) {
      onToast?.(`评论加载失败: ${e?.message?.slice(0, 60) || '未知错误'}`, 'error');
    } finally {
      setGenerating(false);
    }
  }, [char, apiConfig, userProfile, article, onCommentsGenerated, onToast]);

  return (
    <div className="fixed inset-0 flex flex-col" style={{ background: '#f5f5f7', zIndex }}>
      <div className="flex items-center gap-3 px-4 py-3 border-b border-black/5 shrink-0 bg-white">
        <button onClick={onClose} className="text-slate-500 active:scale-90">
          <CaretLeft size={22} />
        </button>
        <div className="text-sm font-medium truncate flex-1 text-slate-800">{article.title || '未命名文章'}</div>
        {article.url && (
          <button
            onClick={() => window.open(article.url, '_blank', 'noopener,noreferrer')}
            className="text-[11px] text-blue-500 active:scale-95 shrink-0 flex items-center gap-0.5"
          >
            查看原网页
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* 正文区：仿公众号推送排版 */}
        <div className="bg-white px-5 pt-6 pb-5">
          <div className="text-xl font-bold mb-4 leading-snug text-slate-900">
            {article.title || '未命名文章'}
          </div>
          {article.image && (
            <TokenImg value={article.image} alt="" className="w-full rounded-lg mb-4 object-cover max-h-56" />
          )}
          {article.body && (
            <div className="text-sm mb-3 text-slate-500">
              {article.body}
            </div>
          )}
          <div className="text-[15px] leading-[1.9] whitespace-pre-wrap text-slate-700">
            {text}
          </div>
        </div>

        {/* 虚拟评论区 */}
        <div className="mt-2 bg-white px-4 py-4">
          <div className="text-sm font-medium text-slate-800 mb-3">精选留言</div>
          {!threads || threads.length === 0 ? (
            <button
              onClick={handleGenerateComments}
              disabled={generating}
              className="w-full py-8 text-center text-xs text-slate-300 active:scale-[0.99] transition-transform disabled:opacity-60"
            >
              {generating ? '加载中…' : '网络不好，刷新试试...'}
            </button>
          ) : (
            <div className="space-y-4">
              {threads.map((thread, i) => (
                <div key={i}>
                  <div className="flex items-start gap-2">
                    <div
                      className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-[11px] font-medium text-white"
                      style={{ background: thread.isChar ? '#807c9d' : '#c2c2c8' }}
                    >
                      {thread.authorName.slice(0, 1)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium" style={{ color: thread.isChar ? '#5a49a8' : '#64748b' }}>
                        {thread.authorName}
                      </div>
                      <div className="text-sm text-slate-700 mt-0.5">{thread.content}</div>
                    </div>
                  </div>
                  {thread.replies.length > 0 && (
                    <div className="ml-9 mt-2 pl-3 border-l border-slate-100 space-y-2">
                      {thread.replies.map((reply, j) => (
                        <div key={j} className="text-xs">
                          <span className="font-medium" style={{ color: reply.isChar ? '#5a49a8' : '#64748b' }}>
                            {reply.authorName}
                          </span>
                          <span className="text-slate-500">：{reply.content}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ArticleReader;
