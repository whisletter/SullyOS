import React, { useState } from 'react';
import { FORUM_TOPIC_TAGS, type ForumTopicTag } from '../../utils/forumConstants';
import * as db from '../../utils/forumDb';
import * as feed from '../../utils/forumFeed';
import { useOS } from '../../context/OSContext';

interface Props {
  activeAccount: db.ForumAccount;
  onDone: () => void;
}

type ComposeType = 'text' | 'image' | 'music' | 'article';

/**
 * [交接5 4.2] 四选一（不是四合一），字段跟朋友圈一致：文本1万字封顶（论坛长文用，
 * 比朋友圈原本的短状态更新上限大得多）/ 图片最多9张 / 音乐URL / 文章URL。
 * 用户发布的内容一律 postKind='organic'（不是抓取真实新闻，谈不上news贴）。
 */
const ForumCompose: React.FC<Props> = ({ activeAccount, onDone }) => {
  const { addToast } = useOS();
  const [composeType, setComposeType] = useState<ComposeType>('text');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [imageUrls, setImageUrls] = useState<string[]>([]);
  const [musicUrl, setMusicUrl] = useState('');
  const [articleUrl, setArticleUrl] = useState('');
  const [topicTag, setTopicTag] = useState<ForumTopicTag>('daily_chatter');
  const [submitting, setSubmitting] = useState(false);

  const buildContent = (): string => {
    if (composeType === 'text') return text.slice(0, 10000);
    if (composeType === 'image') return `${text}\n${imageUrls.filter(Boolean).map(u => `[图片] ${u}`).join('\n')}`.trim();
    if (composeType === 'music') return `[分享音乐] ${musicUrl}${text ? `\n${text}` : ''}`;
    return `[分享文章] ${articleUrl}${text ? `\n${text}` : ''}`;
  };

  const handleSubmit = async () => {
    const content = buildContent();
    if (!content.trim()) { addToast('内容不能是空的', 'info'); return; }
    setSubmitting(true);
    try {
      const now = Date.now();
      await feed.createPost({
        id: db.createForumPostId(),
        authorAccountId: activeAccount.id,
        postKind: 'organic',
        topicTag,
        title: title.slice(0, 100),
        content,
        createdAt: now,
        lastActivityAt: now,
        isCollected: false,
        involvesCharInteraction: false,
        isOwnedByUserSide: true,
        likes: [],
        visibility: 'public',
      });
      addToast('发布成功', 'success');
      onDone();
    } finally {
      setSubmitting(false);
    }
  };

  const TypeTab: React.FC<{ type: ComposeType; label: string }> = ({ type, label }) => (
    <button
      onClick={() => setComposeType(type)}
      className="px-3 py-1.5 rounded-full text-sm"
      style={{ background: composeType === type ? '#3b82f6' : 'rgba(127,127,127,0.12)', color: composeType === type ? '#fff' : 'inherit' }}
    >
      {label}
    </button>
  );

  return (
    <div className="px-4 py-4 space-y-4">
      <div className="flex gap-2">
        <TypeTab type="text" label="文本" />
        <TypeTab type="image" label="图片" />
        <TypeTab type="music" label="音乐" />
        <TypeTab type="article" label="文章" />
      </div>

      <select value={topicTag} onChange={e => setTopicTag(e.target.value as ForumTopicTag)} className="w-full px-3 py-2 rounded-lg text-sm" style={{ background: 'rgba(127,127,127,0.1)' }}>
        {FORUM_TOPIC_TAGS.map(t => <option key={t.tag} value={t.tag}>{t.label}</option>)}
      </select>

      <input value={title} onChange={e => setTitle(e.target.value)} placeholder="标题（可选）" className="w-full px-3 py-2 rounded-lg text-sm outline-none" style={{ background: 'rgba(127,127,127,0.1)' }} />

      {composeType === 'text' && (
        <textarea value={text} onChange={e => setText(e.target.value.slice(0, 10000))} placeholder="说点什么…（最多1万字）" rows={8}
                  className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-none" style={{ background: 'rgba(127,127,127,0.1)' }} />
      )}
      {composeType === 'image' && (
        <div className="space-y-2">
          <textarea value={text} onChange={e => setText(e.target.value)} placeholder="配文（可选）" rows={3}
                    className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-none" style={{ background: 'rgba(127,127,127,0.1)' }} />
          {Array.from({ length: 9 }).map((_, i) => (
            <input key={i} value={imageUrls[i] || ''} onChange={e => { const next = [...imageUrls]; next[i] = e.target.value; setImageUrls(next); }}
                   placeholder={`图片链接 ${i + 1}（最多9张）`} className="w-full px-3 py-2 rounded-lg text-sm outline-none" style={{ background: 'rgba(127,127,127,0.1)' }} />
          ))}
        </div>
      )}
      {composeType === 'music' && (
        <input value={musicUrl} onChange={e => setMusicUrl(e.target.value)} placeholder="音乐URL" className="w-full px-3 py-2 rounded-lg text-sm outline-none" style={{ background: 'rgba(127,127,127,0.1)' }} />
      )}
      {composeType === 'article' && (
        <input value={articleUrl} onChange={e => setArticleUrl(e.target.value)} placeholder="文章URL" className="w-full px-3 py-2 rounded-lg text-sm outline-none" style={{ background: 'rgba(127,127,127,0.1)' }} />
      )}

      <button onClick={handleSubmit} disabled={submitting} className="w-full py-2.5 rounded-full font-bold text-sm disabled:opacity-40" style={{ background: '#3b82f6', color: '#fff' }}>
        {submitting ? '发布中…' : '发布'}
      </button>
    </div>
  );
};

export default ForumCompose;
