import React, { useEffect, useState, useCallback } from 'react';
import { FORUM_TOPIC_TAGS } from '../../utils/forumConstants';
import * as db from '../../utils/forumDb';
import * as feed from '../../utils/forumFeed';
import ForumPostCard from './ForumPostCard';
import { useOS } from '../../context/OSContext';
import { RealtimeContextManager } from '../../utils/realtimeContext';
import { DB } from '../../utils/db';
import type { HotNewsSnapshot } from '../../types';

interface Props {
  onOpenTopic: (topicTag: string) => void;
  onOpenPost: (postId: string) => void;
}

/**
 * [交接5 4.3] 主页结构固定三段：
 *   1. 顶部标签快捷入口条（点标签跳转分区页，不在主页本地过滤）
 *   2. 热搜榜（只在主页出现一次，分区页不重复放；直接复用 HotNewsApp 现成的存取方式）
 *   3. 主 feed（混合帖子流）
 */
const ForumHome: React.FC<Props> = ({ onOpenTopic, onOpenPost }) => {
  const { realtimeConfig } = useOS();
  const [snapshot, setSnapshot] = useState<HotNewsSnapshot | null>(null);
  const [posts, setPosts] = useState<db.ForumPost[]>([]);
  const [accountsById, setAccountsById] = useState<Map<string, db.ForumAccount>>(new Map());
  const [commentCounts, setCommentCounts] = useState<Map<string, number>>(new Map());
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);

  const loadAccountsAndCounts = useCallback(async (pagePosts: db.ForumPost[]) => {
    const accounts = await db.getAllForumAccounts();
    setAccountsById(prev => {
      const next = new Map(prev);
      for (const a of accounts) next.set(a.id, a);
      return next;
    });
    // 一次事务里走索引 count 数完整页，不再一条帖子一次查询（一页 15 条 = 15 次串行往返）
    const counts = await db.getCommentCountsByPosts(pagePosts.map(p => p.id));
    setCommentCounts(prev => new Map([...prev, ...counts]));
  }, []);

  const loadHotNews = useCallback(async () => {
    try {
      await RealtimeContextManager.getSlottedHotNews(realtimeConfig);
      const { id } = RealtimeContextManager.getHotNewsSlot();
      let snap = await DB.getHotNewsSnapshot(id);
      if (!snap) snap = await DB.getLatestHotNewsSnapshot();
      setSnapshot(snap);
    } catch {
      // 拉不到热搜不影响主 feed 展示
    }
  }, [realtimeConfig]);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    try {
      const page = await feed.getFeedPage({ visibility: 'public', pageSize: 15 });
      setPosts(page.posts);
      setCursor(page.nextCursor);
      setHasMore(!!page.nextCursor);
      await loadAccountsAndCounts(page.posts);
    } finally {
      setLoading(false);
    }
    await loadHotNews();
  }, [loadAccountsAndCounts, loadHotNews]);

  const loadMore = useCallback(async () => {
    if (!hasMore) return;
    const page = await feed.getFeedPage({ visibility: 'public', pageSize: 15, cursor });
    setPosts(prev => [...prev, ...page.posts]);
    setCursor(page.nextCursor);
    setHasMore(!!page.nextCursor);
    await loadAccountsAndCounts(page.posts);
  }, [cursor, hasMore, loadAccountsAndCounts]);

  useEffect(() => { loadFirstPage(); }, [loadFirstPage]);

  return (
    <div className="pb-8">
      {/* 一、标签条 */}
      <div className="flex gap-2 overflow-x-auto no-scrollbar px-3 py-2.5 border-b" style={{ borderColor: 'rgba(127,127,127,0.15)' }}>
        {FORUM_TOPIC_TAGS.map(t => (
          <button
            key={t.tag}
            onClick={() => onOpenTopic(t.tag)}
            className="shrink-0 text-[13px] px-3 py-1.5 rounded-full whitespace-nowrap"
            style={{ background: 'rgba(127,127,127,0.12)' }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 二、热搜榜（仅主页） */}
      {snapshot && snapshot.items.length > 0 && (
        <div className="px-3 py-2.5 border-b" style={{ borderColor: 'rgba(127,127,127,0.15)' }}>
          <div className="text-[12px] font-bold opacity-60 mb-1.5">🔥 {snapshot.slotLabel}热点</div>
          <div className="space-y-1">
            {snapshot.items.slice(0, 5).map((it, i) => (
              <div key={i} className="text-[12px] flex gap-1.5 opacity-80">
                <span className="opacity-50 shrink-0">{i + 1}.</span>
                <span className="truncate">{it.title}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 三、主 feed */}
      {loading && posts.length === 0 && <div className="text-center py-16 text-sm opacity-50">加载中…</div>}
      {!loading && posts.length === 0 && <div className="text-center py-16 text-sm opacity-50">还没有帖子，点右上角"刷新出新帖"试试</div>}
      {posts.map(p => (
        <ForumPostCard
          key={p.id}
          post={p}
          author={accountsById.get(p.authorAccountId)}
          commentCount={commentCounts.get(p.id) || 0}
          onClick={() => onOpenPost(p.id)}
        />
      ))}
      {hasMore && posts.length > 0 && (
        <button onClick={loadMore} className="w-full text-center py-3 text-sm opacity-60">加载更多</button>
      )}
    </div>
  );
};

export default ForumHome;
