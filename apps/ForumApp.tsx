import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import {
  ArrowLeft, House, MagnifyingGlass, Bell, ChatCircleDots, BookmarkSimple,
  UserCircle, GearSix, PaperPlaneTilt, DotsThreeVertical, Sun, Moon,
} from '@phosphor-icons/react';
import { RealtimeContextManager } from '../utils/realtimeContext';
import * as db from '../utils/forumDb';
import * as feed from '../utils/forumFeed';
import * as scheduler from '../utils/forumScheduler';
import * as ai from '../utils/forumAi';
import { resolveActiveIdentityAccount, ensureCharMainAccount } from '../utils/forumBootstrap';
import { FORUM_DEFAULTS } from '../utils/forumConstants';
import { ForumLogo, FORUM_APP_NAME } from '../utils/forumLogo';
import ForumHome from './forum/ForumHome';
import ForumTopicPage from './forum/ForumTopicPage';
import ForumPostDetail from './forum/ForumPostDetail';
import ForumSearch from './forum/ForumSearch';
import ForumCollected from './forum/ForumCollected';
import ForumSettingsPanel from './forum/ForumSettingsPanel';
import ForumProfile from './forum/ForumProfile';
import ForumIdentitySheet from './forum/ForumIdentitySheet';
import ForumDm from './forum/ForumDm';
import ForumCompose from './forum/ForumCompose';
import ForumNotifications from './forum/ForumNotifications';

/** 浅色/夜色两组色值，直接照抄 MingLightApp 的日间/夜间 token，不搬它的衬线字体/纸质调性
 *  [交接5 4.11]。 */
const FORUM_THEME = {
  light: { bg: '#FFFFFF', text: '#1F2937', subtleBg: '#F5F5F7', border: '#E5E7EB' },
  dark: { bg: '#1A1A1E', text: '#D8D8DC', subtleBg: '#242428', border: '#3A3A3F' },
};

export type ForumSection =
  | { kind: 'home' }
  | { kind: 'topic'; topicTag: string }
  | { kind: 'post'; postId: string }
  | { kind: 'search' }
  | { kind: 'notifications' }
  | { kind: 'dm' }
  | { kind: 'collected' }
  | { kind: 'profile'; accountId?: string }
  | { kind: 'settings' }
  | { kind: 'compose' };

// 「发布」不在这条导航里——它是右下角那颗悬浮纸飞机（见下方 FAB），
// 跟左侧这排「去哪儿看」的导航不是一类操作。
const NAV_ITEMS: { id: ForumSection['kind']; icon: React.ElementType; label: string }[] = [
  { id: 'home', icon: House, label: '主页' },
  { id: 'search', icon: MagnifyingGlass, label: '搜索' },
  { id: 'notifications', icon: Bell, label: '通知' },
  { id: 'dm', icon: ChatCircleDots, label: '私信' },
  { id: 'collected', icon: BookmarkSimple, label: '收藏' },
  { id: 'profile', icon: UserCircle, label: '我的' },
  { id: 'settings', icon: GearSix, label: '设置' },
];

const ForumApp: React.FC = () => {
  const { closeApp, apiConfig, characters, userProfile, realtimeConfig, addToast } = useOS();

  const [section, setSection] = useState<ForumSection>({ kind: 'home' });
  const [history, setHistory] = useState<ForumSection[]>([]);
  const [ready, setReady] = useState(false);
  const [activeAccount, setActiveAccount] = useState<db.ForumAccount | null>(null);
  const [heatLevel, setHeatLevel] = useState(FORUM_DEFAULTS.defaultHeatLevel);
  const [darkMode, setDarkMode] = useState(false);
  const [identitySheetOpen, setIdentitySheetOpen] = useState(false);
  const [feedRefreshKey, setFeedRefreshKey] = useState(0);

  const navigate = useCallback((next: ForumSection) => {
    setHistory(h => [...h, section]);
    setSection(next);
  }, [section]);

  const goBack = useCallback(() => {
    setHistory(h => {
      if (h.length === 0) { closeApp(); return h; }
      const copy = [...h];
      const prev = copy.pop()!;
      setSection(prev);
      return copy;
    });
  }, [closeApp]);

  // ── 初始化：确保每个角色有论坛主号 + 用户身份 + 一次性水线清扫/沉寂扫描/自然批量检查 ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
     try {
      for (const char of characters || []) {
        if (char.id) await ensureCharMainAccount(char.id, char.name, char.avatar);
      }
      const account = await resolveActiveIdentityAccount(userProfile?.name || '我', userProfile?.avatar);
      if (cancelled) return;
      setActiveAccount(account);

      const settings = await db.getForumSettings(account.id);
      if (cancelled) return;
      setHeatLevel(settings.heatLevel || FORUM_DEFAULTS.defaultHeatLevel);
      setDarkMode(!!settings.darkMode);

      // 打开App顺手做的免费维护：物理清扫过期内容（失败不影响进入）
      await feed.sweepExpiredContent().catch(e => console.warn('[Forum] 清扫失败:', e));

      // 自然触发批量生成：当前 slot 缺批次就生成一批
      try {
        await RealtimeContextManager.getSlottedHotNews(realtimeConfig);
        const { id: slotId } = RealtimeContextManager.getHotNewsSlot();
        const needsBatch = await scheduler.needsNaturalBatch(slotId, account.id);
        if (needsBatch && apiConfig?.baseUrl && apiConfig?.apiKey && apiConfig?.model) {
          const snap = await RealtimeContextManager.getSlottedHotNews(realtimeConfig).catch(() => null);
          const hotNewsItems = (snap as any)?.items || [];
          await ai.runBatchGeneration({
            apiConfig, hotNewsItems, userPreferenceTags: [], trigger: 'natural',
          });
          await scheduler.markNaturalBatchDone(slotId, account.id);
          if (!cancelled) setFeedRefreshKey(k => k + 1);
        }
      } catch (e: any) {
        console.warn('[Forum] 自然触发批量生成失败:', e?.message || String(e));
      }

     } catch (e: any) {
      console.error('[Forum] 初始化失败:', e);
      addToast(`${FORUM_APP_NAME}初始化失败: ${e?.message?.slice(0, 60) || '未知错误'}`, 'error');
     } finally {
      if (!cancelled) setReady(true);
     }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleManualRefresh = useCallback(async () => {
    if (!apiConfig?.baseUrl || !apiConfig?.apiKey || !apiConfig?.model) {
      addToast('请先配置 API', 'info');
      return;
    }
    try {
      const snap = await RealtimeContextManager.getSlottedHotNews(realtimeConfig).catch(() => null);
      const hotNewsItems = (snap as any)?.items || [];
      await ai.runBatchGeneration({ apiConfig, hotNewsItems, userPreferenceTags: [], trigger: 'manual' });
      setFeedRefreshKey(k => k + 1);
      addToast('刷出新帖了', 'success');
    } catch (e: any) {
      addToast(`刷新失败: ${e?.message?.slice(0, 60) || '未知错误'}`, 'error');
    }
  }, [apiConfig, realtimeConfig, addToast]);

  const themeTokens = darkMode ? FORUM_THEME.dark : FORUM_THEME.light;

  const handleDarkModeToggle = useCallback(async () => {
    const next = !darkMode;
    setDarkMode(next);
    if (activeAccount) {
      const settings = await db.getForumSettings(activeAccount.id);
      await db.saveForumSettings({ ...settings, darkMode: next });
    }
  }, [darkMode, activeAccount]);

  const handleHeatLevelChange = useCallback(async (level: number) => {
    setHeatLevel(level);
    if (activeAccount) {
      const settings = await db.getForumSettings(activeAccount.id);
      await db.saveForumSettings({ ...settings, heatLevel: level });
    }
  }, [activeAccount]);

  const handleSwitchIdentity = useCallback(async (accountId: string) => {
    if (!activeAccount) return;
    const { setActiveIdentityAccount } = await import('../utils/forumBootstrap');
    await setActiveIdentityAccount(accountId, activeAccount.id);
    const account = await db.getForumAccount(accountId);
    if (account) setActiveAccount(account);
    setIdentitySheetOpen(false);
    setSection({ kind: 'home' });
    setHistory([]);
  }, [activeAccount]);

  const content = useMemo(() => {
    if (!ready || !activeAccount) return null;
    switch (section.kind) {
      case 'home':
        return (
          <ForumHome
            key={feedRefreshKey}
            onOpenTopic={topicTag => navigate({ kind: 'topic', topicTag })}
            onOpenPost={postId => navigate({ kind: 'post', postId })}
          />
        );
      case 'topic':
        return <ForumTopicPage topicTag={section.topicTag} onOpenPost={postId => navigate({ kind: 'post', postId })} />;
      case 'post':
        return (
          <ForumPostDetail
            postId={section.postId}
            activeAccount={activeAccount}
            heatLevel={heatLevel}
            apiConfig={apiConfig}
            onDeleted={() => { setSection({ kind: 'home' }); setHistory([]); setFeedRefreshKey(k => k + 1); }}
          />
        );
      case 'search':
        return <ForumSearch onOpenPost={postId => navigate({ kind: 'post', postId })} />;
      case 'notifications':
        return <ForumNotifications activeAccount={activeAccount} onOpenPost={postId => navigate({ kind: 'post', postId })} />;
      case 'dm':
        return <ForumDm activeAccount={activeAccount} apiConfig={apiConfig} />;
      case 'collected':
        return <ForumCollected onOpenPost={postId => navigate({ kind: 'post', postId })} />;
      case 'profile':
        return <ForumProfile accountId={section.accountId || activeAccount.id} onOpenPost={postId => navigate({ kind: 'post', postId })} />;
      case 'settings':
        return (
          <ForumSettingsPanel
            heatLevel={heatLevel}
            onHeatLevelChange={handleHeatLevelChange}
            darkMode={darkMode}
            onDarkModeToggle={handleDarkModeToggle}
          />
        );
      case 'compose':
        return <ForumCompose activeAccount={activeAccount} onDone={() => { setSection({ kind: 'home' }); setFeedRefreshKey(k => k + 1); }} />;
      default:
        return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, activeAccount, section, feedRefreshKey, heatLevel, apiConfig, darkMode]);

  return (
    <div
      className="relative h-full w-full flex flex-col overflow-hidden"
      style={{ background: themeTokens.bg, color: themeTokens.text }}
    >
      {/* 顶栏：返回 + 标题 + 手动刷新（仅主页显示）+ 浅色/夜色切换 */}
      <div
        className="flex items-center gap-2 px-3 py-2 shrink-0 border-b"
        style={{ borderColor: themeTokens.border, paddingTop: 'calc(var(--safe-top) + 8px)' }}
      >
        <button onClick={goBack} className="p-2 -ml-2 rounded-full active:scale-90 transition-transform">
          <ArrowLeft size={20} weight="bold" />
        </button>
        <div className="font-bold text-base">
          {section.kind === 'home' && (
            <span className="flex items-center gap-1.5"><ForumLogo size={20} />{FORUM_APP_NAME}</span>
          )}
          {section.kind === 'topic' && '分区'}
          {section.kind === 'post' && '帖子'}
          {section.kind === 'search' && '搜索'}
          {section.kind === 'notifications' && '通知'}
          {section.kind === 'dm' && '私信'}
          {section.kind === 'collected' && '收藏'}
          {section.kind === 'profile' && '个人主页'}
          {section.kind === 'settings' && '设置'}
          {section.kind === 'compose' && '发布'}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {section.kind === 'home' && (
            <button
              onClick={handleManualRefresh}
              className="text-xs px-2.5 py-1.5 rounded-full active:scale-90 transition-transform"
              style={{ background: themeTokens.subtleBg }}
            >
              刷新出新帖
            </button>
          )}
          <button onClick={handleDarkModeToggle} className="p-2 rounded-full active:scale-90 transition-transform">
            {darkMode ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button onClick={() => setIdentitySheetOpen(true)} className="p-2 rounded-full active:scale-90 transition-transform">
            <DotsThreeVertical size={20} weight="bold" />
          </button>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        {/* 左侧细长图标导航栏，仿X，纯图标级别 [交接5 4.1] */}
        <div
          className="shrink-0 flex flex-col items-center gap-1 py-3 border-r"
          style={{ width: 56, borderColor: themeTokens.border }}
        >
          {NAV_ITEMS.map(item => {
            const Icon = item.icon;
            const isActive = section.kind === item.id;
            return (
              <button
                key={item.id}
                onClick={() => { setHistory([]); setSection({ kind: item.id } as ForumSection); }}
                className="p-2.5 rounded-xl active:scale-90 transition-transform"
                style={{ background: isActive ? themeTokens.subtleBg : 'transparent' }}
                title={item.label}
              >
                <Icon size={20} weight={isActive ? 'fill' : 'regular'} />
              </button>
            );
          })}
        </div>

        <div className={`flex-1 min-w-0 no-scrollbar ${section.kind === 'compose' ? 'overflow-hidden' : 'overflow-y-auto'}`}>
          {!ready && <div className="text-center py-16 text-sm opacity-50">加载中…</div>}
          {ready && !activeAccount && <div className="text-center py-16 text-sm opacity-50">初始化失败，请退出重进或查看控制台报错</div>}
          {content}
        </div>
      </div>

      {/* 右下角悬浮「发帖」：底下垫一层同色光晕做悬浮感，正在发布页时隐藏，免得挡住工具条 */}
      {ready && activeAccount && section.kind !== 'compose' && (
        <div className="absolute right-5 z-30 pointer-events-none" style={{ bottom: 'calc(var(--safe-bottom, 0px) + 22px)' }}>
          <div
            className="absolute -inset-3 rounded-full"
            style={{ background: 'radial-gradient(circle, rgba(59,130,246,0.38) 0%, rgba(59,130,246,0) 70%)', filter: 'blur(6px)' }}
          />
          <button
            onClick={() => { setHistory([]); setSection({ kind: 'compose' }); }}
            className="pointer-events-auto relative w-14 h-14 rounded-full flex items-center justify-center active:scale-90 transition-transform"
            style={{
              background: 'linear-gradient(140deg, #60A5FA 0%, #3B82F6 55%, #2563EB 100%)',
              color: '#fff',
              boxShadow: '0 12px 28px -8px rgba(37,99,235,0.65), 0 3px 10px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.35)',
              border: `1px solid ${darkMode ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.5)'}`,
            }}
            aria-label="发帖"
            title="发帖"
          >
            <PaperPlaneTilt size={24} weight="fill" style={{ transform: 'translate(-1px, 1px)' }} />
          </button>
        </div>
      )}

      {identitySheetOpen && activeAccount && (
        <ForumIdentitySheet
          activeAccount={activeAccount}
          characters={characters}
          onSwitch={handleSwitchIdentity}
          onClose={() => setIdentitySheetOpen(false)}
          onOpenSharedProfile={charId => {
            setIdentitySheetOpen(false);
            navigate({ kind: 'profile', accountId: `facc_shared_${charId}` });
          }}
        />
      )}
    </div>
  );
};

export default ForumApp;
