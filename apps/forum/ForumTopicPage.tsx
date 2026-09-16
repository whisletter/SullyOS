import React, { useEffect, useState, useCallback } from 'react';
import * as db from '../../utils/forumDb';
import * as feed from '../../utils/forumFeed';
import ForumPostCard from './ForumPostCard';
import { getTopicLabel, type ForumTopicTag } from '../../utils/forumConstants';

interface Props {
  topicTag: string;
  onOpenPost: (postId: string) => void;
}

/** [交接5 4.3] 分区页：点标签跳进来的独立页面，只显示该分类，没有热搜榜、没有其它分类内容。 */
const ForumTopicPage: React.FC<Props> = ({ topicTag, onOpenPost }) => {
  const [posts, setPosts] = useState<db.ForumPost[]>([]);
  const [accountsById, setAccountsById] = useState<Map<string, db.ForumAccount>>(new Map());
  const [commentCounts, setCommentCounts] = useState<Map<string, number>>(new Map());
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);

  const loadAccountsAndCounts = useCallback(async (pagePosts: db.ForumPost[]) => {
    const accounts = await db.getAllForumAccounts();
    setAccountsById(prev => { const next = new Map(prev); for (const a of accounts) next.set(a.id, a); return next; });
    const counts = new Map<string, number>();
    for (const p of pagePosts) counts.set(p.id, (await db.getCommentsByPost(p.id)).length);
    setCommentCounts(prev => new Map([...prev, ...counts]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setPosts([]);
      const page = await feed.getFeedPage({ visibility: 'public', topicTag, pageSize: 15 });
      if (cancelled) return;
      setPosts(page.posts);
      setCursor(page.nextCursor);
      setHasMore(!!page.nextCursor);
      await loadAccountsAndCounts(page.posts);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [topicTag, loadAccountsAndCounts]);

  const loadMore = useCallback(async () => {
    if (!hasMore) return;
    const page = await feed.getFeedPage({ visibility: 'public', topicTag, pageSize: 15, cursor });
    setPosts(prev => [...prev, ...page.posts]);
    setCursor(page.nextCursor);
    setHasMore(!!page.nextCursor);
    await loadAccountsAndCounts(page.posts);
  }, [cursor, hasMore, topicTag, loadAccountsAndCounts]);

  return (
    <div className="pb-8">
      <div className="px-3 py-2.5 font-bold text-[15px] border-b" style={{ borderColor: 'rgba(127,127,127,0.15)' }}>
        {getTopicLabel(topicTag as ForumTopicTag)}
      </div>
      {loading && posts.length === 0 && <div className="text-center py-16 text-sm opacity-50">加载中…</div>}
      {!loading && posts.length === 0 && <div className="text-center py-16 text-sm opacity-50">这个分区还没有帖子</div>}
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
