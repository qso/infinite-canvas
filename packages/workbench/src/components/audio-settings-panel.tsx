import { useState, type ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { workbenchMessageOptions } from "@workbench/components/ui/sonner";

import { isFireRedSpeech, type FireRedSpeechMode } from "@workbench/constant/firered";
import { normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@workbench/lib/audio-generation";
import { normalizeGenerationOptions, visibleOptions } from "@workbench/lib/generation-options";
import { type CanvasTheme } from "@workbench/lib/canvas-theme";
import type { AiConfig } from "@workbench/stores/use-config-store";
import type { CanvasNodeMetadata } from "@infinite-canvas/shared/canvas/schema/canvas";

export type AudioSettingKey =
    | "audioVoice"
    | "audioFormat"
    | "audioSpeed"
    | "audioInstructions"
    | "audioFireRedMode"
    | "audioFireRedTranscript"
    | "audioFireRedVoiceDesc"
    | "audioFireRedLanguage"
    | "audioFireRedSeed";

type AudioSettingsPanelProps = {
    config: AiConfig;
    metadata?: CanvasNodeMetadata;
    hasAudioReference?: boolean;
    onAutoTranscribe?: () => Promise<string>;
    onConfigChange: (key: AudioSettingKey, value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

const fireRedModes: Array<{ value: FireRedSpeechMode; label: string }> = [
    { value: "clone", label: "声音克隆" },
    { value: "design", label: "声音设计" },
    { value: "edit", label: "语音编辑" },
];

const fireRedLanguages = [
    { value: "auto", label: "自动" },
    { value: "zh", label: "中文" },
    { value: "en", label: "英文" },
];

export function AudioSettingsPanel({ config, metadata, hasAudioReference = false, onAutoTranscribe, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5" }: AudioSettingsPanelProps) {
    const [transcribing, setTranscribing] = useState(false);
    const fireRed = isFireRedSpeech(config.model);

    if (fireRed) {
        const mode: FireRedSpeechMode = metadata?.audioFireRedMode === "design" || metadata?.audioFireRedMode === "edit" ? metadata.audioFireRedMode : "clone";
        const language = metadata?.audioFireRedLanguage === "en" || metadata?.audioFireRedLanguage === "zh" ? metadata.audioFireRedLanguage : "auto";
        const needsAudio = (mode === "clone" || mode === "edit") && !hasAudioReference;
        const handleTranscribe = async () => {
            if (!onAutoTranscribe || transcribing) return;
            setTranscribing(true);
            try {
                const text = await onAutoTranscribe();
                if (text) onConfigChange("audioFireRedTranscript", text);
            } catch (error) {
                toast.error(error instanceof Error ? error.message : "自动识别失败", workbenchMessageOptions.error);
            } finally {
                setTranscribing(false);
            }
        };
        return (
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">FireRedAudio 语音设置</div> : null}
                <SettingGroup title="模式" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {fireRedModes.map((item) => (
                            <OptionPill key={item.value} selected={mode === item.value} theme={theme} onClick={() => onConfigChange("audioFireRedMode", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                    {needsAudio ? (
                        <div className="text-xs text-red-400">
                            {mode === "edit" ? "语音编辑需要连接目标音频" : "声音克隆需要连接参考音频（建议 5–10 秒清晰人声）"}
                        </div>
                    ) : null}
                </SettingGroup>
                {mode !== "edit" ? (
                    <SettingGroup title="合成语言" color={theme.node.muted}>
                        <div className="grid grid-cols-3 gap-2.5">
                            {fireRedLanguages.map((item) => (
                                <OptionPill key={item.value} selected={language === item.value} theme={theme} onClick={() => onConfigChange("audioFireRedLanguage", item.value)}>
                                    {item.label}
                                </OptionPill>
                            ))}
                        </div>
                    </SettingGroup>
                ) : null}
                {mode === "clone" ? (
                    <SettingGroup title="参考转写" color={theme.node.muted}>
                        <div className="space-y-1.5">
                            {onAutoTranscribe && hasAudioReference ? (
                                <div className="flex justify-end">
                                    <button type="button" disabled={transcribing} className="inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs transition hover:opacity-80 disabled:opacity-50" style={{ borderColor: theme.node.stroke, color: theme.node.text }} onClick={() => void handleTranscribe()}>
                                        {transcribing ? <LoaderCircle className="size-3 animate-spin" /> : null}
                                        {transcribing ? "识别中…" : "自动识别"}
                                    </button>
                                </div>
                            ) : null}
                            <textarea
                                value={metadata?.audioFireRedTranscript || ""}
                                placeholder="参考音频的文字内容；留空将在生成时自动识别"
                                className="thin-scrollbar h-16 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                                style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                                onChange={(event) => onConfigChange("audioFireRedTranscript", event.target.value)}
                                onMouseDown={(event) => event.stopPropagation()}
                            />
                        </div>
                    </SettingGroup>
                ) : null}
                {mode === "design" ? (
                    <SettingGroup title="声音描述" color={theme.node.muted}>
                        <textarea
                            value={metadata?.audioFireRedVoiceDesc || ""}
                            placeholder="例如：青年女声，清亮温柔，语速适中"
                            className="thin-scrollbar h-20 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                            style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                            onChange={(event) => onConfigChange("audioFireRedVoiceDesc", event.target.value)}
                            onMouseDown={(event) => event.stopPropagation()}
                        />
                    </SettingGroup>
                ) : null}
                <SettingGroup title="随机种子" color={theme.node.muted}>
                    <input
                        type="text"
                        value={metadata?.audioFireRedSeed || ""}
                        placeholder="留空随机"
                        className="h-9 w-full rounded-xl border bg-transparent px-3 text-sm outline-none"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                        onChange={(event) => onConfigChange("audioFireRedSeed", event.target.value)}
                        onMouseDown={(event) => event.stopPropagation()}
                    />
                </SettingGroup>
            </div>
        );
    }

    const voice = normalizeAudioVoiceValue(config.audioVoice);
    const format = normalizeAudioFormatValue(config.audioFormat);
    const speed = normalizeAudioSpeedValue(config.audioSpeed);
    const options = normalizeGenerationOptions(config.generationOptions);
    const voiceList = visibleOptions(options.audioVoice.filter((option) => option.enabled), voice);
    const formatList = visibleOptions(options.audioFormat.filter((option) => option.enabled), format);
    const speedList = visibleOptions(options.audioSpeed.filter((option) => option.enabled), speed);

    return (
        <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
            {showTitle ? <div className="text-lg font-semibold">音频设置</div> : null}
            <SettingGroup title="声音" color={theme.node.muted}>
                <div className="grid grid-cols-3 gap-2.5">
                    {voiceList.map((item) => (
                        <OptionPill key={item.value} selected={voice === item.value} theme={theme} onClick={() => onConfigChange("audioVoice", item.value)}>
                            {item.label}
                        </OptionPill>
                    ))}
                </div>
            </SettingGroup>
            <SettingGroup title="格式" color={theme.node.muted}>
                <div className="grid grid-cols-3 gap-2.5">
                    {formatList.map((item) => (
                        <OptionPill key={item.value} selected={format === item.value} theme={theme} onClick={() => onConfigChange("audioFormat", item.value)}>
                            {item.label}
                        </OptionPill>
                    ))}
                </div>
            </SettingGroup>
            <SettingGroup title="语速" color={theme.node.muted}>
                <div className="grid grid-cols-4 gap-2.5">
                    {speedList.map((item) => (
                        <OptionPill key={item.value} selected={speed === item.value} theme={theme} onClick={() => onConfigChange("audioSpeed", item.value)}>
                            {item.label}
                        </OptionPill>
                    ))}
                </div>
                <input
                    type="number"
                    min={0.25}
                    max={4}
                    step={0.05}
                    className="h-9 w-full rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                    style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                    value={config.audioSpeed || "1"}
                    onChange={(event) => onConfigChange("audioSpeed", event.target.value)}
                    onBlur={(event) => onConfigChange("audioSpeed", normalizeAudioSpeedValue(event.target.value))}
                    onMouseDown={(event) => event.stopPropagation()}
                />
            </SettingGroup>
            <SettingGroup title="声音指令" color={theme.node.muted}>
                <textarea
                    value={config.audioInstructions || ""}
                    placeholder="例如：自然、温暖、适合旁白。"
                    className="thin-scrollbar h-20 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                    style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                    onChange={(event) => onConfigChange("audioInstructions", event.target.value)}
                    onMouseDown={(event) => event.stopPropagation()}
                />
            </SettingGroup>
        </div>
    );
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}
