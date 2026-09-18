import React, { useRef, useState } from 'react';
import { Plus, X, TextAa, ImageSquare, MusicNotes, Article } from '@phosphor-icons/react';
import { FORUM_TOPIC_TAGS, type ForumTopicTag } from '../../utils/forumConstants';
import * as db from '../../utils/forumDb';
import * as feed from '../../utils/forumFeed';
import { filesToForumImageTokens, FORUM_MAX_POST_IMAGES } from '../../utils/forumImagePick';
import TokenImg from '../../components/os/TokenImg';
import { useOS } from '../../context/OSContext';
import { pinForumPostIfEligible } from '../../utils/forumMemoryBridge';

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
  const [composeType, setComposeType] = useState<ComposeType>('text');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [musicUrl, setMusicUrl] = useState('');
  const [articleUrl, setArticleUrl] = useState('');
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

  const removeImage = (index: number) => {
    // 只摘引用，不删 Blob：同一张图可能被别处引用着，孤儿统一交给存储面板的 GC 收口。
    setImages(prev => prev.filter((_, i) => i !== index));
  };

  const buildContent = (): string => {
    if (composeType === 'text') return text.slice(0, 10000);
    if (composeType === 'image') return text.trim();
    if (composeType === 'music') return `[分享音乐] ${musicUrl}${text ? `\n${text}` : ''}`;
    return `[分享文章] ${articleUrl}${text ? `\n${text}` : ''}`;
  };

  const handleSubmit = async () => {
    const content = buildContent();
    // 图片贴允许没配文——有图就算有内容，跟朋友圈一致。
    if (!content.trim() && !(composeType === 'image' && images.length > 0)) {
      addToast('内容不能是空的', 'info');
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
            <input value={musicUrl} onChange={e => setMusicUrl(e.target.value)} placeholder="音乐链接" className="w-full px-3 py-2 rounded-lg text-sm outline-none" style={{ background: 'rgba(127,127,127,0.1)' }} />
            <textarea value={text} onChange={e => setText(e.target.value)} placeholder="想说的话（可选）" rows={3}
                      className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-none" style={{ background: 'rgba(127,127,127,0.1)' }} />
          </div>
        )}

        {composeType === 'article' && (
          <div className="space-y-2">
            <input value={articleUrl} onChange={e => setArticleUrl(e.target.value)} placeholder="文章链接" className="w-full px-3 py-2 rounded-lg text-sm outline-none" style={{ background: 'rgba(127,127,127,0.1)' }} />
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
