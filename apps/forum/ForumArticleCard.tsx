import React from 'react';
import { Article } from '@phosphor-icons/react';
import type { ForumArticleCard as ForumArticleCardData } from '../../utils/forumDb';

interface Props {
  article: ForumArticleCardData;
  /** 点了在新标签页打开原文。跟音乐卡同理，只有详情页那张开着。 */
  openable?: boolean;
}

/**
 * 论坛文章卡片。卡片上只显示标题 + 一小段摘要 + 封面，抓到的完整正文（fullText）
 * 不在这里展示——那份是留给 TA 读的，它要评论一篇文章总得先看过内容。
 *
 * 朋友圈那版还带一个"虚拟评论区"（AI 生成的假评论），论坛不抄那个：
 * 论坛帖子本来就有真的评论区，再配一套假的没意义。
 */
const ForumArticleCard: React.FC<Props> = ({ article, openable }) => {
  const handleOpen = () => {
    if (!openable || !article.url) return;
    window.open(article.url, '_blank', 'noopener,noreferrer');
  };

  const excerpt = article.body
    ? (article.body.length > 60 ? `${article.body.slice(0, 60)}…` : article.body)
    : '';

  return (
    <div
      onClick={handleOpen}
      className={`flex items-center gap-3 rounded-xl p-2.5 mt-2 ${openable && article.url ? 'cursor-pointer active:scale-[0.98] transition-transform' : ''}`}
      style={{ background: 'rgba(127,127,127,0.12)', border: '1px solid rgba(127,127,127,0.15)' }}
    >
      {article.image
        ? <img src={article.image} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0" />
        : (
          <div className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(127,127,127,0.2)' }}>
            <Article size={20} style={{ opacity: 0.4 }} />
          </div>
        )}
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium truncate">{article.title || article.url || '未命名文章'}</div>
        {excerpt && <div className="text-[11px] opacity-50 mt-0.5 line-clamp-2">{excerpt}</div>}
      </div>
      <Article size={18} weight="fill" style={{ opacity: 0.3 }} className="shrink-0" />
    </div>
  );
};

export default ForumArticleCard;
