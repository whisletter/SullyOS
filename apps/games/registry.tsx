// ═══════════════════════════════════════════════════════════════════════════
// 🎮 游戏大厅的游戏列表
//   · 每个小游戏一个文件夹（./monopoly、./turtle-soup …），自己管自己。
//   · 加新游戏：建文件夹 → 默认导出一个 React.FC<{ onBack: () => void }> → 在下面加一行。
//   · component 用 React.lazy：点开才加载，大富翁 500KB 的卡库不会拖慢 App 启动。
//   · 没有 component 的游戏只显示图标，点了没反应（还没做）。
//   · 小游戏共用的：../shared/ai.ts（调 AI）、chatMirror.ts（写聊天记录→记忆宫殿）、profile.ts（读名字性别人设）
// ═══════════════════════════════════════════════════════════════════════════

import React from 'react';

export interface GameProps { onBack: () => void }
export interface GameEntry {
  id: string;
  name: string;
  icon: string;
  component?: React.ComponentType<GameProps>;
}

export const GAMES: GameEntry[] = [
  { id: 'monopoly', name: '大富翁', icon: '🎮', component: React.lazy(() => import('./monopoly/MonopolyGame')) },
  { id: 'truth_or_dare', name: 'T&D', icon: '🎮' },
  { id: 'witch_poison', name: '女巫的毒药', icon: '🎮' },
  { id: 'turtle_soup', name: '海龟汤', icon: '🎮' },
  { id: 'tarot', name: 'Tarot', icon: '🎮', component: React.lazy(() => import('./tarot/TarotApp')) },
  { id: 'guess', name: '猜猜看', icon: '🎮' },
];
