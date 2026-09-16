import React, { useState } from 'react';
import * as db from '../../utils/forumDb';
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
 */
const ForumEditProfile: React.FC<Props> = ({ account, onSaved, onClose }) => {
  const { addToast } = useOS();
  const [avatar, setAvatar] = useState(account.avatar || '');
  const [banner, setBanner] = useState(account.banner || '');
  const [handle, setHandle] = useState(account.handle);
  const [displayName, setDisplayName] = useState(account.displayName);
  const [bio, setBio] = useState(account.bio || '');
  const [saving, setSaving] = useState(false);

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
      <div className="relative w-full rounded-t-2xl p-4 space-y-3 max-h-[85vh] overflow-y-auto" style={{ background: 'inherit' }} onClick={e => e.stopPropagation()}>
        <div className="font-bold text-base mb-1">编辑资料</div>

        {banner && (
          <img src={banner} className="w-full h-24 object-cover rounded-xl" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        )}
        <div>
          <div className="text-[12px] opacity-50 mb-1">背景图链接</div>
          <input value={banner} onChange={e => setBanner(e.target.value)} placeholder="https://…" className="w-full px-3 py-2 rounded-lg text-sm outline-none" style={{ background: 'rgba(127,127,127,0.1)' }} />
        </div>

        <div className="flex items-center gap-3">
          {avatar
            ? <img src={avatar} className="w-14 h-14 rounded-full object-cover shrink-0" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
            : <div className="w-14 h-14 rounded-full flex items-center justify-center font-bold shrink-0" style={{ background: 'rgba(127,127,127,0.2)' }}>{displayName[0] || '?'}</div>}
          <div className="flex-1">
            <div className="text-[12px] opacity-50 mb-1">头像链接</div>
            <input value={avatar} onChange={e => setAvatar(e.target.value)} placeholder="https://…" className="w-full px-3 py-2 rounded-lg text-sm outline-none" style={{ background: 'rgba(127,127,127,0.1)' }} />
          </div>
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
