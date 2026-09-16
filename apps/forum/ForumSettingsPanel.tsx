import React, { useState } from 'react';
import * as feed from '../../utils/forumFeed';
import { FORUM_DEFAULTS } from '../../utils/forumConstants';
import { useOS } from '../../context/OSContext';

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
    </div>
  );
};

export default ForumSettingsPanel;
