import React, { useEffect, useState } from 'react';
import * as db from '../../utils/forumDb';
import * as feed from '../../utils/forumFeed';
import { FORUM_DEFAULTS } from '../../utils/forumConstants';
import { useOS } from '../../context/OSContext';
import ForumDiagnostics from './ForumDiagnostics';

interface Props {
  heatLevel: number;
  onHeatLevelChange: (level: number) => void;
  darkMode: boolean;
  onDarkModeToggle: () => void;
  /** 当前身份账号 id。论坛设置是按这个 id 存的，读写都要用。 */
  activeAccountId: string;
  /** 论坛专用 API 存好之后回传给外壳，让它立刻换用，不用退出重进。 */
  onApiOverrideChange?: (override: { baseUrl: string; apiKey: string; model: string } | null) => void;
}

/** [交接5 4.12] 论坛热度滑动条(1-10) + 温和清空(需二次确认，一键清空全部本轮不做)。 */
const ForumSettingsPanel: React.FC<Props> = ({ heatLevel, onHeatLevelChange, darkMode, onDarkModeToggle, activeAccountId, onApiOverrideChange }) => {
  const { addToast } = useOS();
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  /** 图片清理的二次确认：null=没在确认，'posts'=只清帖子配图，'all'=连头像背景一起清。 */
  const [confirmingImagePurge, setConfirmingImagePurge] = useState<null | 'posts' | 'all'>(null);
  const [purgingImages, setPurgingImages] = useState(false);

  // 论坛专用 API
  const [apiEnabled, setApiEnabled] = useState(false);
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiModel, setApiModel] = useState('');
  const [apiSaving, setApiSaving] = useState(false);
  const [apiLoaded, setApiLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const settings = await db.getForumSettings(activeAccountId);
        if (cancelled) return;
        setApiEnabled(!!settings.apiOverrideEnabled);
        setApiBaseUrl(settings.apiOverrideBaseUrl || '');
        setApiKey(settings.apiOverrideApiKey || '');
        setApiModel(settings.apiOverrideModel || '');
      } finally {
        if (!cancelled) setApiLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [activeAccountId]);

  const apiComplete = !!(apiBaseUrl.trim() && apiKey.trim() && apiModel.trim());

  const handleSaveApi = async () => {
    setApiSaving(true);
    try {
      const settings = await db.getForumSettings(activeAccountId);
      await db.saveForumSettings({
        ...settings,
        apiOverrideEnabled: apiEnabled,
        apiOverrideBaseUrl: apiBaseUrl.trim(),
        apiOverrideApiKey: apiKey.trim(),
        apiOverrideModel: apiModel.trim(),
        updatedAt: Date.now(),
      });
      onApiOverrideChange?.(
        apiEnabled && apiComplete
          ? { baseUrl: apiBaseUrl.trim(), apiKey: apiKey.trim(), model: apiModel.trim() }
          : null,
      );
      addToast(
        apiEnabled && apiComplete ? '已保存，论坛从现在起用这套 API' : '已保存，论坛继续用聊天那套 API',
        'success',
      );
    } catch (e: any) {
      addToast(`保存失败: ${e?.message?.slice(0, 60) || '未知错误'}`, 'error');
    } finally {
      setApiSaving(false);
    }
  };

  const handleGentleClear = async () => {
    setClearing(true);
    try {
      const { deletedPosts } = await feed.gentleClearNonRetainedContent();
      addToast(`已清空 ${deletedPosts} 条普通内容`, 'success');
    } finally {
      setClearing(false);
      setConfirmingClear(false);
    }
  };

  const handlePurgeImages = async (scope: 'posts' | 'all') => {
    setPurgingImages(true);
    try {
      const r = await db.purgeForumImages({ includeAccountArtwork: scope === 'all' });
      const parts = [`已去掉 ${r.images} 处图片引用`];
      if (r.posts > 0) parts.push(`${r.posts} 条帖子`);
      if (r.accounts > 0) parts.push(`${r.accounts} 个账号`);
      addToast(`${parts.join('，')}。空间要等下一次「孤儿图片清理」才会真的释放`, 'success');
    } catch (e: any) {
      addToast(`清理失败：${e?.message?.slice(0, 60) || '未知错误'}`, 'error');
    } finally {
      setPurgingImages(false);
      setConfirmingImagePurge(null);
    }
  };

  return (
    <div className="px-4 py-4 space-y-6">
      <div>
        <div className="text-sm font-bold mb-1">论坛热度</div>
        <div className="text-[12px] opacity-50 mb-2">
          帖子详情页点刷新时，<b>这个数字 = 这次新开几楼评论</b>。
          其中一部分楼底下会有人接话（每楼 1-3 句），所以实际冒出来的条数会比这个数字多——
          比如 5 就是 5 楼加上 2 楼有人接，一共 7-11 条。
          <br />
          同时它也决定最多接几条"垫底楼"（就是最新一条是你发的、等着人回的楼）。
          @了TA的楼不受这个限制，必回。
        </div>
        <input
          type="range"
          min={FORUM_DEFAULTS.heatLevelMin}
          max={FORUM_DEFAULTS.heatLevelMax}
          value={heatLevel}
          onChange={e => onHeatLevelChange(Number(e.target.value))}
          className="w-full"
        />
        <div className="text-center text-sm font-bold mt-1">{heatLevel}</div>
      </div>

      <div className="flex items-center justify-between">
        <div className="text-sm font-bold">夜间模式</div>
        <button onClick={onDarkModeToggle} className="text-sm px-3 py-1.5 rounded-full" style={{ background: 'rgba(127,127,127,0.15)' }}>
          {darkMode ? '已开启' : '已关闭'}
        </button>
      </div>

      <div>
        <div className="text-sm font-bold mb-1">清理本地存储</div>
        <div className="text-[12px] opacity-50 mb-2">
          只清"没有收藏、没有互动、不是你自己发的"普通内容，你的帖子、收藏、和TA互动过的内容都不受影响。
        </div>
        {!confirmingClear ? (
          <button
            onClick={() => setConfirmingClear(true)}
            className="text-sm px-4 py-2 rounded-full"
            style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}
          >
            温和清空
          </button>
        ) : (
          <div className="text-sm space-y-2">
            <div>确定要清空所有普通内容吗？这个操作不能撤销。</div>
            <div className="flex gap-2">
              <button onClick={handleGentleClear} disabled={clearing} className="px-4 py-2 rounded-full" style={{ background: '#ef4444', color: '#fff' }}>
                {clearing ? '清空中…' : '确定清空'}
              </button>
              <button onClick={() => setConfirmingClear(false)} className="px-4 py-2 rounded-full" style={{ background: 'rgba(127,127,127,0.15)' }}>
                取消
              </button>
            </div>
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <div className="text-sm font-bold">论坛专用 API</div>
          <button
            onClick={() => setApiEnabled(v => !v)}
            className="relative w-11 h-6 rounded-full shrink-0 transition-colors"
            style={{ background: apiEnabled ? '#3b82f6' : 'rgba(127,127,127,0.25)' }}
            aria-label="启用论坛专用 API"
          >
            <span
              className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
              style={{ left: apiEnabled ? '22px' : '2px' }}
            />
          </button>
        </div>
        <div className="text-[12px] opacity-50 mb-2">
          关着的时候论坛跟聊天共用同一套 API。论坛这边调用很密集（批量发帖、评论区刷新、
          TA 发帖），换一个便宜模型跑就够，不用占着聊天那个好模型的额度。
          <b>三项要填全</b>，缺一项就自动退回聊天那套。
        </div>

        {apiEnabled && (
          <div className="space-y-2">
            <input
              value={apiBaseUrl}
              onChange={e => setApiBaseUrl(e.target.value)}
              placeholder="Base URL（例：https://api.openai.com/v1）"
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: 'rgba(127,127,127,0.1)' }}
            />
            <input
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              type="password"
              placeholder="API Key"
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: 'rgba(127,127,127,0.1)' }}
            />
            <input
              value={apiModel}
              onChange={e => setApiModel(e.target.value)}
              placeholder="Model（例：gpt-4o-mini）"
              className="w-full px-3 py-2 rounded-lg text-sm outline-none"
              style={{ background: 'rgba(127,127,127,0.1)' }}
            />
            {!apiComplete && (
              <div className="text-[12px]" style={{ color: '#f59e0b' }}>
                还没填全，现在保存的话论坛仍然走聊天那套 API。
              </div>
            )}
          </div>
        )}

        <button
          onClick={handleSaveApi}
          disabled={apiSaving || !apiLoaded}
          className="mt-2 text-sm px-4 py-2 rounded-full disabled:opacity-40"
          style={{ background: '#3b82f6', color: '#fff' }}
        >
          {apiSaving ? '保存中…' : '保存'}
        </button>
      </div>

      <div>
        <div className="text-sm font-bold mb-1">清理图片</div>
        <div className="text-[12px] opacity-50 mb-2">
          帖子和账号里的图片存在浏览器本地，清掉能腾空间。
          <b>文字内容一个字都不动</b>，只是图没了。注意：这里抹掉的是引用，
          空间要等下一次「孤儿图片清理」扫过才真的释放。不能撤销。
        </div>

        {confirmingImagePurge === null ? (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setConfirmingImagePurge('posts')}
              className="text-sm px-4 py-2 rounded-full"
              style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}
            >
              清掉帖子配图
            </button>
            <button
              onClick={() => setConfirmingImagePurge('all')}
              className="text-sm px-4 py-2 rounded-full"
              style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}
            >
              连头像背景一起清
            </button>
          </div>
        ) : (
          <div className="text-sm space-y-2">
            <div>
              {confirmingImagePurge === 'posts'
                ? '确定清掉所有帖子里的配图吗？包括你自己发的帖，外链图也会一起去掉。'
                : '确定清掉全部图片吗？除了帖子配图，所有账号（你的、TA的、路人的）的头像和背景图也会一并清空。'}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => handlePurgeImages(confirmingImagePurge)}
                disabled={purgingImages}
                className="px-4 py-2 rounded-full disabled:opacity-40"
                style={{ background: '#ef4444', color: '#fff' }}
              >
                {purgingImages ? '清理中…' : '确定清理'}
              </button>
              <button
                onClick={() => setConfirmingImagePurge(null)}
                className="px-4 py-2 rounded-full"
                style={{ background: 'rgba(127,127,127,0.15)' }}
              >
                取消
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="pt-2 border-t" style={{ borderColor: 'rgba(127,127,127,0.15)' }}>
        <ForumDiagnostics />
      </div>
    </div>
  );
};

export default ForumSettingsPanel;
