import React from 'react';
import { MusicNote } from '@phosphor-icons/react';
import type { ForumMusicCard as ForumMusicCardData } from '../../utils/forumDb';
import { AppID } from '../../types';
import { useOS } from '../../context/OSContext';

interface Props {
  music: ForumMusicCardData;
  /**
   * 点了跳去音乐 App 播放。默认关着——发帖界面的预览卡不该能点，
   * 帖子列表里的卡也不该（点它应该是进帖子详情，不是被弹去音乐 App）。
   * 只有详情页那张传 true。
   */
  playable?: boolean;
}

/**
 * 论坛音乐卡片。样式和交互都照着朋友圈那张来（封面 + 歌名 + 歌手 + 音符），
 * 只是配色换成跟着论坛主题变量走，深浅色都能看。
 *
 * 播放的实现跟朋友圈一模一样：把歌塞进 localStorage 的 music_autoplay_song，
 * 关掉当前 App 再打开音乐 App，由音乐 App 自己读这个键接着播。
 */
const ForumMusicCard: React.FC<Props> = ({ music, playable }) => {
  const { addToast, closeApp, openApp } = useOS();

  const handlePlay = () => {
    if (!playable) return;
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
  };

  return (
    <div
      onClick={handlePlay}
      className={`flex items-center gap-3 rounded-xl p-2.5 mt-2 ${playable ? 'cursor-pointer active:scale-[0.98] transition-transform' : ''}`}
      style={{ background: 'rgba(127,127,127,0.12)', border: '1px solid rgba(127,127,127,0.15)' }}
    >
      {music.albumPic
        ? <img src={music.albumPic} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0" />
        : (
          <div className="w-12 h-12 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(127,127,127,0.2)' }}>
            <MusicNote size={20} style={{ opacity: 0.4 }} />
          </div>
        )}
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium truncate">{music.songName || '未知歌曲'}</div>
        <div className="text-[11px] opacity-50 mt-0.5 truncate">{music.artists || '未知歌手'}</div>
      </div>
      <MusicNote size={18} weight="fill" style={{ opacity: 0.3 }} className="shrink-0" />
    </div>
  );
};

export default ForumMusicCard;
