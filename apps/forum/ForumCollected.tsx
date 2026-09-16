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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [all, accounts] = await Promise.all([db.getForumPostsRaw(), db.getAllForumAccounts()]);
      setPosts(all.filter(p => p.isCollected));
      setAccountsById(new Map(accounts.map(a => [a.id, a])));
      setLoading(false);
    })();
  }, []);

  if (loading) return <div className="text-center py-16 text-sm opacity-50">加载中…</div>;
  if (posts.length === 0) return <div className="text-center py-16 text-sm opacity-50">还没有收藏</div>;

  return (
    <div className="pb-8">
      {posts.map(p => (
        <ForumPostCard key={p.id} post={p} author={accountsById.get(p.authorAccountId)} commentCount={0} onClick={() => onOpenPost(p.id)} />
      ))}
    </div>
  );
};

export default ForumCollected;
