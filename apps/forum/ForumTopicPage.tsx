import React, { useEffect, useState, useCallback } from 'react';
import { ArrowsClockwise } from '@phosphor-icons/react';
import * as db from '../../utils/forumDb';
import * as feed from '../../utils/forumFeed';
import ForumPostCard from './ForumPostCard';
import { getTopicLabel, type ForumTopicTag } from '../../utils/forumConstants';

interface Props {
  topicTag: string;
  onOpenPost: (postId: string) => void;
  /** 只刷这一个分区。返回新增条数；调用方负责 toast，这里只管重载列表。 */
  onRefresh?: (topicTag: string) => Promise<number>;
}

/** [交接5 4.3] 分区页：点标签跳进来的独立页面，只显示该分类，没有热搜榜、没有其它分类内容。
 *  右上角🔄只生成当前这一个分区的新帖，不动其它分区。 */
const ForumTopicPage: React.FC<Props> = ({ topicTag, onOpenPost, onRefresh }) => {
  const [posts, setPosts] = useState<db.ForumPost[]>([]);
  const [accountsById, setAccountsById] = useState<Map<string, db.ForumAccount>>(new Map());
  const [commentCounts, setCommentCounts] = useState<Map<string, number>>(new Map());
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadAccountsAndCounts = useCallback(async (pagePosts: db.ForumPost[]) => {
    const accounts = await db.getAllForumAccounts();
    setAccountsById(prev => { const next = new Map(prev); for (const a of accounts) next.set(a.id, a); return next; });
    // 跟主页同一套：一次事务批量数，不再逐条把评论全读出来再取 length
    const counts = await db.getCommentCountsByPosts(pagePosts.map(p => p.id));
    setCommentCounts(prev => new Map([...prev, ...counts]));
  }, []);

  const loadFirstPage = useCallback(async () => {
    setLoading(true);
    setPosts([]);
    try {
      const page = await feed.getFeedPage({ visibility: 'public', topicTag, pageSize: 15 });
      setPosts(page.posts);
      setCursor(page.nextCursor);
      setHasMore(!!page.nextCursor);
      await loadAccountsAndCounts(page.posts);
    } finally {
      setLoading(false);
    }
  }, [topicTag, loadAccountsAndCounts]);

  useEffect(() => { loadFirstPage(); }, [loadFirstPage]);

  const loadMore = useCallback(async () => {
    if (!hasMore) return;
    const page = await feed.getFeedPage({ visibility: 'public', topicTag, pageSize: 15, cursor });
    setPosts(prev => [...prev, ...page.posts]);
    setCursor(page.nextCursor);
    setHasMore(!!page.nextCursor);
    await loadAccountsAndCounts(page.posts);
  }, [cursor, hasMore, topicTag, loadAccountsAndCounts]);

  const handleRefresh = useCallback(async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      const added = await onRefresh(topicTag);
      if (added > 0) await loadFirstPage();
    } finally {
      setRefreshing(false);
    }
  }, [onRefresh, refreshing, topicTag, loadFirstPage]);

  return (
    <div className="pb-8">
      <div
        className="flex items-center px-3 py-2.5 border-b"
        style={{ borderColor: 'rgba(127,127,127,0.15)' }}
      >
        <span className="font-bold text-[15px]">{getTopicLabel(topicTag as ForumTopicTag)}</span>
        {onRefresh && (
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="ml-auto flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-full active:scale-90 transition-transform disabled:opacity-50"
            style={{ background: 'rgba(127,127,127,0.12)' }}
          >
            <ArrowsClockwise size={13} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? '生成中…' : '刷新本区'}
          </button>
        )}
      </div>

      {loading && posts.length === 0 && <div className="text-center py-16 text-sm opacity-50">加载中…</div>}
      {!loading && posts.length === 0 && (
        <div className="text-center py-16 text-sm opacity-50">
          这个分区还没有帖子{onRefresh ? '，点右上角刷新本区' : ''}
        </div>
      )}
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

export default ForumTopicPage;
