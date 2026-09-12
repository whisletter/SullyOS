/**
 * 朋友圈 App
 *
 * 视图结构：
 *   main     — 混合时间线（我 + TA），顶部是我的封面
 *   taPage   — TA 的朋友圈子页面（只看 TA 发的，保留互动）
 *   compose  — 发布面板（发图/发文/发图文/分享音乐/分享文章）
 *   settings — 朋友圈设置（发布频率、异步互动等）
 */

import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from 'react';
import {
  CaretLeft,
  Camera,
  ArrowsClockwise,
  Heart,
  ChatCircle,
  ShareNetwork,
  DotsThree,
  ImageSquare,
  TextAa,
  MusicNote,
  Article,
  Trash,
  PushPin,
  Gear,
  PaperPlaneTilt,
  X,
  Plus,
  Image as ImageIcon,
} from '@phosphor-icons/react';
import { useOS } from '../context/OSContext';
import TokenImg from '../components/os/TokenImg';
import type { CharacterProfile } from '../types';
import {
  MomentPost,
  MomentComment,
  MomentSettings,
  MomentMusicCard,
  MomentArticleCard,
  MomentPostType,
  DEFAULT_MOMENT_SETTINGS,
  getPostsByCharId,
  savePost,
  deletePost,
  getMomentSettings,
  saveMomentSettings,
  createPostId,
  createCommentId,
} from '../utils/momentsDb';

// ==================== 样式常量 ====================

const COVER_HEIGHT = 280;
const AVATAR_SIZE = 64;

// ==================== 主组件 ====================

type View = 'main' | 'taPage' | 'compose' | 'settings';
type ComposeType = MomentPostType | null;

const MomentsApp: React.FC = () => {
  const {
    characters,
    activeCharacterId,
    userProfile,
    addToast,
    closeApp,
    theme: osTheme,
  } = useOS();

  const char = characters.find(c => c.id === activeCharacterId) || null;
  const charId = activeCharacterId || '';
  const charName = char?.name || 'TA';
  const charAvatar = char?.avatar || '';

  // ---- 视图状态 ----
  const [view, setView] = useState<View>('main');
  const [composeType, setComposeType] = useState<ComposeType>(null);
  const [showComposeMenu, setShowComposeMenu] = useState(false);

  // ---- 数据 ----
  const [posts, setPosts] = useState<MomentPost[]>([]);
  const [settings, setSettings] = useState<MomentSettings | null>(null);
  const [loading, setLoading] = useState(true);

  // ---- 互动状态 ----
  const [activeCommentPostId, setActiveCommentPostId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [replyTarget, setReplyTarget] = useState<{ id: string; name: string } | null>(null);
  const [menuPostId, setMenuPostId] = useState<string | null>(null);

  // ---- 发布状态 ----
  const [composeText, setComposeText] = useState('');
  const [composeImages, setComposeImages] = useState<string[]>([]);
  const [composeMusicName, setComposeMusicName] = useState('');
  const [composeMusicArtist, setComposeMusicArtist] = useState('');
  const [composeMusicCover, setComposeMusicCover] = useState('');
  const [composeArticleTitle, setComposeArticleTitle] = useState('');
  const [composeArticleUrl, setComposeArticleUrl] = useState('');
  const [composeArticleBody, setComposeArticleBody] = useState('');

  // ---- 编辑状态 ----
  const [editingField, setEditingField] = useState<{ postId: string; commentId?: string } | null>(null);
  const [editText, setEditText] = useState('');

  const commentInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ==================== 数据加载 ====================

  const loadData = useCallback(async () => {
    if (!charId) return;
    setLoading(true);
    try {
      const [p, s] = await Promise.all([
        getPostsByCharId(charId),
        getMomentSettings(charId),
      ]);
      setPosts(p);
      setSettings(s);
    } catch (e) {
      console.error('[Moments] loadData failed', e);
    } finally {
      setLoading(false);
    }
  }, [charId]);

  useEffect(() => { loadData(); }, [loadData]);

  // ==================== 发布逻辑 ====================

  const handlePublish = useCallback(async () => {
    if (!charId || !composeType) return;

    const post: MomentPost = {
      id: createPostId(),
      charId,
      author: 'user',
      authorName: userProfile.name || '我',
      authorAvatar: userProfile.perCharAvatars?.[charId] || userProfile.avatar,
      type: composeType,
      text: composeText.trim() || undefined,
      images: composeImages.length > 0 ? composeImages : undefined,
      music: composeType === 'music' ? {
        songName: composeMusicName,
        artists: composeMusicArtist,
        albumPic: composeMusicCover,
      } : undefined,
      article: composeType === 'article' ? {
        title: composeArticleTitle,
        url: composeArticleUrl || undefined,
        body: composeArticleBody || undefined,
      } : undefined,
      likes: [],
      likeNames: [],
      comments: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await savePost(post);
    setPosts(prev => [post, ...prev]);

    // 重置
    setComposeText('');
    setComposeImages([]);
    setComposeMusicName('');
    setComposeMusicArtist('');
    setComposeMusicCover('');
    setComposeArticleTitle('');
    setComposeArticleUrl('');
    setComposeArticleBody('');
    setComposeType(null);
    setView('main');
    addToast('已发布', 'success');
  }, [charId, composeType, composeText, composeImages, composeMusicName, composeMusicArtist, composeMusicCover, composeArticleTitle, composeArticleUrl, composeArticleBody, userProfile, addToast]);

  // ==================== 图片上传 ====================

  const handleImageUpload = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      const results: string[] = [];
      for (const file of files.slice(0, 9)) {
        const reader = new FileReader();
        const dataUrl = await new Promise<string>((res) => {
          reader.onload = () => res(reader.result as string);
          reader.readAsDataURL(file);
        });
        results.push(dataUrl);
      }
      setComposeImages(prev => [...prev, ...results].slice(0, 9));
    };
    input.click();
  }, []);

  // ==================== 封面上传 ====================

  const handleCoverUpload = useCallback((target: 'user' | 'ta') => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file || !settings) return;
      const reader = new FileReader();
      const dataUrl = await new Promise<string>((res) => {
        reader.onload = () => res(reader.result as string);
        reader.readAsDataURL(file);
      });
      const updated = {
        ...settings,
        ...(target === 'user' ? { userCoverImage: dataUrl } : { taCoverImage: dataUrl }),
      };
      await saveMomentSettings(updated);
      setSettings(updated);
      addToast('封面已更新', 'success');
    };
    input.click();
  }, [settings, addToast]);

  // ==================== 互动逻辑 ====================

  const toggleLike = useCallback(async (postId: string) => {
    const post = posts.find(p => p.id === postId);
    if (!post) return;

    const isLiked = post.likes.includes('user');
    const updated: MomentPost = {
      ...post,
      likes: isLiked
        ? post.likes.filter(l => l !== 'user')
        : [...post.likes, 'user'],
      likeNames: isLiked
        ? post.likeNames.filter((_, i) => post.likes[i] !== 'user')
        : [...post.likeNames, userProfile.name || '我'],
      updatedAt: Date.now(),
    };

    await savePost(updated);
    setPosts(prev => prev.map(p => p.id === postId ? updated : p));
  }, [posts, userProfile]);

  const submitComment = useCallback(async () => {
    if (!activeCommentPostId || !commentText.trim()) return;
    const post = posts.find(p => p.id === activeCommentPostId);
    if (!post) return;

    const comment: MomentComment = {
      id: createCommentId(),
      author: 'user',
      authorName: userProfile.name || '我',
      replyTo: replyTarget?.id,
      replyToName: replyTarget?.name,
      content: commentText.trim(),
      createdAt: Date.now(),
    };

    const updated: MomentPost = {
      ...post,
      comments: [...post.comments, comment],
      updatedAt: Date.now(),
    };

    await savePost(updated);
    setPosts(prev => prev.map(p => p.id === updated.id ? updated : p));
    setCommentText('');
    setReplyTarget(null);
  }, [activeCommentPostId, commentText, replyTarget, posts, userProfile]);

  const handleDeletePost = useCallback(async (postId: string) => {
    await deletePost(postId);
    setPosts(prev => prev.filter(p => p.id !== postId));
    setMenuPostId(null);
    addToast('已删除', 'info');
  }, [addToast]);

  const togglePin = useCallback(async (postId: string) => {
    const post = posts.find(p => p.id === postId);
    if (!post) return;
    const updated = { ...post, pinned: !post.pinned, updatedAt: Date.now() };
    await savePost(updated);
    setPosts(prev => {
      const list = prev.map(p => p.id === postId ? updated : p);
      list.sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return b.createdAt - a.createdAt;
      });
      return list;
    });
    setMenuPostId(null);
    addToast(updated.pinned ? '已置顶' : '已取消置顶', 'info');
  }, [posts, addToast]);

  // ==================== 长按编辑 ====================

  const handleLongPress = useCallback((postId: string, commentId?: string) => {
    const post = posts.find(p => p.id === postId);
    if (!post) return;
    if (commentId) {
      const comment = post.comments.find(c => c.id === commentId);
      if (comment) {
        setEditingField({ postId, commentId });
        setEditText(comment.content);
      }
    } else {
      setEditingField({ postId });
      setEditText(post.text || '');
    }
  }, [posts]);

  const saveEdit = useCallback(async () => {
    if (!editingField) return;
    const post = posts.find(p => p.id === editingField.postId);
    if (!post) return;

    let updated: MomentPost;
    if (editingField.commentId) {
      updated = {
        ...post,
        comments: post.comments.map(c =>
          c.id === editingField.commentId ? { ...c, content: editText } : c
        ),
        updatedAt: Date.now(),
      };
    } else {
      updated = { ...post, text: editText, updatedAt: Date.now() };
    }

    await savePost(updated);
    setPosts(prev => prev.map(p => p.id === updated.id ? updated : p));
    setEditingField(null);
    setEditText('');
  }, [editingField, editText, posts]);

  // ==================== 时间格式化 ====================

  const formatTime = (ts: number) => {
    const now = Date.now();
    const diff = now - ts;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    const d = new Date(ts);
    const thisYear = new Date().getFullYear() === d.getFullYear();
    if (thisYear) return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  // ==================== 筛选 ====================

  const taPosts = useMemo(() =>
    posts.filter(p => p.author !== 'user'),
    [posts],
  );

  // ==================== 渲染：封面区 ====================

  const renderCover = (mode: 'user' | 'ta') => {
    const coverImage = mode === 'user'
      ? settings?.userCoverImage
      : settings?.taCoverImage;
    const name = mode === 'user'
      ? (settings?.userNickname || userProfile.name || '我')
      : charName;
    const signature = mode === 'user'
      ? (settings?.userSignature || '')
      : (settings?.taSignature || '');
    const avatar = mode === 'user'
      ? (userProfile.perCharAvatars?.[charId] || userProfile.avatar)
      : charAvatar;

    return (
      <div
        className="relative w-full shrink-0"
        style={{ height: COVER_HEIGHT }}
      >
        {/* 背景图 */}
        <div
          className="absolute inset-0 bg-gradient-to-b from-slate-700 to-slate-900 cursor-pointer"
          onClick={() => handleCoverUpload(mode)}
          style={coverImage ? {
            backgroundImage: `url(${coverImage})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
          } : {}}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/20" />

        {/* 头像和名字 */}
        <div className="absolute bottom-4 right-4 flex items-end gap-3">
          <div className="text-right">
            <div className="text-white font-bold text-base drop-shadow-lg">{name}</div>
            {signature && (
              <div className="text-white/60 text-xs mt-0.5 drop-shadow">{signature}</div>
            )}
          </div>
          <div className="w-16 h-16 rounded-lg overflow-hidden border-2 border-white/30 shadow-lg">
            {avatar
              ? <TokenImg value={avatar} className="w-full h-full object-cover" />
              : <div className="w-full h-full bg-slate-600" />
            }
          </div>
        </div>
      </div>
    );
  };

  // ==================== 渲染：音乐卡片 ====================

  const renderMusicCard = (music: MomentMusicCard) => (
    <div className="flex items-center gap-3 rounded-xl p-3 mt-2"
      style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}>
      {music.albumPic
        ? <img src={music.albumPic} alt="" className="w-14 h-14 rounded-lg object-cover shrink-0" />
        : <div className="w-14 h-14 rounded-lg bg-slate-700 flex items-center justify-center shrink-0">
            <MusicNote size={24} className="text-white/40" />
          </div>
      }
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate" style={{ color: 'var(--moments-text, #e2e8f0)' }}>
          {music.songName || '未知歌曲'}
        </div>
        <div className="text-xs mt-0.5 truncate" style={{ color: 'var(--moments-text-secondary, #94a3b8)' }}>
          {music.artists || '未知歌手'}
        </div>
      </div>
      <MusicNote size={20} weight="fill" className="text-white/30 shrink-0" />
    </div>
  );

  // ==================== 渲染：文章卡片 ====================

  const renderArticleCard = (article: MomentArticleCard) => (
    <div className="rounded-xl p-3 mt-2"
      style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}>
      <div className="text-sm font-medium" style={{ color: 'var(--moments-text, #e2e8f0)' }}>
        {article.title}
      </div>
      {article.body && (
        <div className="text-xs mt-1 line-clamp-3" style={{ color: 'var(--moments-text-secondary, #94a3b8)' }}>
          {article.body}
        </div>
      )}
      {article.url && (
        <div className="text-xs mt-1.5 text-blue-400 truncate">{article.url}</div>
      )}
    </div>
  );

  // ==================== 渲染：图片网格 ====================

  const renderImageGrid = (images: string[]) => {
    const count = images.length;
    const cols = count === 1 ? 1 : count <= 4 ? 2 : 3;
    return (
      <div className={`grid gap-1 mt-2`} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {images.map((img, i) => (
          <div key={i} className="aspect-square rounded-lg overflow-hidden bg-slate-800">
            <img src={img} alt="" className="w-full h-full object-cover" />
          </div>
        ))}
      </div>
    );
  };

  // ==================== 渲染：单条动态 ====================

  const renderPost = (post: MomentPost) => {
    const isMe = post.author === 'user';
    const isLiked = post.likes.includes('user');
    const showMenu = menuPostId === post.id;
    const showComments = activeCommentPostId === post.id;
    const isEditing = editingField?.postId === post.id && !editingField.commentId;

    return (
      <div key={post.id} className="px-4 py-4 border-b" style={{ borderColor: 'rgba(255,255,255,0.06)' }}>
        {/* 置顶标识 */}
        {post.pinned && (
          <div className="flex items-center gap-1 text-xs mb-2" style={{ color: '#f59e0b' }}>
            <PushPin size={12} weight="fill" /> 置顶
          </div>
        )}

        {/* 头部：头像 + 名字 */}
        <div className="flex items-start gap-3">
          <div
            className="w-10 h-10 rounded-lg overflow-hidden shrink-0 cursor-pointer"
            onClick={() => { if (!isMe) setView('taPage'); }}
          >
            {post.authorAvatar
              ? <TokenImg value={post.authorAvatar} className="w-full h-full object-cover" />
              : <div className="w-full h-full bg-slate-600" />
            }
          </div>

          <div className="flex-1 min-w-0">
            <div
              className="text-sm font-bold cursor-pointer"
              style={{ color: isMe ? '#60a5fa' : '#c084fc' }}
              onClick={() => { if (!isMe) setView('taPage'); }}
            >
              {post.authorName}
            </div>

            {/* 正文（长按编辑） */}
            {post.text && (
              isEditing ? (
                <div className="mt-1">
                  <textarea
                    value={editText}
                    onChange={e => setEditText(e.target.value)}
                    className="w-full rounded-lg p-2 text-sm bg-white/10 text-white/90 border border-white/10 resize-none"
                    rows={3}
                    autoFocus
                  />
                  <div className="flex gap-2 mt-1">
                    <button onClick={saveEdit} className="text-xs text-blue-400">保存</button>
                    <button onClick={() => setEditingField(null)} className="text-xs text-white/40">取消</button>
                  </div>
                </div>
              ) : (
                <div
                  className="text-sm mt-1 whitespace-pre-wrap leading-relaxed cursor-pointer"
                  style={{ color: 'var(--moments-text, #e2e8f0)' }}
                  onContextMenu={e => { e.preventDefault(); handleLongPress(post.id); }}
                  onTouchStart={() => {
                    const timer = setTimeout(() => handleLongPress(post.id), 600);
                    const clear = () => { clearTimeout(timer); document.removeEventListener('touchend', clear); };
                    document.addEventListener('touchend', clear, { once: true });
                  }}
                >
                  {post.text}
                </div>
              )
            )}

            {/* 图片 */}
            {post.images && post.images.length > 0 && renderImageGrid(post.images)}

            {/* 音乐卡片 */}
            {post.music && renderMusicCard(post.music)}

            {/* 文章卡片 */}
            {post.article && renderArticleCard(post.article)}

            {/* 时间 + 操作栏 */}
            <div className="flex items-center justify-between mt-3">
              <div className="text-xs" style={{ color: 'var(--moments-text-secondary, #64748b)' }}>
                {formatTime(post.createdAt)}
              </div>

              <div className="flex items-center gap-4">
                {/* 点赞 */}
                <button
                  onClick={() => toggleLike(post.id)}
                  className="flex items-center gap-1 text-xs active:scale-90 transition"
                  style={{ color: isLiked ? '#f43f5e' : 'var(--moments-text-secondary, #64748b)' }}
                >
                  <Heart size={16} weight={isLiked ? 'fill' : 'regular'} />
                </button>

                {/* 评论 */}
                <button
                  onClick={() => {
                    setActiveCommentPostId(activeCommentPostId === post.id ? null : post.id);
                    setReplyTarget(null);
                    setTimeout(() => commentInputRef.current?.focus(), 100);
                  }}
                  className="flex items-center gap-1 text-xs active:scale-90 transition"
                  style={{ color: 'var(--moments-text-secondary, #64748b)' }}
                >
                  <ChatCircle size={16} />
                </button>

                {/* 分享 */}
                <button
                  className="flex items-center gap-1 text-xs active:scale-90 transition"
                  style={{ color: 'var(--moments-text-secondary, #64748b)' }}
                >
                  <ShareNetwork size={16} />
                </button>

                {/* 更多 */}
                <button
                  onClick={() => setMenuPostId(showMenu ? null : post.id)}
                  className="active:scale-90 transition"
                  style={{ color: 'var(--moments-text-secondary, #64748b)' }}
                >
                  <DotsThree size={16} weight="bold" />
                </button>
              </div>
            </div>

            {/* 更多菜单 */}
            {showMenu && (
              <div className="flex gap-2 mt-2 animate-slide-up">
                {isMe && (
                  <button
                    onClick={() => togglePin(post.id)}
                    className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-full bg-white/10 text-white/70 active:scale-95 transition"
                  >
                    <PushPin size={12} /> {post.pinned ? '取消置顶' : '置顶'}
                  </button>
                )}
                <button
                  onClick={() => handleDeletePost(post.id)}
                  className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-full bg-red-500/15 text-red-400 active:scale-95 transition"
                >
                  <Trash size={12} /> 删除
                </button>
              </div>
            )}

            {/* 点赞列表 */}
            {post.likeNames.length > 0 && (
              <div className="flex items-center gap-1.5 mt-2.5 px-2.5 py-1.5 rounded-lg"
                style={{ background: 'rgba(255,255,255,0.04)' }}>
                <Heart size={12} weight="fill" className="text-rose-400 shrink-0" />
                <div className="text-xs" style={{ color: '#93c5fd' }}>
                  {post.likeNames.join('，')}
                </div>
              </div>
            )}

            {/* 评论区 */}
            {post.comments.length > 0 && (
              <div className="mt-1 px-2.5 py-2 rounded-lg space-y-1.5"
                style={{ background: 'rgba(255,255,255,0.04)' }}>
                {post.comments.map(c => {
                  const isEditingThis = editingField?.postId === post.id && editingField?.commentId === c.id;
                  return (
                    <div key={c.id} className="text-xs leading-relaxed">
                      {isEditingThis ? (
                        <div>
                          <input
                            value={editText}
                            onChange={e => setEditText(e.target.value)}
                            className="w-full rounded p-1 text-xs bg-white/10 text-white/90 border border-white/10"
                            autoFocus
                            onKeyDown={e => { if (e.key === 'Enter') saveEdit(); }}
                          />
                          <div className="flex gap-2 mt-0.5">
                            <button onClick={saveEdit} className="text-[10px] text-blue-400">保存</button>
                            <button onClick={() => setEditingField(null)} className="text-[10px] text-white/40">取消</button>
                          </div>
                        </div>
                      ) : (
                        <span
                          className="cursor-pointer"
                          onContextMenu={e => { e.preventDefault(); handleLongPress(post.id, c.id); }}
                          onTouchStart={() => {
                            const timer = setTimeout(() => handleLongPress(post.id, c.id), 600);
                            const clear = () => { clearTimeout(timer); document.removeEventListener('touchend', clear); };
                            document.addEventListener('touchend', clear, { once: true });
                          }}
                          onClick={() => {
                            setActiveCommentPostId(post.id);
                            setReplyTarget({ id: c.id, name: c.authorName });
                            setTimeout(() => commentInputRef.current?.focus(), 100);
                          }}
                        >
                          <span style={{ color: '#93c5fd' }} className="font-medium">{c.authorName}</span>
                          {c.replyToName && (
                            <>
                              <span style={{ color: 'var(--moments-text-secondary, #64748b)' }}> 回复 </span>
                              <span style={{ color: '#93c5fd' }} className="font-medium">{c.replyToName}</span>
                            </>
                          )}
                          <span style={{ color: 'var(--moments-text-secondary, #64748b)' }}>：</span>
                          <span style={{ color: 'var(--moments-text, #cbd5e1)' }}>{c.content}</span>
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* 评论输入框 */}
            {showComments && (
              <div className="flex items-center gap-2 mt-2 animate-slide-up">
                <input
                  ref={commentInputRef}
                  value={commentText}
                  onChange={e => setCommentText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') submitComment(); }}
                  placeholder={replyTarget ? `回复 ${replyTarget.name}...` : '写评论...'}
                  className="flex-1 rounded-full px-3 py-1.5 text-xs bg-white/10 text-white/90 border border-white/10 placeholder:text-white/30"
                />
                <button
                  onClick={submitComment}
                  disabled={!commentText.trim()}
                  className="p-1.5 rounded-full disabled:opacity-30 active:scale-90 transition"
                  style={{ color: '#60a5fa' }}
                >
                  <PaperPlaneTilt size={16} weight="fill" />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  // ==================== 渲染：发布菜单 ====================

  const renderComposeMenu = () => {
    const items: { type: MomentPostType; icon: React.ReactNode; label: string; sub: string }[] = [
      { type: 'image', icon: <ImageSquare size={22} weight="light" />, label: '发图片', sub: '只发图，不配文字' },
      { type: 'imageText', icon: <ImageIcon size={22} weight="light" />, label: '发图文', sub: '图片 + 一段文字' },
      { type: 'text', icon: <TextAa size={22} weight="light" />, label: '发文字', sub: '纯文字动态' },
      { type: 'music', icon: <MusicNote size={22} weight="light" />, label: '分享音乐', sub: '渲染成音乐卡片' },
      { type: 'article', icon: <Article size={22} weight="light" />, label: '分享文章', sub: '链接或标题+正文' },
    ];

    return (
      <div
        className="fixed inset-0 z-50 flex items-end justify-center"
        onClick={() => setShowComposeMenu(false)}
      >
        <div className="absolute inset-0 bg-black/50" />
        <div
          className="relative w-full max-w-md rounded-t-2xl p-6 pb-8 animate-slide-up"
          style={{ background: '#1a1a2e' }}
          onClick={e => e.stopPropagation()}
        >
          <div className="w-10 h-1 rounded-full bg-white/20 mx-auto mb-6" />
          <div className="space-y-4">
            {items.map(item => (
              <button
                key={item.type}
                onClick={() => {
                  setComposeType(item.type);
                  setShowComposeMenu(false);
                  setView('compose');
                }}
                className="w-full flex items-center gap-4 text-left active:scale-[0.98] transition"
              >
                <div className="text-blue-400">{item.icon}</div>
                <div>
                  <div className="text-sm font-medium text-white/90">{item.label}</div>
                  <div className="text-xs text-white/40">{item.sub}</div>
                </div>
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowComposeMenu(false)}
            className="w-full mt-6 py-3 text-center text-sm text-white/50 border-t border-white/10"
          >
            取消
          </button>
        </div>
      </div>
    );
  };

  // ==================== 渲染：发布页 ====================

  const renderCompose = () => {
    const canPublish = (() => {
      switch (composeType) {
        case 'text': return !!composeText.trim();
        case 'image': return composeImages.length > 0;
        case 'imageText': return composeImages.length > 0 || !!composeText.trim();
        case 'music': return !!composeMusicName.trim();
        case 'article': return !!composeArticleTitle.trim();
        default: return false;
      }
    })();

    return (
      <div className="flex flex-col h-full" style={{ background: '#0f0f1a', color: '#e2e8f0' }}>
        {/* 顶栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0">
          <button onClick={() => { setView('main'); setComposeType(null); }} className="text-white/60 active:scale-90">
            <X size={22} />
          </button>
          <div className="text-sm font-medium text-white/80">
            {composeType === 'text' ? '发文字' : composeType === 'image' ? '发图片' : composeType === 'imageText' ? '发图文' : composeType === 'music' ? '分享音乐' : '分享文章'}
          </div>
          <button
            onClick={handlePublish}
            disabled={!canPublish}
            className="px-4 py-1.5 rounded-full text-xs font-bold disabled:opacity-30 transition"
            style={{ background: '#3b82f6', color: 'white' }}
          >
            发布
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* 文字输入 */}
          {(composeType === 'text' || composeType === 'imageText') && (
            <textarea
              value={composeText}
              onChange={e => setComposeText(e.target.value)}
              placeholder="这一刻的想法..."
              className="w-full min-h-[120px] bg-transparent text-sm text-white/90 placeholder:text-white/25 resize-none border-none outline-none"
              autoFocus
            />
          )}

          {/* 图片上传 */}
          {(composeType === 'image' || composeType === 'imageText') && (
            <div>
              <div className="grid grid-cols-3 gap-2">
                {composeImages.map((img, i) => (
                  <div key={i} className="relative aspect-square rounded-lg overflow-hidden bg-slate-800">
                    <img src={img} alt="" className="w-full h-full object-cover" />
                    <button
                      onClick={() => setComposeImages(prev => prev.filter((_, j) => j !== i))}
                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-black/60 flex items-center justify-center"
                    >
                      <X size={12} className="text-white" />
                    </button>
                  </div>
                ))}
                {composeImages.length < 9 && (
                  <button
                    onClick={handleImageUpload}
                    className="aspect-square rounded-lg border-2 border-dashed border-white/15 flex items-center justify-center active:scale-95 transition"
                  >
                    <Plus size={24} className="text-white/30" />
                  </button>
                )}
              </div>
            </div>
          )}

          {/* 音乐输入 */}
          {composeType === 'music' && (
            <div className="space-y-3">
              <input
                value={composeMusicName}
                onChange={e => setComposeMusicName(e.target.value)}
                placeholder="歌名"
                className="w-full px-3 py-2 rounded-lg bg-white/10 text-sm text-white/90 border border-white/10 placeholder:text-white/30"
                autoFocus
              />
              <input
                value={composeMusicArtist}
                onChange={e => setComposeMusicArtist(e.target.value)}
                placeholder="歌手"
                className="w-full px-3 py-2 rounded-lg bg-white/10 text-sm text-white/90 border border-white/10 placeholder:text-white/30"
              />
              <input
                value={composeMusicCover}
                onChange={e => setComposeMusicCover(e.target.value)}
                placeholder="封面图 URL（粘贴网易云歌曲链接可自动识别）"
                className="w-full px-3 py-2 rounded-lg bg-white/10 text-sm text-white/90 border border-white/10 placeholder:text-white/30"
              />
              {composeMusicCover && (
                <div className="mt-2">{renderMusicCard({ songName: composeMusicName, artists: composeMusicArtist, albumPic: composeMusicCover })}</div>
              )}
            </div>
          )}

          {/* 文章输入 */}
          {composeType === 'article' && (
            <div className="space-y-3">
              <input
                value={composeArticleTitle}
                onChange={e => setComposeArticleTitle(e.target.value)}
                placeholder="文章标题"
                className="w-full px-3 py-2 rounded-lg bg-white/10 text-sm text-white/90 border border-white/10 placeholder:text-white/30"
                autoFocus
              />
              <input
                value={composeArticleUrl}
                onChange={e => setComposeArticleUrl(e.target.value)}
                placeholder="链接（可选）"
                className="w-full px-3 py-2 rounded-lg bg-white/10 text-sm text-white/90 border border-white/10 placeholder:text-white/30"
              />
              <textarea
                value={composeArticleBody}
                onChange={e => setComposeArticleBody(e.target.value)}
                placeholder="正文摘要（可选）"
                className="w-full min-h-[80px] px-3 py-2 rounded-lg bg-white/10 text-sm text-white/90 border border-white/10 placeholder:text-white/30 resize-none"
              />
            </div>
          )}
        </div>
      </div>
    );
  };

  // ==================== 渲染：设置页 ====================

  const renderSettings = () => {
    if (!settings) return null;
    return (
      <div className="flex flex-col h-full" style={{ background: '#0f0f1a', color: '#e2e8f0' }}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10 shrink-0">
          <button onClick={() => setView('main')} className="text-white/60 active:scale-90"><CaretLeft size={22} /></button>
          <div className="text-sm font-medium">朋友圈设置</div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {/* 昵称 */}
          <div>
            <label className="text-xs text-white/50 mb-1 block">我的昵称</label>
            <input
              value={settings.userNickname || ''}
              onChange={e => setSettings({ ...settings, userNickname: e.target.value })}
              placeholder={userProfile.name}
              className="w-full px-3 py-2 rounded-lg bg-white/10 text-sm text-white/90 border border-white/10"
            />
          </div>

          {/* 签名 */}
          <div>
            <label className="text-xs text-white/50 mb-1 block">我的个性签名</label>
            <input
              value={settings.userSignature || ''}
              onChange={e => setSettings({ ...settings, userSignature: e.target.value })}
              placeholder="写点什么..."
              className="w-full px-3 py-2 rounded-lg bg-white/10 text-sm text-white/90 border border-white/10"
            />
          </div>

          {/* TA 发布频率 */}
          <div>
            <label className="text-xs text-white/50 mb-1 block">TA 每次最多发几条</label>
            <div className="flex items-center gap-3">
              {[1, 2, 3].map(n => (
                <button
                  key={n}
                  onClick={() => setSettings({ ...settings, taPostFrequency: n })}
                  className="px-4 py-2 rounded-lg text-sm transition"
                  style={{
                    background: settings.taPostFrequency === n ? '#3b82f6' : 'rgba(255,255,255,0.08)',
                    color: settings.taPostFrequency === n ? 'white' : '#94a3b8',
                  }}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          {/* 异步延时互动 */}
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-white/80">异步延时互动</div>
              <div className="text-xs text-white/40 mt-0.5">TA 的点赞和评论会延迟随机触发</div>
            </div>
            <button
              onClick={() => setSettings({ ...settings, asyncInteraction: !settings.asyncInteraction })}
              className="relative w-10 h-5 rounded-full transition"
              style={{ background: settings.asyncInteraction ? '#3b82f6' : 'rgba(255,255,255,0.15)' }}
            >
              <span
                className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all"
                style={{ left: settings.asyncInteraction ? '22px' : '2px' }}
              />
            </button>
          </div>

          {/* 保存按钮 */}
          <button
            onClick={async () => {
              await saveMomentSettings(settings);
              addToast('设置已保存', 'success');
              setView('main');
            }}
            className="w-full py-2.5 rounded-xl text-sm font-medium transition active:scale-[0.98]"
            style={{ background: '#3b82f6', color: 'white' }}
          >
            保存
          </button>
        </div>
      </div>
    );
  };

  // ==================== 渲染：主视图 ====================

  if (!charId) {
    return (
      <div className="flex items-center justify-center h-full text-white/40 text-sm">
        请先选择一个角色
      </div>
    );
  }

  if (view === 'compose' && composeType) return renderCompose();
  if (view === 'settings') return renderSettings();

  const isTA = view === 'taPage';
  const displayPosts = isTA ? taPosts : posts;

  return (
    <div className="flex flex-col h-full" style={{ background: '#0f0f1a', color: '#e2e8f0' }}>
      {/* 顶栏 */}
      <div className="flex items-center justify-between px-4 py-2 shrink-0" style={{ background: 'rgba(15,15,26,0.95)' }}>
        <button
          onClick={() => { if (isTA) setView('main'); else closeApp(); }}
          className="text-white/60 active:scale-90 transition"
        >
          <CaretLeft size={22} />
        </button>

        <div className="text-sm font-medium text-white/80">
          {isTA ? `${charName} 的朋友圈` : '朋友圈'}
        </div>

        <div className="flex items-center gap-2">
          {isTA ? (
            /* TA 页面：刷新按钮 */
            <button
              className="text-white/60 active:scale-90 transition"
              title="让 TA 更新动态"
              onClick={() => addToast('生成功能将在接入生图 API 后启用', 'info')}
            >
              <ArrowsClockwise size={20} />
            </button>
          ) : (
            /* 我的页面：发布 + 设置 */
            <>
              <button
                onClick={() => setView('settings')}
                className="text-white/60 active:scale-90 transition"
              >
                <Gear size={18} />
              </button>
              <button
                onClick={() => setShowComposeMenu(true)}
                className="text-white/60 active:scale-90 transition"
              >
                <Camera size={20} weight="bold" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* 内容区 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto no-scrollbar overscroll-contain">
        {/* 封面 */}
        {renderCover(isTA ? 'ta' : 'user')}

        {/* 动态列表 */}
        {loading ? (
          <div className="flex items-center justify-center py-12 text-white/30 text-sm">加载中...</div>
        ) : displayPosts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-white/30">
            <div className="text-sm">{isTA ? `${charName} 还没发过动态` : '还没有动态'}</div>
            {!isTA && (
              <button
                onClick={() => setShowComposeMenu(true)}
                className="mt-3 text-xs text-blue-400 active:scale-90 transition"
              >
                发布第一条朋友圈
              </button>
            )}
          </div>
        ) : (
          displayPosts.map(renderPost)
        )}

        {/* 底部安全间距 */}
        <div className="h-20" />
      </div>

      {/* 发布菜单 */}
      {showComposeMenu && renderComposeMenu()}
    </div>
  );
};

export default MomentsApp;
