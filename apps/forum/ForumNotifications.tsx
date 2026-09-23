import React, { useEffect, useState } from 'react';
import * as db from '../../utils/forumDb';
import {
  loadForumNotifications,
  getForumNotificationReadAt,
  markForumNotificationsRead,
  type ForumNotificationItem,
} from '../../utils/forumNotifications';

interface Props {
  activeAccount: db.ForumAccount;
  onOpenPost: (postId: string) => void;
  /** 标成已读之后叫一声，App 外壳好把铃铛上的角标撤掉。 */
  onReadChanged?: () => void;
}

/**
 * [交接5 4.5] 覆盖范围：所有角色的回复都算，不管是TA本人还是路人NPC接的，
 * 只要回复了用户的评论/帖子就算。这里没有专门的通知表，是从评论里现算的派生视图
 * （报告没要求"抄送落库"，只要求"看得到"，现算能满足同样效果）。
 *
 * 推导逻辑搬到了 utils/forumNotifications.ts —— App 外壳算未读角标要用同一套口径，
 * 两边各写一份迟早会对不上。顺带修掉原来"拉全部帖子再逐条数评论"的慢查询。
 *
 * [本轮新增] 已读状态：比上次看过之后新来的通知，左边有一条蓝杠。进来看一眼就算读过，
 * 但这一趟里蓝杠不会当场消失（水位是列表渲染出去之后才写的），不然你还没看清就没了。
 * 已读只给你自己看，TA 那边不知道。
 */
const ForumNotifications: React.FC<Props> = ({ onOpenPost, onReadChanged }) => {
  const [items, setItems] = useState<ForumNotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  /** 进页面那一刻的已读水位。渲染只认它，所以这一趟的蓝杠是稳的。 */
  const [readAtOnEnter, setReadAtOnEnter] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [list, readAt] = await Promise.all([
        loadForumNotifications(),
        getForumNotificationReadAt(),
      ]);
      if (cancelled) return;
      setItems(list);
      setReadAtOnEnter(readAt);
      setLoading(false);

      // 列表已经交给 React 了，这时候再推水位。失败不影响看通知，下次进来重推。
      try {
        await markForumNotificationsRead(list);
        if (!cancelled) onReadChanged?.();
      } catch (e: any) {
        console.warn('[Forum] 通知已读写入失败:', e?.message || String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [onReadChanged]);

  if (loading) return <div className="text-center py-16 text-sm opacity-50">加载中…</div>;
  if (items.length === 0) return <div className="text-center py-16 text-sm opacity-50">还没有人回复你</div>;

  return (
    <div className="pb-8">
      {items.map(item => {
        const unread = item.createdAt > readAtOnEnter;
        return (
          <button
            key={item.id}
            onClick={() => onOpenPost(item.postId)}
            className="w-full text-left px-3 py-3 border-b relative"
            style={{
              borderColor: 'rgba(127,127,127,0.15)',
              background: unread ? 'rgba(59,130,246,0.06)' : undefined,
            }}
          >
            {unread && (
              <span
                className="absolute left-0 top-0 bottom-0 w-[3px]"
                style={{ background: '#3b82f6' }}
              />
            )}
            <div className="text-[13px]">
              <span className="font-semibold">{item.fromAccount?.displayName || '未知账号'}</span>
              <span className="opacity-60">
                {item.isReplyToComment
                  ? ` 回复了你在《${item.postTitle}》里的发言`
                  : ` 评论了你的帖子《${item.postTitle}》`}
              </span>
            </div>
            <div className="text-[13px] opacity-80 mt-0.5">{item.content}</div>
            <div className="text-[11px] opacity-40 mt-1">
              {new Date(item.createdAt).toLocaleString()}
            </div>
          </button>
        );
      })}
    </div>
  );
};

export default ForumNotifications;
