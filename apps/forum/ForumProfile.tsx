import React, { useEffect, useState } from 'react';
import * as db from '../../utils/forumDb';
import ForumPostCard from './ForumPostCard';

interface Props {
  accountId: string;
  onOpenPost: (postId: string) => void;
}

/** [交接5 4.7] 个人主页只显示"当前登录使用中的这个账号"发的帖子，不合并用户名下所有账号。 */
const ForumProfile: React.FC<Props> = ({ accountId, onOpenPost }) => {
  const [account, setAccount] = useState<db.ForumAccount | null>(null);
  const [posts, setPosts] = useState<db.ForumPost[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [acc, myPosts] = await Promise.all([db.getForumAccount(accountId), db.getForumPostsByAuthor(accountId)]);
      if (cancelled) return;
      setAccount(acc);
      setPosts(myPosts);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [accountId]);

  if (loading) return <div className="text-center py-16 text-sm opacity-50">加载中…</div>;
  if (!account) return <div className="text-center py-16 text-sm opacity-50">账号不存在</div>;

  return (
    <div className="pb-8">
      <div className="flex items-center gap-3 px-4 py-4 border-b" style={{ borderColor: 'rgba(127,127,127,0.15)' }}>
        {account.avatar
          ? <img src={account.avatar} className="w-14 h-14 rounded-full object-cover" />
          : <div className="w-14 h-14 rounded-full flex items-center justify-center text-lg font-bold" style={{ background: 'rgba(127,127,127,0.2)' }}>{account.displayName?.[0]}</div>}
        <div>
          <div className="font-bold text-base flex items-center gap-1">
            {account.displayName}
            {account.isVerified && <span className="text-blue-400">✔</span>}
          </div>
          <div className="text-[12px] opacity-50">@{account.handle}</div>
          {account.status === 'deactivated' && <div className="text-[11px] opacity-50 mt-0.5">已注销用户</div>}
        </div>
      </div>
      {posts.length === 0 && <div className="text-center py-16 text-sm opacity-50">还没有发过帖子</div>}
      {posts.map(p => (
        <ForumPostCard key={p.id} post={p} author={account} commentCount={0} onClick={() => onOpenPost(p.id)} />
      ))}
    </div>
  );
};

export default ForumProfile;
