import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { BookmarkSimple, ArrowsClockwise, ArrowBendUpLeft, Newspaper, Heart, PencilSimple, TrashSimple } from '@phosphor-icons/react';
import * as db from '../../utils/forumDb';
import * as feed from '../../utils/forumFeed';
import { isUserSideAccount } from '../../utils/forumFeed';
import * as ai from '../../utils/forumAi';
import { FORUM_TOPIC_TAGS, getTopicLabel, type ForumTopicTag } from '../../utils/forumConstants';
import { useOS } from '../../context/OSContext';

interface Props {
  postId: string;
  activeAccount: db.ForumAccount;
  heatLevel: number;
  apiConfig: { baseUrl: string; apiKey: string; model: string };
  /** 删除后调用，父组件负责导航回上一页（比如回主页）。不传就只是留在原地显示"已删除"。 */
  onDeleted?: () => void;
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

const ForumPostDetail: React.FC<Props> = ({ postId, activeAccount, heatLevel, apiConfig, onDeleted }) => {
  const { addToast } = useOS();
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
  const canManage = isUserSideAccount(author);

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

  const handleSubmitComment = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !post) return;
    await feed.appendComment(post.id, {
      authorAccountId: activeAccount.id,
      content: replyTarget ? text : text, // @提及靠正文里的 @handle 字符串，不额外拼接
      createdAt: Date.now(),
      parentCommentId: replyTarget?.id,
    });
    setInputText('');
    setReplyTarget(null);
    await load();
  }, [inputText, post, activeAccount, replyTarget, load]);

  const handleRefresh = useCallback(async () => {
    if (!post) return;
    if (!apiConfig?.baseUrl || !apiConfig?.apiKey || !apiConfig?.model) {
      addToast('请先配置 API', 'info');
      return;
    }
    setRefreshing(true);
    try {
      const allAccounts = await db.getAllForumAccounts();
      // taAccounts：所有角色的论坛账号（主号 + 目前仍在用的小号），@谁就该由谁回复
      // [交接4 二.3.4]。掉马确认流程UI还没做，这里先把"active状态的char账号"都当作
      // "继续沿用"处理，等掉马UI接上后再收窄。
      const taAccounts = allAccounts.filter(a => a.ownerType === 'char' && a.status === 'active');
      await ai.runPostRefresh({
        apiConfig, postId: post.id, heatLevel, taAccounts,
        altIsContinuedInUse: () => true, // 同上，掉马UI接上前的占位判断
      });
      await load();
      addToast('刷新完成', 'success');
    } catch (e: any) {
      addToast(`刷新失败: ${e?.message?.slice(0, 60) || '未知错误'}`, 'error');
    } finally {
      setRefreshing(false);
    }
  }, [post, apiConfig, heatLevel, addToast, load]);

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
          disabled={refreshing}
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
            return (
              <div key={c.id} className={i > 0 ? 'ml-6 mt-1.5' : ''}>
                <div className="text-[13px]">
                  <span className="font-semibold">{commenter?.displayName || '未知账号'}</span>
                  {commenter?.isVerified && <span className="text-blue-400 ml-0.5">✔</span>}
                  <span className="ml-1.5">{c.content}</span>
                </div>
                <button
                  onClick={() => setReplyTarget(c)}
                  className="text-[11px] opacity-40 mt-0.5 flex items-center gap-1"
                >
                  <ArrowBendUpLeft size={11} /> 回复
                </button>
              </div>
            );
          })}
        </div>
      ))}

      {/* 底部评论输入框 */}
      <div className="fixed bottom-0 left-0 right-0 flex items-center gap-2 px-3 py-2 border-t"
           style={{ background: 'inherit', borderColor: 'rgba(127,127,127,0.15)' }}>
        {replyTarget && (
          <button onClick={() => setReplyTarget(null)} className="text-[11px] opacity-50 shrink-0">
            回复中✕
          </button>
        )}
        <input
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleSubmitComment(); }}
          placeholder={replyTarget ? `回复：${replyTarget.content.slice(0, 10)}…` : '说点什么…（@handle 可以精准点名）'}
          className="flex-1 min-w-0 px-3 py-2 rounded-full text-sm outline-none"
          style={{ background: 'rgba(127,127,127,0.12)' }}
        />
        <button onClick={handleSubmitComment} className="text-sm font-bold px-3 shrink-0">发送</button>
      </div>
    </div>
  );
};

export default ForumPostDetail;
