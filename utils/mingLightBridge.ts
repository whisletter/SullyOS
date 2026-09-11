/**
 * 「眠光」阅读页 <-> 悬浮球 之间的轻量通信。
 *
 * 两者是完全独立挂载的组件（阅读页在 PhoneShell 的 case 分发里，悬浮球是
 * 全局常驻组件），彼此不共享 props，所以用一个模块级的小小事件总线来传消息，
 * 不去碰 OSContext（那个文件太大，风险高，没必要为这点事扩大改动范围）。
 */

type BridgeEvent = 'minimized' | 'opened' | 'closed';
type Listener = (event: BridgeEvent) => void;

const listeners = new Set<Listener>();

// 记录「最近一次打开的书」，缩小成悬浮球后，点球能直接跳回原来那本书，
// 而不是回到书架页重新选。只存在内存里，刷新页面就清空，没关系——
// 真正的阅读进度早就实时存进 IndexedDB 了。
let lastBookId: string | null = null;

export function subscribeMingLightBridge(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(event: BridgeEvent) {
  listeners.forEach(fn => fn(event));
}

export function notifyMingLightMinimized(bookId: string) {
  lastBookId = bookId;
  emit('minimized');
}

export function notifyMingLightOpened(bookId: string | null) {
  lastBookId = bookId;
  emit('opened');
}

export function notifyMingLightClosed() {
  lastBookId = null;
  emit('closed');
}

export function getMingLightLastBook(): string | null {
  return lastBookId;
}
