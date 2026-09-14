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
import { AppID } from '../types';
import {
  MomentPost,
  MomentComment,
  MomentSettings,
  MomentMusicCard,
  MomentArticleCard,
  MomentPostType,
  MomentUpdateFrequency,
  DEFAULT_MOMENT_SETTINGS,
  getPostsByCharId,
  savePost,
  deletePost,
  getMomentSettings,
  saveMomentSettings,
  createPostId,
  createCommentId,
} from '../utils/momentsDb';
import { generateMoments, canGenerate, generateSecretMemory, generateSecretSpaceIdentity, type MusicShareCandidate } from '../utils/momentsAi';
import { DB } from '../utils/db';
import { useMusic, musicApi, toHttps } from '../context/MusicContext';
import { expandShortUrl } from '../utils/webpageExtractor';
import { generateImage, isImageGenApiReady } from '../utils/imageGenApi';
import { migrateDataUrlToRef } from '../utils/blobRef';

// ==================== 样式常量 ====================

const COVER_HEIGHT = 240;
const AVATAR_BOTTOM = -20;
const SIGNATURE_BOTTOM = -35;
const AVATAR_SIZE = 64;

// ==================== 主组件 ====================

type View = 'main' | 'taPage' | 'compose' | 'settings' | 'secretSpace';
type ComposeType = MomentPostType | null;

const MomentsApp: React.FC = () => {
  const {
    characters,
    activeCharacterId,
    userProfile,
    apiConfig,
    addToast,
    closeApp,
    openApp,
    theme: osTheme,
  } = useOS();
  const { cfg: musicCfg, profile: neteaseProfile } = useMusic();

  const char = characters.find(c => c.id === activeCharacterId) || null;
  const charId = activeCharacterId || '';
  const charName = char?.name || 'TA';
  const charAvatar = char?.avatar || '';

  // ---- 视图状态 ----
  const [view, setView] = useState<View>(() => {
    const openTa = localStorage.getItem('moments_open_ta');
    if (openTa) {
      localStorage.removeItem('moments_open_ta');
      return 'taPage';
    }
    return 'main';
  });
  const [composeType, setComposeType] = useState<ComposeType>(null);
  const [showComposeMenu, setShowComposeMenu] = useState(false);

  // ---- 数据 ----
  const [posts, setPosts] = useState<MomentPost[]>([]);
  const [settings, setSettings] = useState<MomentSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [secretSpaceRefreshing, setSecretSpaceRefreshing] = useState(false);
  const [secretSpaceEditing, setSecretSpaceEditing] = useState(false);
  const [secretSpaceNameDraft, setSecretSpaceNameDraft] = useState('');
  const [secretSpaceSignatureDraft, setSecretSpaceSignatureDraft] = useState('');
  const genAbortRef = useRef<AbortController | null>(null);

  // ---- 互动状态 ----
  const [activeCommentPostId, setActiveCommentPostId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [replyTarget, setReplyTarget] = useState<{ id: string; name: string } | null>(null);
  /** 左滑展开删除按钮的那条评论，key: `${postId}:${commentId}`。同一时间只展开一条。 */
  const [swipedCommentKey, setSwipedCommentKey] = useState<string | null>(null);
  /** 图片加载失败（裂图）的位置集合，key: `${postId}:${index}`。命中时中心显示 🔄 重试图标。 */
  const [brokenImageKeys, setBrokenImageKeys] = useState<Set<string>>(new Set());
  const [menuPostId, setMenuPostId] = useState<string | null>(null);
  /** 图裂了点 🔄 重新生成时，标记「哪条动态的第几张图」正在重试，避免重复点击。key: `${postId}:${index}` */
  const [retryingImageKeys, setRetryingImageKeys] = useState<Set<string>>(new Set());


  // ---- 发布状态 ----
  const [composeText, setComposeText] = useState('');
  const [composeImages, setComposeImages] = useState<string[]>([]);
  const [composeMusicName, setComposeMusicName] = useState('');
  const [composeMusicArtist, setComposeMusicArtist] = useState('');
  const [composeMusicCover, setComposeMusicCover] = useState('');
  const [composeMusicSongId, setComposeMusicSongId] = useState<number | null>(null);
  const [composeMusicLinkInput, setComposeMusicLinkInput] = useState('');
  const [musicParsing, setMusicParsing] = useState(false);
  const [musicParseError, setMusicParseError] = useState('');
  const [composeArticleTitle, setComposeArticleTitle] = useState('');
  const [composeArticleUrl, setComposeArticleUrl] = useState('');
  const [composeArticleBody, setComposeArticleBody] = useState('');

  // ---- 编辑状态 ----
  const [editingField, setEditingField] = useState<{ postId: string; commentId?: string } | null>(null);
  const [editText, setEditText] = useState('');

  // ---- 双击编辑（替代长按，避免误触） ----
  const DOUBLE_TAP_EDIT_DELAY = 300; // ms，两次点击间隔阈值
  const lastEditTapRef = useRef<{ key: string; time: number } | null>(null);
  const commentTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // ==================== AI 生成 TA 动态 ====================

  /**
   * 构建可供 TA 分享的候选歌曲池：TA 自己歌单里的歌 + 用户网易云"喜欢的音乐"（如果登录了、
   * 且这个角色允许读取用户音乐）。失败/没有数据就返回空数组，调用方据此决定 prompt 里
   * 提不提"分享音乐"这件事。
   */
  const buildMusicCandidates = useCallback(async (): Promise<MusicShareCandidate[]> => {
    const candidates: MusicShareCandidate[] = [];
    const seenIds = new Set<number>();

    // TA 自己歌单里的歌
    const taSongs = (char?.musicProfile?.playlists || []).flatMap(pl => pl.songs || []);
    for (const s of taSongs) {
      if (seenIds.has(s.id)) continue;
      seenIds.add(s.id);
      candidates.push({ id: s.id, name: s.name, artists: s.artists, albumPic: s.albumPic, source: 'ta' });
    }

    // 用户网易云"喜欢的音乐"（需要登录 + 这个角色允许读取用户音乐）
    const canReadUser = char?.musicProfile?.canReadUserMusic ?? true;
    if (neteaseProfile && canReadUser && musicCfg.cookie) {
      try {
        const likeRes = await musicApi.call(musicCfg, 'likelist', {});
        const likedIds: number[] = (likeRes?.ids || likeRes?.data?.ids || []).slice(0, 8);
        if (likedIds.length > 0) {
          const detail = await musicApi.call(musicCfg, 'song/detail', { ids: likedIds });
          for (const song of (detail?.songs || [])) {
            if (seenIds.has(song.id)) continue;
            seenIds.add(song.id);
            const artists = (song.ar || song.artists || []).map((a: any) => a.name).filter(Boolean).join(' / ');
            candidates.push({
              id: song.id,
              name: song.name || '',
              artists: artists || '未知歌手',
              albumPic: toHttps(song.al?.picUrl || song.album?.picUrl || ''),
              source: 'user',
            });
          }
        }
      } catch (e) {
        console.warn('[Moments] 读取用户网易云喜欢列表失败，跳过（不影响其他功能）:', e);
      }
    }

    return candidates;
  }, [char, neteaseProfile, musicCfg]);

  const handleGenerate = useCallback(async (manual = false) => {
    if (!char || !settings || !apiConfig.apiKey || !apiConfig.baseUrl) {
      if (manual) addToast('请先配置 API', 'info');
      return;
    }
    const isPaused = settings.updateFrequency === 'paused';
    // 暂停营业下，手动点🔄是"翻出历史动态"，不受正常更新的冷却限制；只挡自动触发和并发点击。
    if (!isPaused && !canGenerate(settings)) {
      if (manual) addToast('刷新太频繁了，稍后再试', 'info');
      return;
    }
    if (isPaused && !manual) return; // 暂停营业下，自动触发（打开App/查手机跳转）完全不生成
    if (generating) return;

    // 取消上一次未完成的请求
    genAbortRef.current?.abort();
    const ac = new AbortController();
    genAbortRef.current = ac;

    setGenerating(true);

    // 暂停营业 + 手动点击：走独立的"历史动态生成"，同时进 TA 常规列表和🌼秘密空间归档。
    if (isPaused) {
      try {
        const post = await generateSecretMemory({
          char, userProfile, apiConfig, settings,
          existingPosts: posts,
          signal: ac.signal,
        });
        if (ac.signal.aborted) return;
        await savePost(post);
        setPosts(prev => [post, ...prev]);
        addToast(`翻到了 ${charName} 更早以前的一条动态`, 'success');
      } catch (e: any) {
        if (ac.signal.aborted) return;
        console.error('[Moments] generateSecretMemory failed', e);
        addToast(`生成失败: ${e.message?.slice(0, 60) || '未知错误'}`, 'error');
      } finally {
        if (!ac.signal.aborted) setGenerating(false);
      }
      return;
    }

    try {
      const musicCandidates = await buildMusicCandidates();
      console.info('[Moments] 本次可分享的候选歌曲池:', musicCandidates.map(c => `${c.name}(${c.source})`));
      const result = await generateMoments({
        char,
        userProfile,
        apiConfig,
        settings,
        existingPosts: posts,
        musicCandidates,
        musicCfg,
        skipInteractions: false,
        signal: ac.signal,
      });

      if (ac.signal.aborted) return;

      // 写入 IndexedDB
      for (const post of result.newPosts) {
        await savePost(post);
      }
      for (const updated of result.updatedUserPosts) {
        await savePost(updated);
      }
      for (const updated of result.updatedTaPosts) {
        await savePost(updated);
      }

      // 更新冷却时间戳
      const updatedSettings = { ...settings, lastGeneratedAt: Date.now() };
      await saveMomentSettings(updatedSettings);
      setSettings(updatedSettings);

      // 合并到 state 并排序
      setPosts(prev => {
        const existingIds = new Set(prev.map(p => p.id));
        // 更新被互动过的 user posts + 被追加回复的 TA posts
        let merged = prev.map(p => {
          const updatedUser = result.updatedUserPosts.find(u => u.id === p.id);
          if (updatedUser) return updatedUser;
          const updatedTa = result.updatedTaPosts.find(u => u.id === p.id);
          if (updatedTa) return updatedTa;
          return p;
        });
        // 添加 TA 的新动态
        const brandNew = result.newPosts.filter(p => !existingIds.has(p.id));
        merged = [...brandNew, ...merged];
        // 排序：置顶优先，时间倒序
        merged.sort((a, b) => {
          if (a.pinned && !b.pinned) return -1;
          if (!a.pinned && b.pinned) return 1;
          return b.createdAt - a.createdAt;
        });
        return merged;
      });

      if (result.newPosts.length > 0 || result.updatedUserPosts.length > 0 || result.updatedTaPosts.length > 0) {
        const parts: string[] = [];
        if (result.newPosts.length > 0) parts.push(`发了 ${result.newPosts.length} 条动态`);
        if (result.updatedUserPosts.length > 0) parts.push('互动了你的朋友圈');
        if (result.updatedTaPosts.length > 0) parts.push('回复了评论');
        addToast(`${char.name} ${parts.join('，')}`, 'success');
      }
    } catch (e: any) {
      if (ac.signal.aborted) return;
      console.error('[Moments] generateMoments failed', e);
      if (manual) addToast(`生成失败: ${e.message?.slice(0, 60) || '未知错误'}`, 'error');
    } finally {
      if (!ac.signal.aborted) setGenerating(false);
    }
  }, [char, charName, settings, apiConfig, userProfile, posts, generating, addToast, buildMusicCandidates]);

  // "换个心情"：只重新生成秘密空间的背景/名字/签名，不动下面的历史动态列表。
  const handleRefreshSecretSpace = useCallback(async () => {
    if (!char || !settings || !apiConfig.apiKey || !apiConfig.baseUrl) {
      addToast('请先配置 API', 'info');
      return;
    }
    if (secretSpaceRefreshing) return;
    setSecretSpaceRefreshing(true);
    try {
      const identity = await generateSecretSpaceIdentity(char, userProfile, apiConfig);
      const updated: MomentSettings = {
        ...settings,
        secretSpaceName: identity.name,
        secretSpaceSignature: identity.signature,
        secretSpaceCoverImage: identity.coverImage || settings.secretSpaceCoverImage,
      };
      await saveMomentSettings(updated);
      setSettings(updated);
      addToast('心情换好了', 'success');
    } catch (e: any) {
      addToast(`换心情失败: ${e.message?.slice(0, 60) || '未知错误'}`, 'error');
    } finally {
      setSecretSpaceRefreshing(false);
    }
  }, [char, settings, apiConfig, userProfile, secretSpaceRefreshing, addToast]);

  // 打开 App 时自动触发一次 AI 生成
  const autoGenTriggered = useRef(false);
  useEffect(() => {
    if (!loading && settings && !autoGenTriggered.current && apiConfig.apiKey) {
      autoGenTriggered.current = true;
      handleGenerate(false);
    }
  }, [loading, settings, apiConfig.apiKey]); // handleGenerate 故意不加入依赖，只触发一次

  // 卸载时取消进行中的请求
  useEffect(() => {
    return () => { genAbortRef.current?.abort(); };
  }, []);

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
    setComposeMusicSongId(null);
    setComposeMusicLinkInput('');
    setMusicParseError('');
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

  // ==================== 分享音乐：粘贴网易云链接自动识别 ====================

  /** 从网易云链接（长链接或 163cn.tv 短链展开后）里提取 songId。 */
  const extractNeteaseSongId = (url: string): number | null => {
    const match = /[?&#]id=(\d+)/.exec(url) || /\/song\/(\d+)/.exec(url);
    return match ? Number(match[1]) : null;
  };

  /**
   * 粘贴框里的文本一旦看起来像网易云链接就自动识别：短链先展开，提取 songId 后
   * 调用网易云代理的 song/detail（和网易云音乐 App 走同一个 worker + cfg），
   * 拿真实歌名/歌手/封面，而不是把链接本身当封面 URL 硬塞进 <img>。
   */
  const handleMusicCoverInputChange = useCallback(async (rawInput: string) => {
    setMusicParseError('');
    const trimmed = rawInput.trim();
    if (!trimmed) { setComposeMusicSongId(null); return; }

    // 不像链接（不含 http 也不含常见网易云域名关键字）就当成普通 URL 输入，不触发识别。
    const looksLikeLink = /^https?:\/\//i.test(trimmed) || /music\.163\.com|163cn\.tv/i.test(trimmed);
    if (!looksLikeLink) { setComposeMusicSongId(null); return; }

    setMusicParsing(true);
    try {
      let resolvedUrl = trimmed;
      // 163cn.tv 等短链不含 songId，需要先跟随重定向展开成真实长链接。
      if (/163cn\.tv/i.test(trimmed) && !/music\.163\.com/i.test(trimmed)) {
        resolvedUrl = await expandShortUrl(trimmed);
      }
      const songId = extractNeteaseSongId(resolvedUrl);
      if (!songId) {
        setMusicParseError('没能从链接里识别出歌曲，换个链接试试，或者手动填歌名/歌手');
        setComposeMusicSongId(null);
        return;
      }
      const detail = await musicApi.call(musicCfg, 'song/detail', { ids: [songId] });
      const song = detail?.songs?.[0];
      if (!song) {
        setMusicParseError('没查到这首歌的信息，可能已下架，换一首或手动填写');
        setComposeMusicSongId(null);
        return;
      }
      const name = song.name || '';
      const artists = (song.ar || song.artists || []).map((a: any) => a.name).filter(Boolean).join(' / ');
      const cover = toHttps(song.al?.picUrl || song.album?.picUrl || '');
      setComposeMusicName(name);
      setComposeMusicArtist(artists || '未知歌手');
      setComposeMusicCover(cover);
      setComposeMusicSongId(songId);
    } catch (e: any) {
      setMusicParseError(`识别失败: ${e?.message?.slice(0, 60) || '未知错误'}`);
      setComposeMusicSongId(null);
    } finally {
      setMusicParsing(false);
    }
  }, [musicCfg]);

  // ==================== 封面上传 ====================

  const handleCoverUpload = useCallback((target: 'user' | 'ta' | 'secret') => {
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
        ...(target === 'user' ? { userCoverImage: dataUrl }
          : target === 'ta' ? { taCoverImage: dataUrl }
          : { secretSpaceCoverImage: dataUrl }),
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

    const replyToComment = replyTarget ? post.comments.find(c => c.id === replyTarget.id) : undefined;
    const comment: MomentComment = {
      id: createCommentId(),
      author: 'user',
      authorName: settings?.userNickname || userProfile.name || '我',
      replyTo: replyTarget?.id,
      replyToName: replyTarget?.name,
      replyToAuthor: replyToComment?.author,
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
  }, [activeCommentPostId, commentText, replyTarget, posts, userProfile, settings]);

  const handleDeletePost = useCallback(async (postId: string) => {
    await deletePost(postId);
    setPosts(prev => prev.filter(p => p.id !== postId));
    setMenuPostId(null);
    addToast('已删除', 'info');
  }, [addToast]);

  /** 左滑露出的垃圾桶点击：删除单条评论（不影响这条动态本身）。 */
  const handleDeleteComment = useCallback(async (postId: string, commentId: string) => {
    const post = posts.find(p => p.id === postId);
    if (!post) return;
    const updated: MomentPost = {
      ...post,
      comments: post.comments.filter(c => c.id !== commentId),
      updatedAt: Date.now(),
    };
    await savePost(updated);
    setPosts(prev => prev.map(p => p.id === postId ? updated : p));
    setSwipedCommentKey(null);
    addToast('评论已删除', 'info');
  }, [posts, addToast]);

  /** 转发这条动态到聊天框：生成一张卡片消息，内容=动态图文（不含评论），大小随内容走。 */
  const handleForwardToChat = useCallback(async (post: MomentPost) => {
    try {
      // 音乐动态：分享成真能播放的 music_card（intent: 'shared'），不是纯展示的转发卡片。
      if (post.type === 'music' && post.music) {
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
        addToast('已分享到聊天框', 'success');
        return;
      }

      const momentData = {
        charId: post.charId,
        charName: post.author === 'user' ? (settings?.userNickname || userProfile.name || '我') : charName,
        charAvatar: post.author === 'user' ? (userProfile.perCharAvatars?.[charId] || userProfile.avatar) : charAvatar,
        text: post.text || '',
        images: post.images || [],
        music: post.music || undefined,
        article: post.article || undefined,
        createdAt: post.createdAt,
      };
      await DB.saveMessage({
        charId,
        role: 'user',
        type: 'moment_card' as any,
        content: JSON.stringify(momentData),
      });
      addToast('已转发到聊天框', 'success');
    } catch (e: any) {
      addToast(`转发失败: ${e.message?.slice(0, 60) || '未知错误'}`, 'error');
    }
  }, [settings, userProfile, charName, charAvatar, charId, addToast]);

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

  /**
   * 图裂了点中心的 🔄：用这条动态原本的 imagePrompt 重新调一次生图 API（不重新问 AI
   * 要不要配图、配什么，避免多打一次聊天补全 API），成功就替换对应位置的图片。
   */
  const handleRetryImage = useCallback(async (postId: string, imageIndex: number) => {
    const key = `${postId}:${imageIndex}`;
    if (retryingImageKeys.has(key)) return;
    const post = posts.find(p => p.id === postId);
    if (!post?.imagePrompt) {
      addToast('这条动态没有可用于重新生成的描述', 'error');
      return;
    }
    if (!isImageGenApiReady(apiConfig.imageGenApi)) {
      addToast('生图 API 未配置或未启用，去设置里检查一下', 'error');
      return;
    }
    setRetryingImageKeys(prev => new Set(prev).add(key));
    try {
      const results = await generateImage(apiConfig.imageGenApi, post.imagePrompt, {
        meta: { appId: 'moments', appName: '朋友圈', purpose: '朋友圈配图重新生成', charId, charName },
      });
      const first = results[0];
      if (!first?.src) throw new Error('生图 API 没有返回图片');
      const storedContent = first.src.startsWith('data:') ? await migrateDataUrlToRef(first.src) : first.src;
      const nextImages = [...(post.images || [])];
      nextImages[imageIndex] = storedContent;
      const updated: MomentPost = { ...post, images: nextImages, updatedAt: Date.now() };
      await savePost(updated);
      setPosts(prev => prev.map(p => p.id === postId ? updated : p));
      addToast('已重新生成', 'success');
    } catch (e: any) {
      addToast(`重新生成失败: ${e?.message?.slice(0, 60) || '未知错误'}`, 'error');
    } finally {
      setRetryingImageKeys(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }, [posts, apiConfig.imageGenApi, charId, charName, addToast, retryingImageKeys]);

  // ==================== 双击编辑（原长按编辑，因容易误触已改为快速双击两下触发） ====================

  const handleEditTrigger = useCallback((postId: string, commentId?: string) => {
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

  // 正文双击判定：无其他单击行为竞争，直接按 key（postId）判断两次点击间隔。
  const handleTextDoubleTap = useCallback((postId: string) => {
    const key = postId;
    const now = Date.now();
    const last = lastEditTapRef.current;
    if (last && last.key === key && now - last.time < DOUBLE_TAP_EDIT_DELAY) {
      lastEditTapRef.current = null;
      handleEditTrigger(postId);
    } else {
      lastEditTapRef.current = { key, time: now };
    }
  }, [handleEditTrigger]);

  // 评论双击判定：单击本身要用来"回复"，所以第一下先延迟执行单击动作，
  // 若在阈值内等到第二下则取消单击动作、改为触发编辑。
  const handleCommentTap = useCallback((postId: string, commentId: string, onSingleTap: () => void) => {
    const key = `${postId}:${commentId}`;
    const now = Date.now();
    const last = lastEditTapRef.current;
    if (last && last.key === key && now - last.time < DOUBLE_TAP_EDIT_DELAY) {
      lastEditTapRef.current = null;
      if (commentTapTimerRef.current) {
        clearTimeout(commentTapTimerRef.current);
        commentTapTimerRef.current = null;
      }
      handleEditTrigger(postId, commentId);
    } else {
      lastEditTapRef.current = { key, time: now };
      if (commentTapTimerRef.current) clearTimeout(commentTapTimerRef.current);
      commentTapTimerRef.current = setTimeout(() => {
        commentTapTimerRef.current = null;
        onSingleTap();
      }, DOUBLE_TAP_EDIT_DELAY);
    }
  }, [handleEditTrigger]);

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

  // 秘密空间（🌼）动态：只在秘密空间页面展示，"我的朋友圈"混合线和 TA 朋友圈常规列表都要排除。
  const visiblePosts = useMemo(() =>
    posts.filter(p => !p.isSecretMemory),
    [posts],
  );

  const taPosts = useMemo(() =>
    visiblePosts.filter(p => p.author !== 'user'),
    [visiblePosts],
  );

  const secretMemoryPosts = useMemo(() =>
    posts.filter(p => p.isSecretMemory).sort((a, b) => a.createdAt - b.createdAt),
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
      <div className="relative w-full shrink-0" style={{ marginBottom: signature ? 28 : 16 }}>
        {/* 背景图区域 */}
        <div
          className="relative w-full cursor-pointer"
          style={{ height: COVER_HEIGHT }}
          onClick={() => handleCoverUpload(mode)}
        >
          <div
            className="absolute inset-0 bg-gradient-to-b from-slate-700 to-slate-900"
            style={coverImage ? {
              backgroundImage: `url(${coverImage})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
            } : {}}
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-black/10 pointer-events-none" />
        </div>

        {/* 头像 + ID：ID 在头像左边，底部对齐；头像底部相对背景图探出（露出比例由 AVATAR_BOTTOM 控制） */}
        <div className="absolute right-4 flex items-end gap-3" style={{ bottom: AVATAR_BOTTOM }}>
          <div className="text-right self-center pb-1">
            <div className="text-white font-bold text-[16px] drop-shadow-lg">{name}</div>
          </div>
          <div
            className="shrink-0 overflow-hidden shadow-lg"
            style={{
              width: 60,
              height: 60,
              borderRadius: 12,
              border: '2px solid rgba(255,255,255,0.3)',
            }}
          >
            {avatar
              ? <TokenImg value={avatar} className="w-full h-full object-cover" />
              : <div className="w-full h-full bg-slate-600" />
            }
          </div>
        </div>

        {/* 个性签名：在头像下方 */}
        {signature && (
          <div
            className="absolute right-5 text-xs text-white/50 drop-shadow"
            style={{ bottom: SIGNATURE_BOTTOM }}
          >
            {signature}
          </div>
        )}
      </div>
    );
  };

  // ==================== 渲染：音乐卡片 ====================

  /**
   * 点朋友圈里的音乐卡片：关掉朋友圈、打开音乐 App 并自动播放这首歌（不在原地出声）。
   * 用 localStorage 存一个一次性的"待播放"标记，音乐 App 挂载时读到就播放、随即清掉，
   * 这是项目里"跨 App 传参"的既有模式（参考查手机跳转 TA 朋友圈那个 moments_open_ta）。
   */
  const handlePlayMusicCard = useCallback((music: MomentMusicCard) => {
    if (!music.songId) {
      addToast('这首歌没有可播放的信息', 'info');
      return;
    }
    localStorage.setItem('music_autoplay_song', JSON.stringify({
      id: music.songId,
      name: music.songName || '未知歌曲',
      artists: music.artists || '未知歌手',
      albumPic: music.albumPic || '',
    }));
    closeApp();
    openApp(AppID.Music);
  }, [addToast, closeApp, openApp]);

  const renderMusicCard = (music: MomentMusicCard) => (
    <div
      className="flex items-center gap-3 rounded-xl p-3 mt-2 cursor-pointer active:scale-[0.98] transition-transform"
      style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)' }}
      onClick={() => handlePlayMusicCard(music)}
    >      {music.albumPic
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

  const renderImageGrid = (images: string[], postId: string) => {
    const count = images.length;
    const cols = count === 1 ? 1 : count <= 4 ? 2 : 3;
    return (
      <div className={`grid gap-1 mt-2`} style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
        {images.map((img, i) => {
          const key = `${postId}:${i}`;
          const broken = brokenImageKeys.has(key);
          const retrying = retryingImageKeys.has(key);
          return (
            <div key={i} className="relative aspect-square rounded-lg overflow-hidden bg-slate-800">
              <TokenImg
                value={img}
                className="w-full h-full object-cover"
                style={broken ? { visibility: 'hidden' } : undefined}
                onError={() => setBrokenImageKeys(prev => new Set(prev).add(key))}
                onLoad={() => setBrokenImageKeys(prev => {
                  if (!prev.has(key)) return prev;
                  const next = new Set(prev);
                  next.delete(key);
                  return next;
                })}
              />
              {broken && (
                <button
                  onClick={() => handleRetryImage(postId, i)}
                  disabled={retrying}
                  className="absolute inset-0 flex items-center justify-center bg-black/40 active:scale-90 transition disabled:opacity-60"
                >
                  <ArrowsClockwise size={24} className="text-white" style={retrying ? { animation: 'spin 1s linear infinite' } : undefined} />
                </button>
              )}
            </div>
          );
        })}
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
                  onClick={() => handleTextDoubleTap(post.id)}
                >
                  {post.text}
                </div>
              )
            )}

            {/* 图片 */}
            {post.images && post.images.length > 0 && renderImageGrid(post.images, post.id)}

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
                  onClick={() => handleForwardToChat(post)}
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
                  const swipeKey = `${post.id}:${c.id}`;
                  const isSwipedOpen = swipedCommentKey === swipeKey;
                  // ID 实时读取：不用评论创建那一刻存的快照名字，改朋友圈昵称/角色名后旧评论也跟着变。
                  const liveAuthorName = c.author === 'user'
                    ? (settings?.userNickname || userProfile.name || '我')
                    : (char?.name || c.authorName);
                  const liveReplyToName = !c.replyTo ? undefined
                    : c.replyToAuthor === 'user'
                      ? (settings?.userNickname || userProfile.name || '我')
                      : c.replyToAuthor
                        ? (char?.name || c.replyToName)
                        : c.replyToName;
                  return (
                    <div key={c.id} className="text-xs leading-relaxed relative overflow-hidden">
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
                        <div className="relative">
                          {/* 左滑露出的垃圾桶：常驻在内容层下方，滑开后才可见/可点 */}
                          <button
                            onClick={() => handleDeleteComment(post.id, c.id)}
                            className="absolute right-0 top-0 bottom-0 flex items-center justify-center px-3 bg-red-500/90 rounded-r"
                            style={{
                              opacity: isSwipedOpen ? 1 : 0,
                              pointerEvents: isSwipedOpen ? 'auto' : 'none',
                              transition: 'opacity 0.15s',
                            }}
                          >
                            <Trash size={14} weight="fill" className="text-white" />
                          </button>
                          <div
                            className="cursor-pointer relative"
                            style={{
                              transform: isSwipedOpen ? 'translateX(-52px)' : 'translateX(0)',
                              transition: 'transform 0.2s ease-out',
                              background: 'inherit',
                            }}
                            onTouchStart={(e) => {
                              const startX = e.touches[0].clientX;
                              const startY = e.touches[0].clientY;
                              const handleMove = (moveEvent: TouchEvent) => {
                                const dx = moveEvent.touches[0].clientX - startX;
                                const dy = moveEvent.touches[0].clientY - startY;
                                // 只处理左滑（dx < 0），且横向位移明显大于纵向，避免和纵向滚动打架
                                if (dx < -16 && Math.abs(dx) > Math.abs(dy)) {
                                  setSwipedCommentKey(swipeKey);
                                } else if (dx > 16) {
                                  setSwipedCommentKey(prev => prev === swipeKey ? null : prev);
                                }
                              };
                              const handleEnd = () => {
                                document.removeEventListener('touchmove', handleMove);
                                document.removeEventListener('touchend', handleEnd);
                              };
                              document.addEventListener('touchmove', handleMove, { passive: true });
                              document.addEventListener('touchend', handleEnd, { once: true });
                            }}
                            onClick={() => {
                              if (isSwipedOpen) { setSwipedCommentKey(null); return; }
                              // 单击先延迟触发"回复"，若阈值内等到第二下则改为触发"编辑"（双击两下才编辑，避免误触）。
                              handleCommentTap(post.id, c.id, () => {
                                setActiveCommentPostId(post.id);
                                setReplyTarget({ id: c.id, name: liveAuthorName });
                                setTimeout(() => commentInputRef.current?.focus(), 100);
                              });
                            }}
                          >
                            <div>
                              <span style={{ color: '#93c5fd' }} className="font-medium">{liveAuthorName}</span>
                              {liveReplyToName && (
                                <>
                                  <span style={{ color: 'var(--moments-text-secondary, #64748b)' }}> 回复 </span>
                                  <span style={{ color: '#93c5fd' }} className="font-medium">{liveReplyToName}</span>
                                </>
                              )}
                              <span style={{ color: 'var(--moments-text-secondary, #64748b)' }}>：</span>
                              <span style={{ color: 'var(--moments-text, #cbd5e1)' }}>{c.content}</span>
                            </div>
                            <div className="text-[10px] mt-0.5" style={{ color: 'var(--moments-text-secondary, #64748b)' }}>
                              {formatTime(c.createdAt)}
                            </div>
                          </div>
                        </div>
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
          <button onClick={() => {
            setView('main');
            setComposeType(null);
            setComposeMusicName('');
            setComposeMusicArtist('');
            setComposeMusicCover('');
            setComposeMusicSongId(null);
            setComposeMusicLinkInput('');
            setMusicParseError('');
          }} className="text-white/60 active:scale-90">
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
              <div>
                <input
                  value={composeMusicLinkInput}
                  onChange={e => { setComposeMusicLinkInput(e.target.value); handleMusicCoverInputChange(e.target.value); }}
                  placeholder="粘贴网易云歌曲链接（长链接或分享短链），自动识别歌名/歌手/封面"
                  className="w-full px-3 py-2 rounded-lg bg-white/10 text-sm text-white/90 border border-white/10 placeholder:text-white/30"
                  autoFocus
                />
                {musicParsing && <div className="text-[11px] text-white/40 mt-1">识别中…</div>}
                {!musicParsing && musicParseError && <div className="text-[11px] text-rose-400 mt-1">{musicParseError}</div>}
                {!musicParsing && !musicParseError && composeMusicSongId && (
                  <div className="text-[11px] text-emerald-400 mt-1">已识别 ✓ 也可以在下面手动微调</div>
                )}
              </div>
              <input
                value={composeMusicName}
                onChange={e => { setComposeMusicName(e.target.value); setComposeMusicSongId(null); }}
                placeholder="歌名（识别后自动填入，也可手动输入）"
                className="w-full px-3 py-2 rounded-lg bg-white/10 text-sm text-white/90 border border-white/10 placeholder:text-white/30"
              />
              <input
                value={composeMusicArtist}
                onChange={e => { setComposeMusicArtist(e.target.value); setComposeMusicSongId(null); }}
                placeholder="歌手"
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
            <label className="text-xs text-white/50 mb-1 block">我的个性签名（最多 30 字）</label>
            <input
              value={settings.userSignature || ''}
              onChange={e => setSettings({ ...settings, userSignature: e.target.value.slice(0, 30) })}
              placeholder="写点什么..."
              maxLength={30}
              className="w-full px-3 py-2 rounded-lg bg-white/10 text-sm text-white/90 border border-white/10"
            />
            <div className="text-[10px] text-white/30 text-right mt-0.5">{(settings.userSignature || '').length}/30</div>
          </div>

          {/* TA 的个性签名 */}
          <div>
            <label className="text-xs text-white/50 mb-1 block">TA 的个性签名（最多 30 字）</label>
            <input
              value={settings.taSignature || ''}
              onChange={e => setSettings({ ...settings, taSignature: e.target.value.slice(0, 30) })}
              placeholder="写点什么..."
              maxLength={30}
              className="w-full px-3 py-2 rounded-lg bg-white/10 text-sm text-white/90 border border-white/10"
            />
            <div className="text-[10px] text-white/30 text-right mt-0.5">{(settings.taSignature || '').length}/30</div>
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

          {/* TA 更新朋友圈的频率 */}
          <div>
            <label className="text-xs text-white/50 mb-1 block">TA 更新朋友圈的频率</label>
            <div className="flex flex-wrap items-center gap-2">
              {([
                { value: '5min', label: '5mins' },
                { value: '30min', label: '30mins' },
                { value: '1h', label: '1h' },
                { value: '2h', label: '2h' },
                { value: 'paused', label: '暂停营业' },
              ] as { value: MomentUpdateFrequency; label: string }[]).map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => setSettings({ ...settings, updateFrequency: value })}
                  className="px-3.5 py-2 rounded-lg text-xs transition"
                  style={{
                    background: settings.updateFrequency === value ? (value === 'paused' ? '#ef4444' : '#3b82f6') : 'rgba(255,255,255,0.08)',
                    color: settings.updateFrequency === value ? 'white' : '#94a3b8',
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {settings.updateFrequency === 'paused' && (
              <div className="text-[11px] text-white/40 mt-1.5 leading-relaxed">
                暂停营业期间，打开朋友圈 / 从查手机跳转都不会触发 TA 更新动态或回复评论。
                TA 朋友圈页面的🔄按钮也会禁用；但🌼秘密空间依然可以查看 TA 更早以前的心事。
              </div>
            )}
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

  // ==================== 渲染：🌼 秘密空间 ====================

  const renderSecretSpace = () => {
    const name = settings?.secretSpaceName || '对花说的事';
    const signature = settings?.secretSpaceSignature || '';
    const coverImage = settings?.secretSpaceCoverImage;

    const handleStartEditSecretSpace = () => {
      setSecretSpaceNameDraft(settings?.secretSpaceName || '');
      setSecretSpaceSignatureDraft(settings?.secretSpaceSignature || '');
      setSecretSpaceEditing(true);
    };

    const handleSaveSecretSpaceEdit = async () => {
      if (!settings) return;
      const updated = {
        ...settings,
        secretSpaceName: secretSpaceNameDraft.trim(),
        secretSpaceSignature: secretSpaceSignatureDraft.trim().slice(0, 30),
      };
      await saveMomentSettings(updated);
      setSettings(updated);
      setSecretSpaceEditing(false);
      addToast('已保存', 'success');
    };

    return (
      <div className="flex flex-col h-full" style={{ background: '#0f0f1a', color: '#e2e8f0' }}>
        <div className="relative flex items-center justify-between px-4 py-2 shrink-0" style={{ background: 'rgba(15,15,26,0.95)' }}>
          <button onClick={() => setView('taPage')} className="text-white/60 active:scale-90 transition">
            <CaretLeft size={22} />
          </button>
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-sm font-medium text-white/80 whitespace-nowrap">🌼 对花说的事</div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleStartEditSecretSpace}
              className="text-xs text-white/60 active:scale-90 transition"
            >
              编辑
            </button>
            <button
              onClick={handleRefreshSecretSpace}
              disabled={secretSpaceRefreshing}
              className="text-xs text-white/60 active:scale-90 transition disabled:opacity-40"
            >
              {secretSpaceRefreshing ? '生成中…' : '换个心情'}
            </button>
          </div>
        </div>

        {/* 内联编辑面板：名字 + 签名，手动改（换心情会整体覆盖，不锁字段） */}
        {secretSpaceEditing && (
          <div className="px-4 py-3 space-y-2 border-b border-white/10 shrink-0" style={{ background: 'rgba(255,255,255,0.03)' }}>
            <input
              value={secretSpaceNameDraft}
              onChange={e => setSecretSpaceNameDraft(e.target.value)}
              placeholder="这个空间里的称呼"
              className="w-full px-3 py-2 rounded-lg bg-white/10 text-sm text-white/90 border border-white/10 placeholder:text-white/30"
            />
            <input
              value={secretSpaceSignatureDraft}
              onChange={e => setSecretSpaceSignatureDraft(e.target.value.slice(0, 30))}
              placeholder="一句签名（最多 30 字）"
              maxLength={30}
              className="w-full px-3 py-2 rounded-lg bg-white/10 text-sm text-white/90 border border-white/10 placeholder:text-white/30"
            />
            <div className="text-[10px] text-white/30 text-right">{secretSpaceSignatureDraft.length}/30</div>
            <div className="flex gap-2">
              <button onClick={handleSaveSecretSpaceEdit} className="flex-1 py-2 rounded-lg text-sm font-medium bg-blue-500 text-white active:scale-95 transition">保存</button>
              <button onClick={() => setSecretSpaceEditing(false)} className="flex-1 py-2 rounded-lg text-sm bg-white/10 text-white/60 active:scale-95 transition">取消</button>
            </div>
          </div>
        )}

        <div ref={scrollRef} className="flex-1 overflow-y-auto no-scrollbar overscroll-contain">
          {/* 封面：背景可点击上传；名字/签名点上面"编辑"手动改，或"换个心情"整体重新生成 */}
          <div className="relative w-full shrink-0" style={{ marginBottom: signature ? 28 : 16 }}>
            <div
              className="relative w-full cursor-pointer"
              style={{ height: COVER_HEIGHT }}
              onClick={() => handleCoverUpload('secret')}
            >
              <div
                className="absolute inset-0 bg-gradient-to-b from-purple-900/60 to-slate-900"
                style={coverImage ? {
                  backgroundImage: `url(${coverImage})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                } : {}}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-black/10 pointer-events-none" />
            </div>
            <div className="absolute right-4 flex items-end gap-3" style={{ bottom: AVATAR_BOTTOM }}>
              <div className="text-right self-center pb-1">
                <div className="text-white font-bold text-[16px] drop-shadow-lg">{name}</div>
              </div>
              <div
                className="shrink-0 overflow-hidden shadow-lg"
                style={{ width: 60, height: 60, borderRadius: 12, border: '2px solid rgba(255,255,255,0.3)' }}
              >
                {charAvatar
                  ? <TokenImg value={charAvatar} className="w-full h-full object-cover" />
                  : <div className="w-full h-full bg-slate-600" />
                }
              </div>
            </div>
            {signature && (
              <div className="absolute right-5 text-xs text-white/50 drop-shadow" style={{ bottom: SIGNATURE_BOTTOM }}>
                {signature}
              </div>
            )}
          </div>

          {/* 历史动态列表：只来自"暂停营业"下🔄生成的秘密动态，按时间正序排列 */}
          <div className="px-3 pb-6">
            {secretMemoryPosts.length === 0 ? (
              <div className="text-center text-white/30 text-xs py-16">
                还没有翻到 {charName} 更早以前的心事<br />去 TA 的朋友圈点🔄看看吧
              </div>
            ) : (
              secretMemoryPosts.map(renderPost)
            )}
          </div>
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
  if (view === 'secretSpace') return renderSecretSpace();

  const isTA = view === 'taPage';
  const displayPosts = isTA ? taPosts : visiblePosts;

  return (
    <div className="flex flex-col h-full" style={{ background: '#0f0f1a', color: '#e2e8f0' }}>
      {/* 顶栏 */}
      <div className="relative flex items-center justify-between px-4 py-2 shrink-0" style={{ background: 'rgba(15,15,26,0.95)' }}>
        <button
          onClick={() => { if (isTA) setView('main'); else closeApp(); }}
          className="text-white/60 active:scale-90 transition"
        >
          <CaretLeft size={22} />
        </button>

        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-sm font-medium text-white/80 whitespace-nowrap">
          {isTA ? `${charName} 的朋友圈` : '朋友圈'}
        </div>

        <div className="flex items-center gap-4">
          {isTA ? (
            /* TA 页面：🌼 秘密空间入口 + 刷新（暂停营业下🔄改为触发"历史动态生成"，同时归档进🌼） */
            <>
              <button
                className="text-white/60 active:scale-90 transition"
                title="秘密空间"
                onClick={() => setView('secretSpace')}
              >
                <span style={{ fontSize: 20, lineHeight: 1 }}>🌼</span>
              </button>
              <button
                className="text-white/60 active:scale-90 transition"
                style={generating ? { animation: 'spin 1s linear infinite' } : {}}
                title={settings?.updateFrequency === 'paused' ? '翻出 TA 更早以前的心事' : '让 TA 更新动态'}
                disabled={generating}
                onClick={() => handleGenerate(true)}
              >
                <ArrowsClockwise size={20} />
              </button>
            </>
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

        {/* AI 生成中提示 */}
        {generating && (
          <div className="flex items-center justify-center gap-2 py-3 text-white/40 text-xs">
            <ArrowsClockwise size={14} style={{ animation: 'spin 1s linear infinite' }} />
            <span>{charName} 正在更新朋友圈…</span>
          </div>
        )}

        {/* 动态列表 */}
        {loading ? (
          <div className="flex items-center justify-center py-12 text-white/30 text-sm">加载中...</div>
        ) : displayPosts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-white/30">
            <div className="text-sm">
              {generating
                ? `${charName} 正在思考发什么…`
                : isTA
                  ? `${charName} 还没发过动态`
                  : '还没有动态'
              }
            </div>
            {!isTA && !generating && (
              <button
                onClick={() => setShowComposeMenu(true)}
                className="mt-3 text-xs text-blue-400 active:scale-90 transition"
              >
                发布第一条朋友圈
              </button>
            )}
            {isTA && !generating && apiConfig.apiKey && (
              <button
                onClick={() => handleGenerate(true)}
                className="mt-3 text-xs text-blue-400 active:scale-90 transition"
              >
                让 {charName} 发一条
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
