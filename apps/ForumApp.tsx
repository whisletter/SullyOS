import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useOS } from '../context/OSContext';
import {
  ArrowLeft, House, MagnifyingGlass, Bell, ChatCircleDots, BookmarkSimple,
  UserCircle, GearSix, PaperPlaneTilt, DotsThreeVertical, Sun, Moon, UsersThree,
} from '@phosphor-icons/react';
import { RealtimeContextManager } from '../utils/realtimeContext';
import * as db from '../utils/forumDb';
import * as feed from '../utils/forumFeed';
import * as scheduler from '../utils/forumScheduler';
import { resolveActiveIdentityAccount, ensureCharMainAccount } from '../utils/forumBootstrap';
import { ensureNpcPool } from '../utils/forumNpcSeed';
import { runQuotaBatch, runTopicRefresh } from '../utils/forumBatch';
import { ensureRegulars } from '../utils/forumSocial';
import * as social from '../utils/forumSocial';
import { ensureCharAltAccount } from '../utils/forumCharIdentity';
import * as ai from '../utils/forumAi';
import { runForumArchivePass } from '../utils/forumArchiveRunner';
import { FORUM_DEFAULTS, type ForumTopicTag } from '../utils/forumConstants';
import { ForumLogo, FORUM_APP_NAME } from '../utils/forumLogo';
import type { HotNewsItem } from '../types';
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
import ForumFriends from './forum/ForumFriends';

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
  | { kind: 'friends' }
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
  { id: 'friends', icon: UsersThree, label: '好友' },
  { id: 'collected', icon: BookmarkSimple, label: '收藏' },
  { id: 'profile', icon: UserCircle, label: '我的' },
  { id: 'settings', icon: GearSix, label: '设置' },
];

const ForumApp: React.FC = () => {
  const { closeApp, apiConfig, characters, userProfile, realtimeConfig, addToast, memoryPalaceConfig } = useOS();

  const [section, setSection] = useState<ForumSection>({ kind: 'home' });
  const [history, setHistory] = useState<ForumSection[]>([]);
  const [ready, setReady] = useState(false);
  const [activeAccount, setActiveAccount] = useState<db.ForumAccount | null>(null);
  const [heatLevel, setHeatLevel] = useState(FORUM_DEFAULTS.defaultHeatLevel);
  const [darkMode, setDarkMode] = useState(false);
  const [identitySheetOpen, setIdentitySheetOpen] = useState(false);
  const [feedRefreshKey, setFeedRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  /** 进 App 时正在跑首批生成——首次安装时这一步要等十几秒，不给提示会以为卡死。 */
  const [generatingFirstBatch, setGeneratingFirstBatch] = useState(false);

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

  const hasApiConfig = !!(apiConfig?.baseUrl && apiConfig?.apiKey && apiConfig?.model);

  const fetchHotNewsItems = useCallback(async (): Promise<HotNewsItem[]> => {
    const snap = await RealtimeContextManager.getSlottedHotNews(realtimeConfig).catch(() => null);
    return ((snap as any)?.items || []) as HotNewsItem[];
  }, [realtimeConfig]);

  // ── 初始化：角色论坛主号 + 路人账号池 + 用户身份 + 水线清扫 + 自然批量生成 ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
     try {
      for (const char of characters || []) {
        if (char.id) await ensureCharMainAccount(char.id, char.name, char.avatar);
      }

      // 路人账号池：没有它，所有内容生成都会静默空转（生成层第一步就是
      // "池子为空直接 return"）。放在最前面，且是幂等的，已有就跳过。
      await ensureNpcPool().catch(e => console.warn('[Forum] 路人账号池引导失败:', e));

      const account = await resolveActiveIdentityAccount(userProfile?.name || '我', userProfile?.avatar);
      if (cancelled) return;
      setActiveAccount(account);

      // 常客名单：从路人池里固定挑 10 个，让他们在用户帖子下面反复出现。
      // 必须在账号池建好之后调，否则抽不到人。
      await ensureRegulars(account.id).catch(e => console.warn('[Forum] 常客名单初始化失败:', e));

      // TA 的小号：只在第一次建，名字和风格由 TA 自己定（一次调用）。
      // 失败就跳过，下次进 App 再试，不拿随机名字把这个号定死。
      if (hasApiConfig) {
        for (const char of characters || []) {
          if (!char.id) continue;
          await ensureCharAltAccount(apiConfig, {
            id: char.id, name: char.name,
            systemPrompt: (char as any).systemPrompt, worldview: (char as any).worldview,
          }).catch(e => console.warn('[Forum] 角色小号建号失败:', e));
        }
      }

      const settings = await db.getForumSettings(account.id);
      if (cancelled) return;
      setHeatLevel(settings.heatLevel || FORUM_DEFAULTS.defaultHeatLevel);
      setDarkMode(!!settings.darkMode);

      // 打开App顺手做的免费维护：物理清扫过期内容（失败不影响进入）
      await feed.sweepExpiredContent().catch(e => console.warn('[Forum] 清扫失败:', e));

      // 长期归档（轨道A）：扫沉寂帖子入队，顺带处理最多两条。扫描本身零 API 成本，
      // 只有真扫出东西才会调轻量模型。角色没开记忆宫殿/自动归档就整趟跳过。
      runForumArchivePass({
        characters: (characters || []) as any,
        lightLLM: memoryPalaceConfig?.lightLLM,
        userName: userProfile?.name || '用户',
      }).catch(e => console.warn('[Forum] 归档失败:', e));

      // 自然触发批量生成：当前 slot 缺批次就生成一批（17 个分区各 1 条，一次调用）
      try {
        await RealtimeContextManager.getSlottedHotNews(realtimeConfig);
        const { id: slotId } = RealtimeContextManager.getHotNewsSlot();
        const needsBatch = await scheduler.needsNaturalBatch(slotId, account.id);
        if (needsBatch && hasApiConfig) {
          if (!cancelled) setGeneratingFirstBatch(true);
          const hotNewsItems = await fetchHotNewsItems();
          const posts = await runQuotaBatch({ apiConfig, hotNewsItems });
          // 只有真的生成出内容才推进水位。生成失败还把这个 slot 标记成"已生成"，
          // 等于白白浪费掉这 4 小时的机会。
          if (posts.length > 0) {
            await scheduler.markNaturalBatchDone(slotId, account.id);
            if (!cancelled) setFeedRefreshKey(k => k + 1);
          }
        }
      } catch (e: any) {
        console.warn('[Forum] 自然触发批量生成失败:', e?.message || String(e));
      } finally {
        if (!cancelled) setGeneratingFirstBatch(false);
      }

      // 共管账号：一天 6 档，每档在窗口内用哈希算出一个当天固定的触发分钟。
      // 一次最多补发一档——长时间没打开也不会一口气刷出好几条。
      if (hasApiConfig) {
        try {
          const now = new Date();
          const dateKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
          const minutesOfDay = now.getHours() * 60 + now.getMinutes();
          const sharedAccounts = (await db.getAllForumAccounts())
            .filter(a => a.ownerType === 'shared' && a.status === 'active');
          for (const acc of sharedAccounts) {
            const due = scheduler.findDueSharedAccountBand(acc.id, dateKey, minutesOfDay);
            if (!due) continue;
            const post = await ai.runSharedAccountExclusivePost({
              apiConfig, sharedAccountId: acc.id, bandLabel: due.band.label,
            });
            scheduler.markSharedAccountBandFired(acc.id, dateKey, due.bandIndex);
            if (post && !cancelled) setFeedRefreshKey(k => k + 1);
            break; // 一次进 App 只处理一个共管账号的一档，别连着烧调用
          }
        } catch (e: any) {
          console.warn('[Forum] 共管账号定时动态失败:', e?.message || String(e));
        }
      }

      // 好友申请：让 TA 自己决定通不通过。一次进 App 只处理一条，控制调用次数。
      if (hasApiConfig) {
        try {
          const charSideAccounts = (await db.getAllForumAccounts())
            .filter(a => (a.ownerType === 'char' || a.ownerType === 'shared') && a.status === 'active');
          for (const target of charSideAccounts) {
            const pending = await db.getForumRelationsTo(target.id, 'pending');
            if (pending.length === 0) continue;
            const req = pending[0];
            const accepted = await ai.runFriendRequestDecision({
              apiConfig,
              requesterAccountId: req.fromAccountId,
              targetAccountId: target.id,
              userDisplayName: userProfile?.name,
            });
            if (accepted) await social.acceptFriendRequest(req.fromAccountId, target.id);
            break;
          }
        } catch (e: any) {
          console.warn('[Forum] 好友申请判断失败:', e?.message || String(e));
        }
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
    if (!hasApiConfig) {
      addToast('请先配置 API', 'info');
      return;
    }
    if (refreshing) return;
    setRefreshing(true);
    try {
      const hotNewsItems = await fetchHotNewsItems();
      const posts = await runQuotaBatch({ apiConfig, hotNewsItems });
      if (posts.length === 0) {
        // 以前这里无论如何都弹"刷出新帖了"，生成 0 条时也照弹，等于骗人。
        addToast('这次一条都没生成出来，可以再试一次', 'error');
        return;
      }
      setFeedRefreshKey(k => k + 1);
      addToast(`刷出 ${posts.length} 条新帖`, 'success');
    } catch (e: any) {
      addToast(`刷新失败: ${e?.message?.slice(0, 60) || '未知错误'}`, 'error');
    } finally {
      setRefreshing(false);
    }
  }, [apiConfig, hasApiConfig, refreshing, fetchHotNewsItems, addToast]);

  /** 分区页🔄：只刷当前这一个分区。返回新增条数，交给分区页自己决定怎么提示/重载。 */
  const handleTopicRefresh = useCallback(async (topicTag: string): Promise<number> => {
    if (!hasApiConfig) {
      addToast('请先配置 API', 'info');
      return 0;
    }
    try {
      const hotNewsItems = await fetchHotNewsItems();
      const posts = await runTopicRefresh({
        apiConfig, hotNewsItems, topicTag: topicTag as ForumTopicTag,
      });
      if (posts.length === 0) {
        addToast('这次一条都没生成出来，可以再试一次', 'error');
        return 0;
      }
      addToast(`刷出 ${posts.length} 条新帖`, 'success');
      return posts.length;
    } catch (e: any) {
      addToast(`刷新失败: ${e?.message?.slice(0, 60) || '未知错误'}`, 'error');
      return 0;
    }
  }, [apiConfig, hasApiConfig, fetchHotNewsItems, addToast]);

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
        return (
          <ForumTopicPage
            topicTag={section.topicTag}
            onOpenPost={postId => navigate({ kind: 'post', postId })}
            onRefresh={handleTopicRefresh}
          />
        );
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
        return (
          <ForumSearch
            activeAccount={activeAccount}
            onOpenPost={postId => navigate({ kind: 'post', postId })}
            onOpenProfile={accountId => navigate({ kind: 'profile', accountId })}
          />
        );
      case 'friends':
        return (
          <ForumFriends
            activeAccount={activeAccount}
            onOpenProfile={accountId => navigate({ kind: 'profile', accountId })}
          />
        );
      case 'notifications':
        return <ForumNotifications activeAccount={activeAccount} onOpenPost={postId => navigate({ kind: 'post', postId })} />;
      case 'dm':
        return <ForumDm activeAccount={activeAccount} apiConfig={apiConfig} />;
      case 'collected':
        return <ForumCollected onOpenPost={postId => navigate({ kind: 'post', postId })} />;
      case 'profile':
        return (
          <ForumProfile
            accountId={section.accountId || activeAccount.id}
            myAccountId={activeAccount.id}
            onOpenPost={postId => navigate({ kind: 'post', postId })}
          />
        );
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
  }, [ready, activeAccount, section, feedRefreshKey, heatLevel, apiConfig, darkMode, handleTopicRefresh]);

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
          {section.kind === 'friends' && '好友'}
          {section.kind === 'collected' && '收藏'}
          {section.kind === 'profile' && '个人主页'}
          {section.kind === 'settings' && '设置'}
          {section.kind === 'compose' && '发布'}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {section.kind === 'home' && (
            <button
              onClick={handleManualRefresh}
              disabled={refreshing}
              className="text-xs px-2.5 py-1.5 rounded-full active:scale-90 transition-transform disabled:opacity-50"
              style={{ background: themeTokens.subtleBg }}
            >
              {refreshing ? '生成中…' : '刷新出新帖'}
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
          className="shrink-0 flex flex-col items-center gap-1 py-3 border-r overflow-y-auto no-scrollbar"
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
          {!ready && (
            <div className="text-center py-16 text-sm opacity-50">
              {generatingFirstBatch ? '正在生成这个时段的帖子，第一次会久一点…' : '加载中…'}
            </div>
          )}
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
        />
      )}
    </div>
  );
};

export default ForumApp;
