import React, { useEffect, useState } from 'react';
import * as db from '../../utils/forumDb';
import { isUserSideAccount } from '../../utils/forumFeed';

interface Props {
  activeAccount: db.ForumAccount;
  onOpenPost: (postId: string) => void;
}

interface NotificationItem {
  postId: string;
  postTitle: string;
  fromAccount?: db.ForumAccount;
  content: string;
  createdAt: number;
}

/**
 * [交接5 4.5] 覆盖范围：所有角色的回复都算，不管是TA本人还是路人NPC接的，
 * 只要回复了用户的评论/帖子就算。这里没有专门的通知表，是从帖子+评论里现算的
 * 派生视图（报告没要求"抄送落库"，只要求"看得到"，现算能满足同样效果）。
 */
const ForumNotifications: React.FC<Props> = ({ onOpenPost }) => {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [posts, accounts] = await Promise.all([db.getForumPostsRaw(), db.getAllForumAccounts()]);
      const accountsById = new Map(accounts.map(a => [a.id, a]));
      const result: NotificationItem[] = [];

      for (const post of posts) {
        const comments = await db.getCommentsByPost(post.id);
        const byId = new Map(comments.map(c => [c.id, c]));
        for (const c of comments) {
          const replierAccount = accountsById.get(c.authorAccountId);
          if (isUserSideAccount(replierAccount)) continue; // 只关心"别人回我"，不关心我自己发的

          const parentAuthorId = c.parentCommentId ? byId.get(c.parentCommentId)?.authorAccountId : post.authorAccountId;
          const parentAuthorAccount = parentAuthorId ? accountsById.get(parentAuthorId) : undefined;
          if (!isUserSideAccount(parentAuthorAccount)) continue; // 回复对象不是用户方，不算通知

          result.push({ postId: post.id, postTitle: post.title || post.content.slice(0, 20), fromAccount: replierAccount, content: c.content, createdAt: c.createdAt });
        }
      }
      result.sort((a, b) => b.createdAt - a.createdAt);
      setItems(result.slice(0, 50));
      setLoading(false);
    })();
  }, []);

  if (loading) return <div className="text-center py-16 text-sm opacity-50">加载中…</div>;
  if (items.length === 0) return <div className="text-center py-16 text-sm opacity-50">还没有人回复你</div>;

  return (
    <div className="pb-8">
      {items.map((item, i) => (
        <button
          key={i}
          onClick={() => onOpenPost(item.postId)}
          className="w-full text-left px-3 py-3 border-b"
          style={{ borderColor: 'rgba(127,127,127,0.15)' }}
        >
          <div className="text-[13px]">
            <span className="font-semibold">{item.fromAccount?.displayName || '未知账号'}</span>
            <span className="opacity-60"> 回复了你在《{item.postTitle}》里的发言</span>
          </div>
          <div className="text-[13px] opacity-80 mt-0.5">{item.content}</div>
        </button>
      ))}
    </div>
  );
};

export default ForumNotifications;
