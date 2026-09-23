import React, { useEffect, useState } from 'react';
import * as db from '../../utils/forumDb';
import ForumPostCard from './ForumPostCard';

interface Props {
  onOpenPost: (postId: string) => void;
}

/** [交接5 4.7] 收藏：仅显示用户手动收藏的帖子。 */
const ForumCollected: React.FC<Props> = ({ onOpenPost }) => {
  const [posts, setPosts] = useState<db.ForumPost[]>([]);
  const [accountsById, setAccountsById] = useState<Map<string, db.ForumAccount>>(new Map());
  const [commentCounts, setCommentCounts] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [all, accounts] = await Promise.all([db.getForumPostsRaw(), db.getAllForumAccounts()]);
      if (cancelled) return;
      const collected = all.filter(p => p.isCollected);
      setPosts(collected);
      setAccountsById(new Map(accounts.map(a => [a.id, a])));
      setLoading(false);
      // 评论数原来写死是 0，收藏的帖子底下明明有人说过话却显示 0，看着像出了故障。
      // 一次事务批量数，跟主页/分区页同一个函数。
      const counts = await db.getCommentCountsByPosts(collected.map(p => p.id));
      if (!cancelled) setCommentCounts(counts);
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="text-center py-16 text-sm opacity-50">加载中…</div>;
  if (posts.length === 0) return <div className="text-center py-16 text-sm opacity-50">还没有收藏</div>;

  return (
    <div className="pb-8">
      {posts.map(p => (
        <ForumPostCard key={p.id} post={p} author={accountsById.get(p.authorAccountId)} commentCount={commentCounts.get(p.id) || 0} onClick={() => onOpenPost(p.id)} />
      ))}
    </div>
  );
};

export default ForumCollected;
