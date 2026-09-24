import React, { useState } from 'react';
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
}

/** [交接5 4.12] 论坛热度滑动条(1-10) + 温和清空(需二次确认，一键清空全部本轮不做)。 */
const ForumSettingsPanel: React.FC<Props> = ({ heatLevel, onHeatLevelChange, darkMode, onDarkModeToggle }) => {
  const { addToast } = useOS();
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  /** 图片清理的二次确认：null=没在确认，'posts'=只清帖子配图，'all'=连头像背景一起清。 */
  const [confirmingImagePurge, setConfirmingImagePurge] = useState<null | 'posts' | 'all'>(null);
  const [purgingImages, setPurgingImages] = useState(false);

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
          决定帖子刷新按钮每次从"垫底"队列里最多接几条路人回复（数值越大越热闹，@TA的楼不受这个限制，必回）。
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
