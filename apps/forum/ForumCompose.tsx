import React, { useRef, useState } from 'react';
import { Plus, X, TextAa, ImageSquare, MusicNotes, Article } from '@phosphor-icons/react';
import { FORUM_TOPIC_TAGS, type ForumTopicTag } from '../../utils/forumConstants';
import * as db from '../../utils/forumDb';
import * as feed from '../../utils/forumFeed';
import { filesToForumImageTokens, FORUM_MAX_POST_IMAGES } from '../../utils/forumImagePick';
import TokenImg from '../../components/os/TokenImg';
import { useOS } from '../../context/OSContext';
import { pinForumPostIfEligible } from '../../utils/forumMemoryBridge';
import { useMusic, musicApi, toHttps } from '../../context/MusicContext';
import { expandShortUrl, extractWebpageContent, detectFirstUrl } from '../../utils/webpageExtractor';
import ForumMusicCard from './ForumMusicCard';
import ForumArticleCard from './ForumArticleCard';

interface Props {
  activeAccount: db.ForumAccount;
  onDone: () => void;
}

type ComposeType = 'text' | 'image' | 'music' | 'article';

/**
 * [交接5 4.2] 四选一（不是四合一），字段跟朋友圈一致：文本1万字封顶（论坛长文用，
 * 比朋友圈原本的短状态更新上限大得多）/ 图片最多9张 / 音乐URL / 文章URL。
 * 用户发布的内容一律 postKind='organic'（不是抓取真实新闻，谈不上news贴）。
 *
 * 布局：整页 h-full 上下分栏 —— 上面滚动填内容，下面是常驻工具条（四个类型 + 发布）。
 * 工具条不是 fixed，而是 flex 列的最后一格：键盘弹出时外壳的 app 高度会跟着可视区变矮
 * （见 utils/iosStandalone.ts），工具条自然贴在键盘上沿；键盘收起就回到页面最底部。
 *
 * 图片走本地相册（processImage 压缩 → blobref 令牌），不再让用户手填图片链接；
 * 图不塞进 content，单独存 post.images，正文喂给 AI 时才不会被一长串令牌污染。
 */
const ForumCompose: React.FC<Props> = ({ activeAccount, onDone }) => {
  const { addToast, characters } = useOS();
  const { cfg: musicCfg } = useMusic();
  const [composeType, setComposeType] = useState<ComposeType>('text');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [musicUrl, setMusicUrl] = useState('');
  const [articleUrl, setArticleUrl] = useState('');
  // 音乐：粘链接自动识别出来的真实歌曲信息（口径跟朋友圈完全一致）
  const [musicCard, setMusicCard] = useState<db.ForumMusicCard | null>(null);
  const [musicParsing, setMusicParsing] = useState(false);
  const [musicParseError, setMusicParseError] = useState('');
  // 文章：粘链接自动抓标题/摘要/封面/正文
  const [articleCard, setArticleCard] = useState<db.ForumArticleCard | null>(null);
  const [articleParsing, setArticleParsing] = useState(false);
  const [articleParseError, setArticleParseError] = useState('');
  const [topicTag, setTopicTag] = useState<ForumTopicTag>('daily_chatter');
  const [submitting, setSubmitting] = useState(false);
  const [picking, setPicking] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handlePickImages = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // 先清空，同一张图连选两次也能再触发 change
    if (files.length === 0) return;
    const room = FORUM_MAX_POST_IMAGES - images.length;
    if (room <= 0) { addToast(`最多 ${FORUM_MAX_POST_IMAGES} 张`, 'info'); return; }
    setPicking(true);
    try {
      const tokens = await filesToForumImageTokens(files, room);
      setImages(prev => [...prev, ...tokens]);
      if (files.length > room) addToast(`最多 ${FORUM_MAX_POST_IMAGES} 张，多出的没加`, 'info');
    } catch (err: any) {
      addToast(err?.message || '图片处理失败', 'error');
    } finally {
      setPicking(false);
    }
  };

  /** 从网易云链接（长链或 163cn.tv 短链展开后）里抠出 songId。跟朋友圈同一条正则。 */
  const extractNeteaseSongId = (url: string): number | null => {
    const match = /[?&#]id=(\d+)/.exec(url) || /\/song\/(\d+)/.exec(url);
    return match ? Number(match[1]) : null;
  };

  /**
   * 粘进来的东西一看像网易云链接就自动识别：短链先展开，抠出 songId 再查 song/detail，
   * 拿**真实**的歌名/歌手/封面。以前这里是把链接原样拼进正文（`[分享音乐] …`），
   * 既渲染不出卡片也点不开，等于按钮在功能不在。
   */
  const handleMusicUrlChange = async (rawInput: string) => {
    setMusicUrl(rawInput);
    setMusicParseError('');
    const trimmed = rawInput.trim();
    if (!trimmed) { setMusicCard(null); return; }

    const looksLikeLink = /^https?:\/\//i.test(trimmed) || /music\.163\.com|163cn\.tv/i.test(trimmed);
    if (!looksLikeLink) { setMusicCard(null); return; }

    setMusicParsing(true);
    try {
      let resolvedUrl = trimmed;
      // 163cn.tv 这类短链里没有 songId，得先跟着重定向展开成长链
      if (/163cn\.tv/i.test(trimmed) && !/music\.163\.com/i.test(trimmed)) {
        resolvedUrl = await expandShortUrl(trimmed);
      }
      const songId = extractNeteaseSongId(resolvedUrl);
      if (!songId) {
        setMusicParseError('没能从链接里识别出歌曲，换个链接试试');
        setMusicCard(null);
        return;
      }
      const detail = await musicApi.call(musicCfg, 'song/detail', { ids: [songId] });
      const song = detail?.songs?.[0];
      if (!song) {
        setMusicParseError('没查到这首歌的信息，可能已下架');
        setMusicCard(null);
        return;
      }
      setMusicCard({
        songId,
        songName: song.name || '未知歌曲',
        artists: (song.ar || song.artists || []).map((a: any) => a.name).filter(Boolean).join(' / ') || '未知歌手',
        albumPic: toHttps(song.al?.picUrl || song.album?.picUrl || ''),
      });
    } catch (e: any) {
      setMusicParseError(`识别失败: ${e?.message?.slice(0, 60) || '未知错误'}`);
      setMusicCard(null);
    } finally {
      setMusicParsing(false);
    }
  };

  /**
   * 文章链接：抓标题/摘要/封面/正文。抓不到也把链接本身留着——你可能就想留个链接、
   * 标题自己手打。正文（fullText）不在卡片上显示，是留给 TA 读的：它要评论一篇文章，
   * 总得先看过内容，不然只能对着标题瞎猜。
   */
  const handleArticleUrlChange = async (rawInput: string) => {
    setArticleUrl(rawInput);
    setArticleParseError('');
    const trimmed = rawInput.trim();
    if (!trimmed) { setArticleCard(null); return; }

    const url = detectFirstUrl(trimmed) || trimmed;
    if (!/^https?:\/\//i.test(url)) { setArticleCard(null); return; }

    setArticleParsing(true);
    try {
      const webpage = await extractWebpageContent(url);
      setArticleCard({
        title: webpage.title || '',
        url: webpage.finalUrl || url,
        body: webpage.excerpt || '',
        image: webpage.image || '',
        fullText: webpage.content || '',
      });
    } catch (e: any) {
      setArticleParseError(`识别失败: ${e?.message?.slice(0, 60) || '这个链接抓不到内容'}`);
      setArticleCard({ title: '', url: trimmed });
    } finally {
      setArticleParsing(false);
    }
  };

  const removeImage = (index: number) => {
    // 只摘引用，不删 Blob：同一张图可能被别处引用着，孤儿统一交给存储面板的 GC 收口。
    setImages(prev => prev.filter((_, i) => i !== index));
  };

  /**
   * 正文。音乐/文章现在有独立字段了，所以正文里只放你自己写的那句话，
   * 不再拼 `[分享音乐] 链接` —— 那串链接既占正文、又会被原样喂给 AI。
   */
  const buildContent = (): string => {
    if (composeType === 'text') return text.slice(0, 10000);
    return text.trim();
  };

  const handleSubmit = async () => {
    const content = buildContent();
    // 图片/音乐/文章贴都允许没配文——有卡片就算有内容，跟朋友圈一致。
    const hasAttachment = (composeType === 'image' && images.length > 0)
      || (composeType === 'music' && !!musicCard)
      || (composeType === 'article' && !!articleCard);
    if (!content.trim() && !hasAttachment) {
      addToast(composeType === 'music' ? '先贴一个音乐链接' : composeType === 'article' ? '先贴一个文章链接' : '内容不能是空的', 'info');
      return;
    }
    setSubmitting(true);
    try {
      const now = Date.now();
      const newPost: db.ForumPost = {
        id: db.createForumPostId(),
        authorAccountId: activeAccount.id,
        postKind: 'organic',
        topicTag,
        title: title.slice(0, 100),
        content,
        images: composeType === 'image' && images.length > 0 ? images : undefined,
        music: composeType === 'music' && musicCard ? musicCard : undefined,
        article: composeType === 'article' && articleCard ? articleCard : undefined,
        createdAt: now,
        lastActivityAt: now,
        isCollected: false,
        involvesCharInteraction: false,
        isOwnedByUserSide: true,
        likes: [],
        visibility: 'public',
      };
      await feed.createPost(newPost);

      // 写即时便利贴，让 TA 在聊天里能提起你刚发的这条。
      // 小号发的不会写进去——那是 pinForumPostIfEligible 里判断的，这里不用分情况调用。
      await pinForumPostIfEligible(newPost, characters || []);

      addToast('发布成功', 'success');
      onDone();
    } finally {
      setSubmitting(false);
    }
  };

  const TypeTab: React.FC<{ type: ComposeType; label: string; icon: React.ElementType }> = ({ type, label, icon: Icon }) => {
    const active = composeType === type;
    return (
      <button
        onClick={() => setComposeType(type)}
        className="flex-1 flex flex-col items-center gap-0.5 py-1.5 rounded-xl active:scale-95 transition-transform"
        style={{ background: active ? 'rgba(59,130,246,0.14)' : 'transparent', color: active ? '#3b82f6' : 'inherit' }}
      >
        <Icon size={20} weight={active ? 'fill' : 'regular'} />
        <span className="text-[11px]" style={{ opacity: active ? 1 : 0.6 }}>{label}</span>
      </button>
    );
  };

  return (
    <div className="h-full flex flex-col">
      {/* 可滚区：键盘弹出时这块被压扁，工具条不动 */}
      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-4 py-4 space-y-3">
        <select value={topicTag} onChange={e => setTopicTag(e.target.value as ForumTopicTag)} className="w-full px-3 py-2 rounded-lg text-sm" style={{ background: 'rgba(127,127,127,0.1)' }}>
          {FORUM_TOPIC_TAGS.map(t => <option key={t.tag} value={t.tag}>{t.label}</option>)}
        </select>

        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="标题（可选）" className="w-full px-3 py-2 rounded-lg text-sm outline-none" style={{ background: 'rgba(127,127,127,0.1)' }} />

        {composeType === 'text' && (
          <textarea value={text} onChange={e => setText(e.target.value.slice(0, 10000))} placeholder="说点什么…（最多1万字）" rows={10}
                    className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-none" style={{ background: 'rgba(127,127,127,0.1)' }} />
        )}

        {composeType === 'image' && (
          <div className="space-y-3">
            <textarea value={text} onChange={e => setText(e.target.value)} placeholder="配文（可选）" rows={3}
                      className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-none" style={{ background: 'rgba(127,127,127,0.1)' }} />

            {/* 九宫格：已选图 + 末尾一个「+」，点了直接开系统相册 */}
            <div className="grid grid-cols-3 gap-2">
              {images.map((img, i) => (
                <div key={`${img}-${i}`} className="relative aspect-square rounded-xl overflow-hidden" style={{ background: 'rgba(127,127,127,0.1)' }}>
                  <TokenImg value={img} className="w-full h-full object-cover" />
                  <button
                    onClick={() => removeImage(i)}
                    className="absolute top-1 right-1 w-6 h-6 rounded-full flex items-center justify-center active:scale-90 transition-transform"
                    style={{ background: 'rgba(0,0,0,0.55)', color: '#fff' }}
                    aria-label="移除这张图"
                  >
                    <X size={13} weight="bold" />
                  </button>
                </div>
              ))}
              {images.length < FORUM_MAX_POST_IMAGES && (
                <button
                  onClick={() => fileRef.current?.click()}
                  disabled={picking}
                  className="aspect-square rounded-xl flex flex-col items-center justify-center gap-1 active:scale-95 transition-transform disabled:opacity-50"
                  style={{ background: 'rgba(127,127,127,0.1)', border: '1px dashed rgba(127,127,127,0.35)' }}
                >
                  <Plus size={22} weight="bold" style={{ opacity: 0.5 }} />
                  <span className="text-[11px] opacity-50">{picking ? '处理中…' : '从相册选择'}</span>
                </button>
              )}
            </div>
            <div className="text-[11px] opacity-40">{images.length}/{FORUM_MAX_POST_IMAGES} 张，图片压缩后存在本机</div>

            <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={handlePickImages} />
          </div>
        )}

        {composeType === 'music' && (
          <div className="space-y-2">
            <input
              value={musicUrl}
              onChange={e => handleMusicUrlChange(e.target.value)}
              placeholder="贴网易云歌曲链接，自动识别"
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: 'rgba(127,127,127,0.1)' }}
            />
            {musicParsing && <div className="text-[12px] opacity-50">识别中…</div>}
            {musicParseError && <div className="text-[12px]" style={{ color: '#ef4444' }}>{musicParseError}</div>}
            {musicCard && <ForumMusicCard music={musicCard} />}
            <textarea value={text} onChange={e => setText(e.target.value)} placeholder="想说的话（可选）" rows={3}
                      className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-none" style={{ background: 'rgba(127,127,127,0.1)' }} />
          </div>
        )}

        {composeType === 'article' && (
          <div className="space-y-2">
            <input
              value={articleUrl}
              onChange={e => handleArticleUrlChange(e.target.value)}
              placeholder="贴文章链接，自动抓标题和摘要"
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: 'rgba(127,127,127,0.1)' }}
            />
            {articleParsing && <div className="text-[12px] opacity-50">抓取中…</div>}
            {articleParseError && <div className="text-[12px]" style={{ color: '#f59e0b' }}>{articleParseError}</div>}
            {articleCard && (
              <>
                <ForumArticleCard article={articleCard} />
                {/* 抓不到标题时给你手填的机会，不至于发出去一张空卡 */}
                {!articleCard.title && (
                  <input
                    value={articleCard.title}
                    onChange={e => setArticleCard({ ...articleCard, title: e.target.value })}
                    placeholder="没抓到标题，自己写一个"
                    className="w-full px-3 py-2 rounded-lg text-sm outline-none"
                    style={{ background: 'rgba(127,127,127,0.1)' }}
                  />
                )}
              </>
            )}
            <textarea value={text} onChange={e => setText(e.target.value)} placeholder="想说的话（可选）" rows={3}
                      className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-none" style={{ background: 'rgba(127,127,127,0.1)' }} />
          </div>
        )}
      </div>

      {/* 常驻工具条：键盘弹出时贴键盘上沿，收起时贴页面底部 */}
      <div
        className="shrink-0 border-t px-2 pt-1.5 flex items-center gap-2"
        style={{
          borderColor: 'rgba(127,127,127,0.18)',
          paddingBottom: 'calc(var(--safe-bottom, 0px) + 6px)',
          background: 'inherit',
        }}
      >
        <div className="flex-1 flex items-center gap-1">
          <TypeTab type="text" label="文本" icon={TextAa} />
          <TypeTab type="image" label="图片" icon={ImageSquare} />
          <TypeTab type="music" label="音乐" icon={MusicNotes} />
          <TypeTab type="article" label="文章" icon={Article} />
        </div>
        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="shrink-0 px-5 py-2 rounded-full font-bold text-sm active:scale-95 transition-transform disabled:opacity-40"
          style={{ background: '#3b82f6', color: '#fff' }}
        >
          {submitting ? '发布中…' : '发布'}
        </button>
      </div>
    </div>
  );
};

export default ForumCompose;
