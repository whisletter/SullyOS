import React from 'react';

interface Props {
    isOpen: boolean;
    onClose: () => void;
    enabled: boolean;
    /** 全局「生图 API」（设置 → 生图 API）是否已配置好；未配置时提示去设置，开关禁用。 */
    apiReady: boolean;
    onChange: (enabled: boolean) => void;
}

/**
 * 聊天框「生图」设置弹窗——极简版，只有一个开关。
 * 参考 ThinkingChainSettingsModal 的壳（同款 bottom-sheet），内容不做它那么复杂。
 */
const ImageGenChatSettingsModal: React.FC<Props> = ({ isOpen, onClose, enabled, apiReady, onChange }) => {
    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 z-[200] flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-[1px]"
            style={{ paddingBottom: 'var(--safe-bottom)' }}
            onClick={onClose}
        >
            <div
                className="w-full sm:max-w-md bg-white rounded-t-3xl sm:rounded-3xl shadow-2xl"
                onClick={e => e.stopPropagation()}
            >
                <div className="px-5 pt-5 pb-3 border-b border-slate-100 flex items-center justify-between">
                    <div>
                        <h2 className="text-base font-bold text-slate-800">生图</h2>
                        <p className="text-[11px] text-slate-400 mt-0.5">TA 会自己判断聊天里要不要发图</p>
                    </div>
                    <button onClick={onClose} className="text-[12px] font-bold text-teal-500 active:scale-95 transition">
                        完成
                    </button>
                </div>

                <div className="p-5 space-y-4">
                    <div className="flex items-center justify-between">
                        <div className="pr-4">
                            <div className="text-sm font-bold text-slate-700">启用生图</div>
                            <div className="text-[11px] text-slate-400 mt-1 leading-relaxed">
                                开启后 TA 会根据聊天语境自己判断要不要发图给你（不需要你手动说“发张图”），什么时候发、发什么完全由 TA 决定。
                            </div>
                        </div>
                        <button
                            onClick={() => apiReady && onChange(!enabled)}
                            disabled={!apiReady}
                            className={`relative w-12 h-7 rounded-full shrink-0 transition-colors ${
                                !apiReady ? 'bg-slate-200 cursor-not-allowed' : enabled ? 'bg-teal-500' : 'bg-slate-300'
                            }`}
                        >
                            <span
                                className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform ${
                                    enabled ? 'translate-x-5' : ''
                                }`}
                            />
                        </button>
                    </div>

                    {!apiReady && (
                        <div className="rounded-xl bg-amber-50 border border-amber-200 px-3 py-2.5 text-[11px] text-amber-700 leading-relaxed">
                            还没配置「生图 API」，请先去 设置 → 生图 API 填好格式 / Key / Model 再回来开启。
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default ImageGenChatSettingsModal;
