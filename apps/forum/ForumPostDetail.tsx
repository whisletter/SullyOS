import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { BookmarkSimple, ArrowsClockwise, ArrowBendUpLeft, Newspaper, Heart, PencilSimple, TrashSimple } from '@phosphor-icons/react';
import * as db from '../../utils/forumDb';
import * as feed from '../../utils/forumFeed';
import { isUserSideAccount } from '../../utils/forumFeed';
import * as ai from '../../utils/forumAi';
import { buildAltContinuedLookup } from '../../utils/forumSuspicion';
import { FORUM_TOPIC_TAGS, getTopicLabel, type ForumTopicTag } from '../../utils/forumConstants';
import TokenImg from '../../components/os/TokenImg';
import ForumMusicCard from './ForumMusicCard';
import ForumArticleCard from './ForumArticleCard';
import ForumMentionSuggest from './ForumMentionSuggest';
import { useOS } from '../../context/OSContext';
import { DB } from '../../utils/db';
import { AppID } from '../../types';

interface Props {
  postId: string;
  activeAccount: db.ForumAccount;
  heatLevel: number;
  apiConfig: { baseUrl: string; apiKey: string; model: string };
  /** 删除后调用，父组件负责导航回上一页（比如回主页）。不传就只是留在原地显示"已删除"。 */
  onDeleted?: () => void;
  /** 当前身份是已注销的号：全站只读。编辑/删除/发评论/刷新一律关掉。 */
  readOnly?: boolean;
}

/** 评论树里的一层，只按"楼"分组、楼内按时间线性展开（楼中楼这里不做多级缩进，
 *  跟朋友圈评论展示的简单层级一致）[交接5 4.11 "直接复用朋友圈现成评论展示组件，不额外定制"，
 *  这里精神上照抄那份简洁度，组件本身是新写的]。 */
function groupByFloor(comments: db.ForumComment[]): { rootId: string; items: db.ForumComment[] }[] {
  const byRoot = new Map<string, db.ForumComment[]>();
  for (const c of comments) {
    const list = byRoot.get(c.threadRootId) || [];
    list.push(c);
    byRoot.set(c.threadRootId, list);
  }
  return Array.from(byRoot.entries())
    .map(([rootId, items]) => ({ rootId, items: items.sort((a, b) => a.createdAt - b.createdAt) }))
    .sort((a, b) => a.items[0].createdAt - b.items[0].createdAt);
}

const ForumPostDetail: React.FC<Props> = ({ postId, activeAccount, heatLevel, apiConfig, onDeleted, readOnly }) => {
  const { addToast, characters, closeApp, openApp } = useOS();
  const [post, setPost] = useState<db.ForumPost | null>(null);
  const [comments, setComments] = useState<db.ForumComment[]>([]);
  const [accountsById, setAccountsById] = useState<Map<string, db.ForumAccount>>(new Map());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [replyTarget, setReplyTarget] = useState<db.ForumComment | null>(null);
  const [inputText, setInputText] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editTopicTag, setEditTopicTag] = useState<ForumTopicTag>('daily_chatter');
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  /** 正在确认删除的那条评论 id。null = 没在确认。 */
  const [confirmingDeleteComment, setConfirmingDeleteComment] = useState<string | null>(null);
  /** 点开看大图时，当前看的是第几张。null = 没在看。 */
  const [viewingImageIndex, setViewingImageIndex] = useState<number | null>(null);
  /** 多个角色时，先让你选分享给谁。 */
  const [pickingShareTarget, setPickingShareTarget] = useState(false);
  const [deletingComment, setDeletingComment] = useState(false);

  const load = useCallback(async () => {
    const [p, c, accounts] = await Promise.all([
      db.getForumPost(postId), db.getCommentsByPost(postId), db.getAllForumAccounts(),
    ]);
    setPost(p);
    setComments(c);
    setAccountsById(new Map(accounts.map(a => [a.id, a])));
    setLoading(false);
  }, [postId]);

  useEffect(() => { load(); }, [load]);

  const floors = useMemo(() => groupByFloor(comments), [comments]);

  const toggleCollect = useCallback(async () => {
    if (!post) return;
    const updated = { ...post, isCollected: !post.isCollected };
    await db.saveForumPost(updated);
    setPost(updated);
  }, [post]);

  // [用户确认新增] 点赞：跟收藏是两件事，不影响三天水线保留判定。
  const toggleLike = useCallback(async () => {
    if (!post) return;
    const updated = await feed.toggleLike(post.id, activeAccount.id);
    if (updated) setPost(updated);
  }, [post, activeAccount.id]);

  const author = post ? accountsById.get(post.authorAccountId) : undefined;
  // [用户确认新增] 编辑/删除只对"用户方账号发的帖子"开放（主号/小号/共管账号），
  // 不要求必须是当前激活身份——切换回主号也该能管自己小号发过的旧帖。
  // readOnly（当前登录的是已注销的小号）时一律关掉，原来这里漏接了，
  // 切到注销号照样能编辑/删除帖子。
  const canManage = isUserSideAccount(author) && !readOnly;

  const startEdit = useCallback(() => {
    if (!post) return;
    setEditTitle(post.title);
    setEditContent(post.content);
    setEditTopicTag(post.topicTag as ForumTopicTag);
    setIsEditing(true);
  }, [post]);

  const saveEdit = useCallback(async () => {
    if (!post) return;
    const updated = await feed.editPost(post.id, { title: editTitle, content: editContent, topicTag: editTopicTag });
    if (updated) setPost(updated);
    setIsEditing(false);
  }, [post, editTitle, editContent, editTopicTag]);

  const handleDelete = useCallback(async () => {
    if (!post) return;
    await feed.deletePostWithComments(post.id);
    setConfirmingDelete(false);
    if (onDeleted) onDeleted();
  }, [post, onDeleted]);

  /** 这一下会删掉几条（含楼中楼）。确认文案要用，所以先算出来。 */
  const commentDeleteCount = useCallback((commentId: string) => (
    feed.collectCommentSubtreeIds(comments, commentId).length
  ), [comments]);

  const handleDeleteComment = useCallback(async (commentId: string) => {
    if (!post) return;
    setDeletingComment(true);
    try {
      const { deleted } = await feed.deleteCommentCascade(post.id, commentId);
      addToast(deleted > 1 ? `已删除 ${deleted} 条` : '已删除', 'success');
      await load();
    } catch (e: any) {
      addToast(`删除失败: ${e?.message?.slice(0, 60) || '未知错误'}`, 'error');
    } finally {
      setDeletingComment(false);
      setConfirmingDeleteComment(null);
    }
  }, [post, load, addToast]);

  /**
   * 把这条音乐帖分享到跟某个角色的聊天里，落成一条可播放的 music_card 消息。
   * 格式跟朋友圈的"转发到聊天框"完全一致（intent: 'shared' + metadata.song），
   * 这样聊天那边现成的音乐卡渲染和播放逻辑直接就能用，不用另写一套。
   */
  const shareMusicToChat = useCallback(async (charId: string) => {
    if (!post?.music) return;
    if (!post.music.songId) {
      addToast('这首歌没有可播放的信息，没法分享', 'error');
      return;
    }
    try {
      await DB.saveMessage({
        charId,
        role: 'user',
        type: 'music_card' as any,
        content: '[分享音乐]',
        metadata: {
          intent: 'shared',
          song: {
            songId: post.music.songId,
            name: post.music.songName,
            artists: post.music.artists,
            albumPic: post.music.albumPic,
          },
        } as any,
      });
      setPickingShareTarget(false);
      addToast('已分享到聊天框（点击跳转）', 'success', () => {
        closeApp();
        openApp(AppID.Chat);
      });
    } catch (e: any) {
      addToast(`分享失败: ${e?.message?.slice(0, 60) || '未知错误'}`, 'error');
    }
  }, [post, addToast, closeApp, openApp]);

  /** 只有一个角色就别多问一步，直接分享。 */
  const handleShareMusic = useCallback(() => {
    const list = (characters || []).filter(c => c.id);
    if (list.length === 0) { addToast('还没有角色可以分享', 'info'); return; }
    if (list.length === 1) { void shareMusicToChat(list[0].id); return; }
    setPickingShareTarget(true);
  }, [characters, shareMusicToChat, addToast]);

  const handleSubmitComment = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !post || readOnly) return;
    await feed.appendComment(post.id, {
      authorAccountId: activeAccount.id,
      content: replyTarget ? text : text, // @提及靠正文里的 @handle 字符串，不额外拼接
      createdAt: Date.now(),
      parentCommentId: replyTarget?.id,
    });
    setInputText('');
    setReplyTarget(null);
    await load();
  }, [inputText, post, activeAccount, replyTarget, load, readOnly]);

  const handleRefresh = useCallback(async () => {
    if (!post || readOnly) return;
    if (!apiConfig?.baseUrl || !apiConfig?.apiKey || !apiConfig?.model) {
      addToast('请先配置 API', 'info');
      return;
    }
    setRefreshing(true);
    try {
      const allAccounts = await db.getAllForumAccounts();
      // taAccounts：所有角色的论坛账号（主号 + 小号）。用不用、用哪个由 TA 自己判断，
      // 只有"@了TA的楼"是必回的。
      const taAccounts = allAccounts.filter(a => a.ownerType === 'char' && a.status === 'active');
      // 掉马机制已接上：小号只有在"被你认出来、且它选择继续用"之后，它的回复才算
      // 角色本人互动过、才触发帖子永久保留。没掉马的小号照旧不算，帖子受三天水线约束。
      const continuedAlts = await buildAltContinuedLookup(
        taAccounts.filter(a => a.isAlt).map(a => a.id)
      );
      await ai.runPostRefresh({
        apiConfig, postId: post.id, heatLevel, taAccounts,
        altIsContinuedInUse: (accountId: string) => continuedAlts.has(accountId),
      });
      await load();
      addToast('刷新完成', 'success');
    } catch (e: any) {
      addToast(`刷新失败: ${e?.message?.slice(0, 60) || '未知错误'}`, 'error');
    } finally {
      setRefreshing(false);
    }
  }, [post, apiConfig, heatLevel, addToast, load, readOnly]);

  if (loading) return <div className="text-center py-16 text-sm opacity-50">加载中…</div>;
  if (!post) return <div className="text-center py-16 text-sm opacity-50">这条帖子不见了</div>;

  return (
    <div className="pb-24">
      {/* 帖子正文 */}
      <div className="px-3 py-3 border-b" style={{ borderColor: 'rgba(127,127,127,0.15)' }}>
        <div className="flex items-center gap-2 text-[13px] opacity-70">
          <span className="font-semibold opacity-100">{author?.displayName || '未知账号'}</span>
          {author?.isVerified && <span className="text-blue-400">✔</span>}
          <span>· {getTopicLabel(post.topicTag as ForumTopicTag)}</span>
          {post.postKind === 'news' && (
            <span className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full"
                  style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>
              <Newspaper size={10} weight="fill" /> News
            </span>
          )}
          <div className="ml-auto flex items-center gap-1">
            {canManage && !isEditing && (
              <>
                <button onClick={startEdit} className="p-1"><PencilSimple size={16} /></button>
                <button onClick={() => setConfirmingDelete(true)} className="p-1"><TrashSimple size={16} /></button>
              </>
            )}
            <button onClick={toggleCollect} className="p-1">
              <BookmarkSimple size={18} weight={post.isCollected ? 'fill' : 'regular'} />
            </button>
          </div>
        </div>

        {isEditing ? (
          <div className="mt-2 space-y-2">
            <select value={editTopicTag} onChange={e => setEditTopicTag(e.target.value as ForumTopicTag)} className="w-full px-2 py-1.5 rounded-lg text-sm" style={{ background: 'rgba(127,127,127,0.1)' }}>
              {FORUM_TOPIC_TAGS.map(t => <option key={t.tag} value={t.tag}>{t.label}</option>)}
            </select>
            <input value={editTitle} onChange={e => setEditTitle(e.target.value)} placeholder="标题" className="w-full px-2 py-1.5 rounded-lg text-sm outline-none" style={{ background: 'rgba(127,127,127,0.1)' }} />
            <textarea value={editContent} onChange={e => setEditContent(e.target.value)} rows={5} className="w-full px-2 py-1.5 rounded-lg text-sm outline-none resize-none" style={{ background: 'rgba(127,127,127,0.1)' }} />
            <div className="flex gap-2">
              <button onClick={saveEdit} className="text-sm px-3 py-1.5 rounded-full font-bold" style={{ background: '#3b82f6', color: '#fff' }}>保存</button>
              <button onClick={() => setIsEditing(false)} className="text-sm px-3 py-1.5 rounded-full" style={{ background: 'rgba(127,127,127,0.15)' }}>取消</button>
            </div>
          </div>
        ) : (
          <>
            {post.title && <div className="font-bold text-[17px] mt-2">{post.title}</div>}
            <div className="text-[14px] mt-1.5 whitespace-pre-wrap leading-relaxed">{post.content}</div>
            {/* 配图：一张时铺开，多张走九宫格，跟朋友圈一个观感 */}
            {post.images && post.images.length > 0 && (
              <div className={post.images.length === 1 ? 'mt-2' : 'mt-2 grid grid-cols-3 gap-1.5'}>
                {post.images.map((img, i) => (
                  <button
                    key={`${img}-${i}`}
                    onClick={() => setViewingImageIndex(i)}
                    className={`overflow-hidden rounded-xl block active:scale-[0.98] transition-transform ${post.images!.length === 1 ? 'max-w-[70%]' : 'aspect-square w-full'}`}
                    style={{ background: 'rgba(127,127,127,0.12)' }}
                  >
                    <TokenImg
                      value={img}
                      className={post.images!.length === 1 ? 'w-full h-auto object-contain' : 'w-full h-full object-cover'}
                    />
                  </button>
                ))}
              </div>
            )}
            {/* 音乐卡：点了跳去音乐 App 播放。文章卡：点了在新标签页开原文。 */}
            {post.music && (
              <>
                <ForumMusicCard music={post.music} playable />
                {!readOnly && (
                  <button
                    onClick={handleShareMusic}
                    className="mt-1.5 text-[12px] px-3 py-1.5 rounded-full"
                    style={{ background: 'rgba(59,130,246,0.14)', color: '#3b82f6' }}
                  >
                    分享给 TA
                  </button>
                )}
                {pickingShareTarget && (
                  <div className="mt-1.5 p-2 rounded-lg space-y-1.5" style={{ background: 'rgba(127,127,127,0.1)' }}>
                    <div className="text-[12px] opacity-60">分享给谁？</div>
                    {(characters || []).filter(c => c.id).map(c => (
                      <button
                        key={c.id}
                        onClick={() => shareMusicToChat(c.id)}
                        className="w-full text-left px-3 py-2 rounded-lg text-sm"
                        style={{ background: 'rgba(127,127,127,0.12)' }}
                      >
                        {c.name}
                      </button>
                    ))}
                    <button onClick={() => setPickingShareTarget(false)} className="text-[12px] opacity-50">取消</button>
                  </div>
                )}
              </>
            )}
            {post.article && <ForumArticleCard article={post.article} openable />}
            {post.postKind === 'news' && post.sourceNewsUrl && (
              <a href={post.sourceNewsUrl} target="_blank" rel="noreferrer" className="text-[12px] opacity-50 mt-1.5 block underline">
                原文：{post.sourceNewsTitle || post.sourceNewsUrl}
              </a>
            )}
          </>
        )}

        {confirmingDelete && (
          <div className="mt-2 text-sm space-y-2 p-2 rounded-lg" style={{ background: 'rgba(239,68,68,0.1)' }}>
            <div>确定删除这条帖子吗？评论会一起删掉，不能撤销。</div>
            <div className="flex gap-2">
              <button onClick={handleDelete} className="px-3 py-1.5 rounded-full text-xs" style={{ background: '#ef4444', color: '#fff' }}>确定删除</button>
              <button onClick={() => setConfirmingDelete(false)} className="px-3 py-1.5 rounded-full text-xs" style={{ background: 'rgba(127,127,127,0.15)' }}>取消</button>
            </div>
          </div>
        )}

        {/* [用户确认新增] 点赞：跟收藏分开显示，不影响保留判定 */}
        <button onClick={toggleLike} className="flex items-center gap-1 mt-2 text-[13px]">
          <Heart size={16} weight={post.likes.includes(activeAccount.id) ? 'fill' : 'regular'} color={post.likes.includes(activeAccount.id) ? '#ef4444' : undefined} />
          <span className="opacity-60">{post.likes.length || ''}</span>
        </button>
      </div>

      {/* 评论区头部 + 刷新按钮 [交接4 二.3.1] */}
      <div className="flex items-center px-3 py-2 border-b" style={{ borderColor: 'rgba(127,127,127,0.15)' }}>
        <span className="text-[13px] font-bold opacity-60">评论 {comments.length}</span>
        <button
          onClick={handleRefresh}
          disabled={refreshing || readOnly}
          className="ml-auto p-1.5 rounded-full active:scale-90 transition-transform disabled:opacity-40"
        >
          <ArrowsClockwise size={18} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* 评论楼列表 */}
      {floors.length === 0 && <div className="text-center py-10 text-sm opacity-40">还没有评论</div>}
      {floors.map(floor => (
        <div key={floor.rootId} className="px-3 py-2.5 border-b" style={{ borderColor: 'rgba(127,127,127,0.08)' }}>
          {floor.items.map((c, i) => {
            const commenter = accountsById.get(c.authorAccountId);
            const isMine = isUserSideAccount(commenter);
            const willDelete = confirmingDeleteComment === c.id ? commentDeleteCount(c.id) : 0;
            return (
              <div key={c.id} className={i > 0 ? 'ml-6 mt-1.5' : ''}>
                <div className="text-[13px]">
                  <span className="font-semibold">{commenter?.displayName || '未知账号'}</span>
                  {commenter?.isVerified && <span className="text-blue-400 ml-0.5">✔</span>}
                  <span className="ml-1.5">{c.content}</span>
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  <button
                    onClick={() => setReplyTarget(c)}
                    disabled={readOnly}
                    className="text-[11px] opacity-40 flex items-center gap-1 disabled:opacity-20"
                  >
                    <ArrowBendUpLeft size={11} /> 回复
                  </button>
                  {/* 谁的评论都能删 [用户确认]——路人的、TA 的都行。这是你自己的 App。
                      只读身份（已注销的小号）下整排都收起来。 */}
                  {!readOnly && (
                    <button
                      onClick={() => setConfirmingDeleteComment(c.id)}
                      className="text-[11px] opacity-40 flex items-center gap-1"
                    >
                      <TrashSimple size={11} /> 删除
                    </button>
                  )}
                </div>

                {confirmingDeleteComment === c.id && (
                  <div className="mt-1.5 text-[12px] space-y-1.5 p-2 rounded-lg" style={{ background: 'rgba(239,68,68,0.1)' }}>
                    <div>
                      {isMine ? '删掉你这条评论？' : `删掉 ${commenter?.displayName || '这个账号'} 的这条评论？`}
                      {willDelete > 1 && `底下的 ${willDelete - 1} 条回复会一起删掉。`}
                      不能撤销。
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleDeleteComment(c.id)}
                        disabled={deletingComment}
                        className="px-3 py-1 rounded-full text-[11px] disabled:opacity-40"
                        style={{ background: '#ef4444', color: '#fff' }}
                      >
                        {deletingComment ? '删除中…' : '确定删除'}
                      </button>
                      <button
                        onClick={() => setConfirmingDeleteComment(null)}
                        className="px-3 py-1 rounded-full text-[11px]"
                        style={{ background: 'rgba(127,127,127,0.15)' }}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {/* 底部评论输入框 */}
      {/* 背景原来写的是 inherit，父级透明所以它也透明，帖子内容会从字底下透上来。
          改成根节点挂的主题变量，拿到当前深浅色的实色。
          再补一层安全区内边距，免得在手势条机型上被系统条压住。 */}
      <div className="fixed bottom-0 left-0 right-0 z-40 flex items-center gap-2 px-3 pt-2 border-t"
           style={{
             background: 'var(--forum-bg, #1A1A1E)',
             borderColor: 'rgba(127,127,127,0.15)',
             paddingBottom: 'calc(var(--safe-bottom, 0px) + 8px)',
           }}>
        {replyTarget && (
          <button onClick={() => setReplyTarget(null)} className="text-[11px] opacity-50 shrink-0">
            回复中✕
          </button>
        )}
        {/* @ 补全浮在输入框上方。以前要你自己记住对方的 handle（moss_club 这种），
            界面又不显示，所以 @ 基本没人用对过。 */}
        <div className="flex-1 min-w-0 relative">
          <ForumMentionSuggest
            value={inputText}
            onChange={setInputText}
            priorityAccountIds={floors.flatMap(f => f.items.map(c => c.authorAccountId))}
            excludeAccountIds={[activeAccount.id]}
          />
          <input
            value={inputText}
            onChange={e => setInputText(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSubmitComment(); }}
            disabled={readOnly}
            placeholder={readOnly
              ? '这个号已注销，只能看不能发'
              : replyTarget ? `回复：${replyTarget.content.slice(0, 10)}…` : '说点什么…（打 @ 可以点名）'}
            className="w-full px-3 py-2 rounded-full text-sm outline-none disabled:opacity-50"
            style={{ background: 'rgba(127,127,127,0.12)' }}
          />
        </div>
        <button onClick={handleSubmitComment} disabled={readOnly} className="text-sm font-bold px-3 shrink-0 disabled:opacity-30">发送</button>
      </div>

      {/* 看大图：点配图打开，点任意处关闭；多张时左右可以翻。
          用的还是 TokenImg，令牌解析和 objectURL 回收都由它自己管，这里不碰 blob。 */}
      {viewingImageIndex !== null && post.images && post.images[viewingImageIndex] && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.92)' }}
          onClick={() => setViewingImageIndex(null)}
        >
          <TokenImg
            value={post.images[viewingImageIndex]}
            className="max-w-full max-h-full object-contain"
            style={{ maxHeight: 'calc(100vh - var(--safe-top, 0px) - var(--safe-bottom, 0px) - 80px)' }}
          />

          {post.images.length > 1 && (
            <>
              <button
                onClick={e => {
                  e.stopPropagation();
                  setViewingImageIndex(i => ((i ?? 0) - 1 + post.images!.length) % post.images!.length);
                }}
                className="absolute left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full text-white text-xl"
                style={{ background: 'rgba(255,255,255,0.12)' }}
                aria-label="上一张"
              >
                ‹
              </button>
              <button
                onClick={e => {
                  e.stopPropagation();
                  setViewingImageIndex(i => ((i ?? 0) + 1) % post.images!.length);
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full text-white text-xl"
                style={{ background: 'rgba(255,255,255,0.12)' }}
                aria-label="下一张"
              >
                ›
              </button>
              <div
                className="absolute left-0 right-0 text-center text-white/70 text-[12px]"
                style={{ bottom: 'calc(var(--safe-bottom, 0px) + 16px)' }}
              >
                {viewingImageIndex + 1} / {post.images.length}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default ForumPostDetail;
