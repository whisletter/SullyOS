/**
 * 杂波频段 · 临时 Logo（占位用，之后可直接替换）
 * 图形：深色圆角底 + 一条被"杂波"打乱的信号波形。
 *   - ForumLogo：React 组件，App 内顶栏用
 *   - FORUM_LOGO_SVG / FORUM_LOGO_DATA_URI：桌面图标用（AppConfig.icon 若是图片地址就填 DATA_URI）
 */
import React from 'react';

export const FORUM_APP_NAME = '杂波频段';

export const FORUM_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<defs><linearGradient id="zbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2B2D42"/><stop offset="1" stop-color="#14151F"/></linearGradient>
<linearGradient id="zbw" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#5EEAD4"/><stop offset="1" stop-color="#A78BFA"/></linearGradient></defs>
<rect width="64" height="64" rx="14" fill="url(#zbg)"/>
<path d="M8 34 H16 L19 26 L22 40 L25 20 L28 44 L31 30 L34 36 L37 16 L40 46 L43 28 L46 34 H56" fill="none" stroke="url(#zbw)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
<circle cx="12" cy="18" r="1.4" fill="#5EEAD4" opacity=".6"/><circle cx="50" cy="15" r="1.2" fill="#A78BFA" opacity=".7"/>
<circle cx="18" cy="50" r="1" fill="#A78BFA" opacity=".5"/><circle cx="52" cy="50" r="1.4" fill="#5EEAD4" opacity=".5"/>
</svg>`;

export const FORUM_LOGO_DATA_URI = `data:image/svg+xml;utf8,${encodeURIComponent(FORUM_LOGO_SVG)}`;

export const ForumLogo: React.FC<{ size?: number; className?: string }> = ({ size = 24, className }) => (
  <img src={FORUM_LOGO_DATA_URI} width={size} height={size} alt={FORUM_APP_NAME} className={className} style={{ borderRadius: size * 0.22 }} />
);

export default ForumLogo;
