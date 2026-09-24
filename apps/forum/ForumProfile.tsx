import React, { useCallback, useEffect, useState } from 'react';
import { PencilSimple, SealCheck, ArrowsClockwise } from '@phosphor-icons/react';
import * as db from '../../utils/forumDb';
import { isUserSideAccount } from '../../utils/forumFeed';
import ForumPostCard from './ForumPostCard';
import ForumEditProfile from './ForumEditProfile';
import ForumRelationButton from './ForumRelationButton';
import * as ai from '../../utils/forumAi';
import { useOS } from '../../context/OSContext';
import TokenImg from '../../components/os/TokenImg';

interface Props {
  accountId: string;
  /** 论坛实际使用的 API（可能是论坛专用那套）。批量配评论要用。 */
  apiConfig?: { baseUrl: string; apiKey: string; model: string };
  /** 当前使用中的身份账号 id —— 关系（好友/拉黑）是挂在身份上的，不是挂在"人"上。 */
  myAccountId: string;
  onOpenPost: (postId: string) => void;
  /** 当前身份是已注销的号：只能看，不能改资料、不能加好友/拉黑。 */
  readOnly?: boolean;
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
const ForumProfile: React.FC<Props> = ({ accountId, myAccountId, onOpenPost, readOnly, apiConfig }) => {
  const { addToast } = useOS();
  const [account, setAccount] = useState<db.ForumAccount | null>(null);
  const [posts, setPosts] = useState<db.ForumPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [commentCounts, setCommentCounts] = useState<Map<string, number>>(new Map());
  /** 你自己的号才有"评论"这一栏：你用这个号在各处留过的评论。 */
  const [tab, setTab] = useState<'posts' | 'comments'>('posts');
  const [myComments, setMyComments] = useState<db.ForumComment[]>([]);
  const [commentPosts, setCommentPosts] = useState<Map<string, db.ForumPost>>(new Map());
  const [commentsLoaded, setCommentsLoaded] = useState(false);
  const [batchCommenting, setBatchCommenting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setTab('posts');
      setCommentsLoaded(false);
      const [acc, myPosts] = await Promise.all([db.getForumAccount(accountId), db.getForumPostsByAuthor(accountId)]);
      if (cancelled) return;
      setAccount(acc);
      setPosts(myPosts);
      setLoading(false);
      // 评论数：一次事务批量数，不再写死 0
      const counts = await db.getCommentCountsByPosts(myPosts.map(p => p.id));
      if (!cancelled) setCommentCounts(counts);
    })();
    return () => { cancelled = true; };
  }, [accountId]);

  // 切到"评论"栏才去读，不看就不查
  useEffect(() => {
    if (tab !== 'comments' || commentsLoaded) return;
    let cancelled = false;
    (async () => {
      const comments = await db.getCommentsByAuthor(accountId);
      const postMap = await db.getForumPostsByIds(comments.map(c => c.postId));
      if (cancelled) return;
      setMyComments(comments);
      setCommentPosts(postMap);
      setCommentsLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [tab, commentsLoaded, accountId]);

  // ⚠️ 这个 useCallback 必须待在下面两个提前 return 的**前面**。
  // React 要求每次渲染调用的 hook 数量一致；放在 return 后面的话，loading 那一帧
  // 少一个 hook、加载完又多一个，就会抛 "Rendered more hooks than during the
  // previous render"（生产环境显示为 Minified React error #310）。
  /**
   * 一次性给这个号名下「还没有评论」的帖子配上评论（最多 3 条，每条 3-5 句）。
   * 跟帖子详情页那个刷新是两件事：那个是"我在看这条，让它热闹起来"，
   * 这个是"我一口气发了好几条，先都有点动静"。只有路人来评论，不拉 TA 参与——
   * TA 一开口帖子就永久保留了，不该由一个批量按钮顺手决定。
   */
  const handleBatchComments = useCallback(async () => {
    if (batchCommenting) return;
    if (!apiConfig?.baseUrl || !apiConfig?.apiKey || !apiConfig?.model) {
      addToast('请先配置 API', 'info');
      return;
    }
    setBatchCommenting(true);
    try {
      const result = await ai.runProfileBatchComments({ apiConfig, accountId });
      if (result.nothingToDo) {
        addToast('没有等着配评论的帖子了', 'info');
        return;
      }
      addToast(`${result.posts} 条帖子下面新增了 ${result.comments} 条评论`, 'success');
      // 评论数是单独查的，重新拉一遍才会更新
      const myPosts = await db.getForumPostsByAuthor(accountId);
      setPosts(myPosts);
      setCommentCounts(await db.getCommentCountsByPosts(myPosts.map(p => p.id)));
    } catch (e: any) {
      addToast(`生成失败: ${e?.message?.slice(0, 60) || '未知错误'}`, 'error');
    } finally {
      setBatchCommenting(false);
    }
  }, [batchCommenting, apiConfig, accountId, addToast]);

  if (loading) return <div className="text-center py-16 text-sm opacity-50">加载中…</div>;
  if (!account) return <div className="text-center py-16 text-sm opacity-50">账号不存在</div>;

  const canEdit = isUserSideAccount(account) && !readOnly && account.status === 'active';
  /** 只有你自己的号才给这个按钮——给路人的帖子批量配评论没有意义。 */
  const canBatchComment = isUserSideAccount(account) && !readOnly && account.status === 'active';
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

          <div className="absolute top-3 right-3 flex items-center gap-2">
            {/* 批量配评论：一次给还没人回的几条帖子都配上评论 */}
            {canBatchComment && (
              <button
                onClick={handleBatchComments}
                disabled={batchCommenting}
                className="p-2 rounded-full active:scale-90 transition-transform disabled:opacity-50"
                style={{ background: 'rgba(0,0,0,0.35)', color: '#fff' }}
                aria-label="给还没人回的帖子批量配评论"
              >
                <ArrowsClockwise size={16} className={batchCommenting ? 'animate-spin' : ''} />
              </button>
            )}
            {canEdit && (
              <button
                onClick={() => setEditing(true)}
                className="p-2 rounded-full active:scale-90 transition-transform"
                style={{ background: 'rgba(0,0,0,0.35)', color: '#fff' }}
                aria-label="编辑资料"
              >
                <PencilSimple size={16} />
              </button>
            )}
          </div>
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

      {account.id !== myAccountId && !readOnly && (
        <div className="flex justify-end px-4 pb-3">
          <ForumRelationButton myAccountId={myAccountId} targetAccountId={account.id} />
        </div>
      )}

      {isUserSideAccount(account) && (
        <div className="flex gap-1 px-4 pb-2">
          {([['posts', '帖子'], ['comments', '评论']] as const).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className="text-[13px] px-3 py-1 rounded-full"
              style={{
                background: tab === key ? 'rgba(59,130,246,0.15)' : 'transparent',
                color: tab === key ? '#3b82f6' : undefined,
                fontWeight: tab === key ? 700 : 400,
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {tab === 'posts' && (
        <>
          {posts.length === 0 && <div className="text-center py-16 text-sm opacity-50">还没有发过帖子</div>}
          {posts.map(p => (
            <ForumPostCard key={p.id} post={p} author={account} commentCount={commentCounts.get(p.id) || 0} onClick={() => onOpenPost(p.id)} />
          ))}
        </>
      )}

      {tab === 'comments' && (
        <>
          {!commentsLoaded && <div className="text-center py-16 text-sm opacity-50">加载中…</div>}
          {commentsLoaded && myComments.length === 0 && (
            <div className="text-center py-16 text-sm opacity-50">这个号还没评论过</div>
          )}
          {commentsLoaded && myComments.map(c => {
            const parent = commentPosts.get(c.postId);
            return (
              <button
                key={c.id}
                onClick={() => { if (parent) onOpenPost(parent.id); }}
                disabled={!parent}
                className="w-full text-left px-4 py-3 border-b"
                style={{ borderColor: 'rgba(127,127,127,0.1)' }}
              >
                <div className="text-[14px] whitespace-pre-wrap leading-relaxed">{c.content}</div>
                <div className="text-[12px] opacity-50 mt-1 truncate">
                  {parent
                    ? <>评论于《{parent.title || parent.content.slice(0, 20)}》</>
                    : '原帖已经被清理了'}
                  <span className="ml-2">{new Date(c.createdAt).toLocaleDateString()}</span>
                </div>
              </button>
            );
          })}
        </>
      )}

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
