# 游戏大厅 · 文件结构

```
YuZhouApp.tsx                  与昼主页 + 游戏大厅（只读 games/registry.tsx，不含任何游戏代码）
games/
├── registry.tsx               游戏列表：名字、图标、点开哪个组件
├── shared/                    所有小游戏共用
│   ├── ai.ts                  调 AI（OpenAI 兼容），没配 API 时返回 null
│   ├── chatMirror.ts          写进角色聊天记录 → 记忆宫殿自动整理
│   └── profile.ts             读名字 / 性别 / 人设
└── monopoly/                  大富翁，自成一体
    ├── MonopolyGame.tsx       页面（设置页、棋盘、题卡、文字卡片）
    ├── content.ts             ✏️ 数值、文字、棋盘、功能卡、模型、写聊天记录开关
    ├── prompts.ts             ✏️ 荷官 / TA 提示词和 TA 指令标签
    ├── engine.ts              ⛔ 引擎（逐条移植自 monopoly_play.py）
    ├── types.ts               ⛔ 类型
    ├── 说明.md
    └── data/                  三份卡库 JSON，直接覆盖即可换库
```

## 做新游戏时发什么

下个窗口做海龟汤、猜猜看这类游戏，只需要发：

1. `games/registry.tsx`
2. `games/shared/` 里用得到的文件（要接 AI 就发 `ai.ts`，要进记忆就发 `chatMirror.ts`）
3. 这个游戏自己的资料

大富翁的文件一个都不用发。新游戏建一个文件夹，默认导出 `React.FC<{ onBack: () => void }>`，在 `registry.tsx` 里加一行。

## import 路径

`games/` 和 `YuZhouApp.tsx` 放在同一个目录。游戏文件夹里引用 App 的东西是三层 `../../../context/OSContext`、`../../../utils/db`。如果你的目录层级不一样，改这几行 import 就行。
