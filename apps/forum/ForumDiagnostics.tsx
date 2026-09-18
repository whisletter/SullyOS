import React, { useCallback, useEffect, useState } from 'react';
import { useOS } from '../../context/OSContext';
import { RealtimeContextManager } from '../../utils/realtimeContext';
import * as db from '../../utils/forumDb';
import * as feed from '../../utils/forumFeed';
import { ensureNpcPool, FORUM_NPC_POOL_SIZE } from '../../utils/forumNpcSeed';
import { runQuotaBatch, getLastBatchDiagnostics, type BatchDiagnostics } from '../../utils/forumBatch';
import { userMainAccountId } from '../../utils/forumBootstrap';
import type { HotNewsItem } from '../../types';

/**
 * 诊断台。
 *
 * 存在的理由很实际：用户在手机上跑这个 App，看不到浏览器控制台，而内容生成链路有
 * 好几处"失败了也不报错"的地方（账号池空、模型返回解析不出、时段水位卡住）。
 * 没有这块面板，出问题时双方只能靠猜。这里把中间过程直接摊在界面上。
 */
const ForumDiagnostics: React.FC = () => {
  const { apiConfig, realtimeConfig, addToast } = useOS();

  const [npcCount, setNpcCount] = useState<number | null>(null);
  const [userCount, setUserCount] = useState(0);
  const [charCount, setCharCount] = useState(0);
  const [sharedCount, setSharedCount] = useState(0);
  const [postCount, setPostCount] = useState(0);
  const [visibleCount, setVisibleCount] = useState(0);
  const [currentSlotId, setCurrentSlotId] = useState('(读取失败)');
  const [lastBatchSlotId, setLastBatchSlotId] = useState<string | undefined>(undefined);
  const [diag, setDiag] = useState<BatchDiagnostics | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [accounts, posts] = await Promise.all([db.getAllForumAccounts(), db.getForumPostsRaw()]);
    setNpcCount(accounts.filter(a => a.ownerType === 'npc').length);
    setUserCount(accounts.filter(a => a.ownerType === 'user').length);
    setCharCount(accounts.filter(a => a.ownerType === 'char').length);
    setSharedCount(accounts.filter(a => a.ownerType === 'shared').length);
    setPostCount(posts.length);
    setVisibleCount(feed.filterVisiblePosts(posts).length);

    try {
      setCurrentSlotId(RealtimeContextManager.getHotNewsSlot().id);
    } catch {
      setCurrentSlotId('(读取失败)');
    }

    const settings = await db.getForumSettings(userMainAccountId());
    setLastBatchSlotId(settings.lastNaturalBatchSlotId);
    setDiag(getLastBatchDiagnostics());
  }, []);

  useEffect(() => { load(); }, [load]);

  const hasApi = !!(apiConfig?.baseUrl && apiConfig?.apiKey && apiConfig?.model);

  const handleRebuildPool = useCallback(async () => {
    setBusy('pool');
    try {
      const created = await ensureNpcPool();
      addToast(created > 0 ? `新建了 ${created} 个路人账号` : '账号池已经是满的，没有新建', 'success');
      await load();
    } catch (e: any) {
      addToast(`建号失败: ${e?.message?.slice(0, 80) || '未知错误'}`, 'error');
    } finally {
      setBusy(null);
    }
  }, [addToast, load]);

  const handleForceGenerate = useCallback(async () => {
    if (!hasApi) { addToast('请先配置 API', 'info'); return; }
    setBusy('gen');
    try {
      const snap = await RealtimeContextManager.getSlottedHotNews(realtimeConfig).catch(() => null);
      const hotNewsItems = ((snap as any)?.items || []) as HotNewsItem[];
      const posts = await runQuotaBatch({ apiConfig, hotNewsItems });
      addToast(posts.length > 0 ? `生成了 ${posts.length} 条` : '一条都没生成出来，看下面的诊断', posts.length > 0 ? 'success' : 'error');
    } catch (e: any) {
      addToast(`生成失败: ${e?.message?.slice(0, 80) || '未知错误'}`, 'error');
    } finally {
      setBusy(null);
      await load();
    }
  }, [hasApi, apiConfig, realtimeConfig, addToast, load]);

  const handleClearWaterline = useCallback(async () => {
    setBusy('waterline');
    try {
      const settings = await db.getForumSettings(userMainAccountId());
      await db.saveForumSettings({ ...settings, lastNaturalBatchSlotId: undefined });
      addToast('时段水位已清除，下次进 App 会重新生成', 'success');
      await load();
    } finally {
      setBusy(null);
    }
  }, [addToast, load]);

  const Line: React.FC<{ label: string; value: string; warn?: boolean }> = ({ label, value, warn }) => (
    <div className="flex items-baseline justify-between gap-3 text-[12px] py-0.5">
      <span className="opacity-50 shrink-0">{label}</span>
      <span className="text-right break-all" style={{ color: warn ? '#ef4444' : undefined, fontWeight: warn ? 700 : 400 }}>
        {value}
      </span>
    </div>
  );

  const Btn: React.FC<{ id: string; label: string; onClick: () => void; danger?: boolean }> = ({ id, label, onClick, danger }) => (
    <button
      onClick={onClick}
      disabled={busy !== null}
      className="text-[12px] px-3 py-1.5 rounded-full disabled:opacity-40"
      style={{ background: danger ? 'rgba(239,68,68,0.15)' : 'rgba(127,127,127,0.15)', color: danger ? '#ef4444' : undefined }}
    >
      {busy === id ? '执行中…' : label}
    </button>
  );

  const poolEmpty = npcCount === 0;

  return (
    <div>
      <div className="text-sm font-bold mb-1">诊断</div>
      <div className="text-[12px] opacity-50 mb-2">生成不出内容时看这里，能直接看到卡在哪一步。</div>

      <div className="rounded-xl px-3 py-2" style={{ background: 'rgba(127,127,127,0.08)' }}>
        <Line label="路人账号" value={npcCount === null ? '读取中…' : `${npcCount} / ${FORUM_NPC_POOL_SIZE}`} warn={poolEmpty} />
        <Line label="你的账号" value={`${userCount} 个`} />
        <Line label="角色账号" value={`${charCount} 个`} warn={charCount === 0} />
        <Line label="共管账号" value={`${sharedCount} 个`} />
        <Line label="帖子" value={`库里 ${postCount} 条，当前可见 ${visibleCount} 条`} />
        <Line label="API" value={hasApi ? `已配置（${apiConfig?.model || '?'}）` : '没配全'} warn={!hasApi} />
        <Line label="当前时段" value={currentSlotId} />
        <Line label="上次生成时段" value={lastBatchSlotId || '(还没生成过)'} />
      </div>

      {poolEmpty && (
        <div className="mt-2 text-[12px] px-3 py-2 rounded-xl" style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444' }}>
          路人账号是 0——没有路人就没人发帖，所有生成都会空转。先点"重建路人账号池"。
        </div>
      )}

      {lastBatchSlotId === currentSlotId && (
        <div className="mt-2 text-[12px] px-3 py-2 rounded-xl opacity-70" style={{ background: 'rgba(127,127,127,0.08)' }}>
          这个时段已经生成过了，所以进 App 不会再自动生成。想立刻要新内容就点"立即生成一批"。
        </div>
      )}

      <div className="flex flex-wrap gap-2 mt-2">
        <Btn id="pool" label="重建路人账号池" onClick={handleRebuildPool} />
        <Btn id="gen" label="立即生成一批" onClick={handleForceGenerate} />
        <Btn id="waterline" label="清除时段水位" onClick={handleClearWaterline} danger />
      </div>

      {diag && (
        <div className="mt-3 rounded-xl px-3 py-2" style={{ background: 'rgba(127,127,127,0.08)' }}>
          <div className="text-[12px] font-bold opacity-60 mb-1">
            上次生成 · {new Date(diag.at).toLocaleTimeString()}
          </div>
          <Line label="账号池 / 候选" value={`${diag.npcPoolSize} / 候选 ${diag.rosterSize}`} />
          <Line label="要生成" value={`${diag.expected} 条`} />
          <Line label="模型返回" value={diag.rawChars > 0 ? `${diag.rawChars} 字` : '空'} warn={diag.rawChars === 0} />
          <Line label="解析出" value={`${diag.parsedPostCount} 条`} />
          <Line label="通过校验" value={`${diag.acceptedCount} 条`} />
          <Line label="实际存下" value={`${diag.savedCount} 条`} warn={diag.savedCount === 0} />

          {diag.error && (
            <div className="mt-1.5 text-[12px] whitespace-pre-wrap break-all" style={{ color: '#ef4444' }}>
              {diag.error}
            </div>
          )}

          {diag.rejectReasons.length > 0 && (
            <div className="mt-1.5 text-[12px] opacity-70 space-y-0.5">
              {diag.rejectReasons.map((r, i) => <div key={i}>· {r}</div>)}
            </div>
          )}

          {diag.rawHead && (
            <details className="mt-1.5">
              <summary className="text-[12px] opacity-50">模型返回的开头</summary>
              <div className="mt-1 text-[11px] opacity-70 whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
                {diag.rawHead}
              </div>
            </details>
          )}
        </div>
      )}

      <button onClick={load} className="mt-2 text-[12px] opacity-50">刷新这块数据</button>
    </div>
  );
};

export default ForumDiagnostics;
