import React, { useRef, useState } from 'react';
import { Camera, Trash } from '@phosphor-icons/react';
import * as db from '../../utils/forumDb';
import { filesToForumImageTokens } from '../../utils/forumImagePick';
import TokenImg from '../../components/os/TokenImg';
import { useOS } from '../../context/OSContext';

interface Props {
  account: db.ForumAccount;
  onSaved: (account: db.ForumAccount) => void;
  onClose: () => void;
}

/**
 * [用户确认新增] 编辑资料：头像/背景图/ID(handle)/昵称/个性签名。
 * 只对用户方账号开放（主号/小号/共管账号），调用方负责只在这三种账号上显示入口，
 * 这里不重复校验 ownerType。
 *
 * 头像/背景图都改成点图直接开系统相册（processImage 压缩 → blobref 令牌），
 * 跟朋友圈/档案那套一致，不再手填图片链接。
 */
const ForumEditProfile: React.FC<Props> = ({ account, onSaved, onClose }) => {
  const { addToast } = useOS();
  const [avatar, setAvatar] = useState(account.avatar || '');
  const [banner, setBanner] = useState(account.banner || '');
  const [handle, setHandle] = useState(account.handle);
  const [displayName, setDisplayName] = useState(account.displayName);
  const [bio, setBio] = useState(account.bio || '');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<'avatar' | 'banner' | null>(null);
  const avatarRef = useRef<HTMLInputElement>(null);
  const bannerRef = useRef<HTMLInputElement>(null);

  const pick = (target: 'avatar' | 'banner') => async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy(target);
    try {
      const [token] = await filesToForumImageTokens([file], 1);
      if (!token) return;
      if (target === 'avatar') setAvatar(token); else setBanner(token);
    } catch (err: any) {
      addToast(err?.message || '图片处理失败', 'error');
    } finally {
      setBusy(null);
    }
  };

  const handleSave = async () => {
    if (!handle.trim() || !displayName.trim()) {
      addToast('ID 和昵称不能是空的', 'info');
      return;
    }
    setSaving(true);
    try {
      const updated: db.ForumAccount = {
        ...account,
        avatar: avatar.trim() || undefined,
        banner: banner.trim() || undefined,
        handle: handle.trim(),
        displayName: displayName.trim(),
        bio: bio.trim() || undefined,
        updatedAt: Date.now(),
      };
      await db.saveForumAccount(updated);
      onSaved(updated);
      addToast('资料已更新', 'success');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      {/* 面板背景原来是 inherit，父级是那层半透明黑遮罩，于是整块面板都透着底下的页面。
          改成 ForumApp 根节点挂的主题变量，拿到当前深浅色的实色；底部补安全区内边距。 */}
      <div
        className="relative w-full rounded-t-2xl p-4 space-y-3 max-h-[85vh] overflow-y-auto"
        style={{
          background: 'var(--forum-bg, #1A1A1E)',
          color: 'var(--forum-text, inherit)',
          paddingBottom: 'calc(var(--safe-bottom, 0px) + 16px)',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div className="font-bold text-base mb-1">编辑资料</div>

        {/* 背景图：整块可点，点了开相册 */}
        <div>
          <div className="text-[12px] opacity-50 mb-1">背景图</div>
          <button
            onClick={() => bannerRef.current?.click()}
            disabled={busy === 'banner'}
            className="relative w-full h-24 rounded-xl overflow-hidden flex items-center justify-center active:scale-[0.99] transition-transform"
            style={{ background: 'rgba(127,127,127,0.12)', border: banner ? 'none' : '1px dashed rgba(127,127,127,0.35)' }}
          >
            {banner && <TokenImg value={banner} className="absolute inset-0 w-full h-full object-cover" />}
            <div className="relative flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[12px]"
                 style={{ background: banner ? 'rgba(0,0,0,0.45)' : 'transparent', color: banner ? '#fff' : 'inherit', opacity: banner ? 1 : 0.55 }}>
              <Camera size={14} weight="fill" />
              {busy === 'banner' ? '处理中…' : banner ? '更换背景图' : '从相册选择'}
            </div>
          </button>
          {banner && (
            <button onClick={() => setBanner('')} className="mt-1 text-[11px] opacity-50 flex items-center gap-1">
              <Trash size={12} /> 移除背景图
            </button>
          )}
          <input ref={bannerRef} type="file" accept="image/*" className="hidden" onChange={pick('banner')} />
        </div>

        {/* 头像：点头像本体开相册 */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => avatarRef.current?.click()}
            disabled={busy === 'avatar'}
            className="relative w-16 h-16 rounded-full overflow-hidden shrink-0 flex items-center justify-center active:scale-95 transition-transform"
            style={{ background: 'rgba(127,127,127,0.2)' }}
          >
            {avatar
              ? <TokenImg value={avatar} className="absolute inset-0 w-full h-full object-cover" />
              : <span className="text-lg font-bold">{displayName[0] || '?'}</span>}
            <div className="absolute bottom-0 inset-x-0 py-0.5 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.5)', color: '#fff' }}>
              <Camera size={12} weight="fill" />
            </div>
          </button>
          <div className="flex-1 text-[12px] opacity-50 leading-relaxed">
            {busy === 'avatar' ? '处理中…' : '点头像从相册选择'}
            {avatar && (
              <button onClick={() => setAvatar('')} className="mt-1 text-[11px] flex items-center gap-1">
                <Trash size={12} /> 移除头像
              </button>
            )}
          </div>
          <input ref={avatarRef} type="file" accept="image/*" className="hidden" onChange={pick('avatar')} />
        </div>

        <div>
          <div className="text-[12px] opacity-50 mb-1">昵称</div>
          <input value={displayName} onChange={e => setDisplayName(e.target.value.slice(0, 30))} className="w-full px-3 py-2 rounded-lg text-sm outline-none" style={{ background: 'rgba(127,127,127,0.1)' }} />
        </div>

        <div>
          <div className="text-[12px] opacity-50 mb-1">ID（handle）</div>
          <input value={handle} onChange={e => setHandle(e.target.value.replace(/\s/g, '').slice(0, 24))} className="w-full px-3 py-2 rounded-lg text-sm outline-none" style={{ background: 'rgba(127,127,127,0.1)' }} />
        </div>

        <div>
          <div className="text-[12px] opacity-50 mb-1">个性签名</div>
          <textarea value={bio} onChange={e => setBio(e.target.value.slice(0, 100))} rows={2} className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-none" style={{ background: 'rgba(127,127,127,0.1)' }} />
        </div>

        <div className="flex gap-2 pt-1">
          <button onClick={handleSave} disabled={saving} className="flex-1 py-2.5 rounded-full font-bold text-sm disabled:opacity-40" style={{ background: '#3b82f6', color: '#fff' }}>
            {saving ? '保存中…' : '保存'}
          </button>
          <button onClick={onClose} className="px-5 py-2.5 rounded-full text-sm" style={{ background: 'rgba(127,127,127,0.15)' }}>取消</button>
        </div>
      </div>
    </div>
  );
};

export default ForumEditProfile;
