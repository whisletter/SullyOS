import React, { useEffect, useState } from 'react';
import { PencilSimple, SealCheck } from '@phosphor-icons/react';
import * as db from '../../utils/forumDb';
import { isUserSideAccount } from '../../utils/forumFeed';
import ForumPostCard from './ForumPostCard';
import ForumEditProfile from './ForumEditProfile';
import ForumRelationButton from './ForumRelationButton';
import TokenImg from '../../components/os/TokenImg';

interface Props {
  accountId: string;
  /** 当前使用中的身份账号 id —— 关系（好友/拉黑）是挂在身份上的，不是挂在"人"上。 */
  myAccountId: string;
  onOpenPost: (postId: string) => void;
}

// 跟朋友圈封面区（apps/MomentsApp.tsx renderCover）同一套尺寸口径，观感对齐：
// 背景图打底 + 渐变压暗兜底没图的情况 + 头像/昵称压在右下角、往下探出一截。
const COVER_HEIGHT = 200;
const AVATAR_BOTTOM = -22;

/** [交接5 4.7] 个人主页只显示"当前登录使用中的这个账号"发的帖子，不合并用户名下所有账号。
 *  [用户确认新增] 背景图/个签展示 + "编辑资料"入口（仅用户方账号：主号/小号/共管账号）。
 *  [用户确认：改版排版] 头图区照搬朋友圈的封面样式——背景图铺满、头像+昵称压右下角
 *  探出一截，签名/簡介跟在探出区域下面；没有背景图时用深色渐变兜底，白字在哪种情况
 *  下都不会花。 */
const ForumProfile: React.FC<Props> = ({ accountId, myAccountId, onOpenPost }) => {
  const [account, setAccount] = useState<db.ForumAccount | null>(null);
  const [posts, setPosts] = useState<db.ForumPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);

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

  const canEdit = isUserSideAccount(account);
  // 有签名/简介时给探出区多留一点底部空隙，没有就少留——跟朋友圈 renderCover 的
  // marginBottom 逻辑一致，避免博客区顶太紧或空太多。
  const bio = account.bio?.trim();

  return (
    <div className="pb-8">
      {/* 封面区：背景图 + 渐变压暗 + 右下角头像/昵称探出 */}
      <div className="relative w-full shrink-0" style={{ marginBottom: bio ? 34 : Math.abs(AVATAR_BOTTOM) + 14 }}>
        <div className="relative w-full" style={{ height: COVER_HEIGHT }}>
          <div className="absolute inset-0 bg-gradient-to-b from-slate-700 to-slate-900 overflow-hidden">
            {account.banner && <TokenImg value={account.banner} className="w-full h-full object-cover" />}
          </div>
          <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-transparent to-black/10 pointer-events-none" />

          {canEdit && (
            <button
              onClick={() => setEditing(true)}
              className="absolute top-3 right-3 p-2 rounded-full active:scale-90 transition-transform"
              style={{ background: 'rgba(0,0,0,0.35)', color: '#fff' }}
              aria-label="编辑资料"
            >
              <PencilSimple size={16} />
            </button>
          )}
        </div>

        {/* 头像 + 昵称：昵称在头像左边、底部对齐，头像相对封面探出一截 */}
        <div className="absolute right-4 flex items-end gap-3" style={{ bottom: AVATAR_BOTTOM }}>
          <div className="text-right self-center pb-1 max-w-[180px]">
            <div className="text-white font-bold text-[16px] drop-shadow-lg flex items-center justify-end gap-1">
              {account.displayName}
              {account.isVerified && <SealCheck size={15} weight="fill" className="text-sky-400 shrink-0" />}
            </div>
            <div className="text-white/70 text-[11px] drop-shadow truncate">@{account.handle}</div>
          </div>
          <div
            className="shrink-0 overflow-hidden shadow-lg"
            style={{ width: 60, height: 60, borderRadius: 12, border: '2px solid rgba(255,255,255,0.3)' }}
          >
            {account.avatar
              ? <TokenImg value={account.avatar} className="w-full h-full object-cover" />
              : <div className="w-full h-full flex items-center justify-center text-lg font-bold text-white" style={{ background: 'rgba(255,255,255,0.15)' }}>{account.displayName?.[0]}</div>}
          </div>
        </div>

        {/* 简介：贴在头像探出区正下方 */}
        {(bio || account.status === 'deactivated') && (
          <div className="absolute right-4 text-right" style={{ top: COVER_HEIGHT + 26 }}>
            {bio && <div className="text-[12px] opacity-60 max-w-[220px]">{bio}</div>}
            {account.status === 'deactivated' && <div className="text-[11px] opacity-40 mt-0.5">已注销用户</div>}
          </div>
        )}
      </div>

      {account.id !== myAccountId && (
        <div className="flex justify-end px-4 pb-3">
          <ForumRelationButton myAccountId={myAccountId} targetAccountId={account.id} />
        </div>
      )}

      {posts.length === 0 && <div className="text-center py-16 text-sm opacity-50">还没有发过帖子</div>}
      {posts.map(p => (
        <ForumPostCard key={p.id} post={p} author={account} commentCount={0} onClick={() => onOpenPost(p.id)} />
      ))}

      {editing && (
        <ForumEditProfile
          account={account}
          onSaved={updated => { setAccount(updated); setEditing(false); }}
          onClose={() => setEditing(false)}
        />
      )}
    </div>
  );
};

export default ForumProfile;
