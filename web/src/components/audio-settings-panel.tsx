import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { LoaderCircle, Wand2 } from "lucide-react";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { audioFormatOptions, audioSpeedLabel, audioVoiceOptions, normalizeAudioFormatValue, normalizeAudioSpeedValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { isFireRedSpeech } from "@/constant/firered";
import { type CanvasTheme } from "@/lib/canvas-theme";
import type { AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";

const speedOptions = ["0.75", "1", "1.25", "1.5"];

export type AudioSettingKey = "audioVoice" | "audioFormat" | "audioSpeed" | "audioInstructions" | "audioFireRedMode" | "audioFireRedTranscript" | "audioFireRedVoiceDesc" | "audioFireRedLanguage" | "audioFireRedSeed";

type AudioSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: AudioSettingKey, value: string) => void;
    theme: CanvasTheme;
    metadata?: CanvasNodeData["metadata"];
    hasAudioReference?: boolean;
    onAutoTranscribe?: () => Promise<string>;
    showTitle?: boolean;
    className?: string;
};

export function AudioSettingsPanel({ config, onConfigChange, theme, metadata, hasAudioReference = false, onAutoTranscribe, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5" }: AudioSettingsPanelProps) {
    const { t } = useTranslation();
    const voice = normalizeAudioVoiceValue(config.audioVoice);
    const format = normalizeAudioFormatValue(config.audioFormat);
    const speed = normalizeAudioSpeedValue(config.audioSpeed);

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.audio.title")}</div> : null}
                {isFireRedSpeech(config.model) ? (
                    <FireRedSettings config={config} metadata={metadata} onConfigChange={onConfigChange} theme={theme} hasAudioReference={hasAudioReference} onAutoTranscribe={onAutoTranscribe} />
                ) : (
                    <>
                        <SettingGroup title={t("settingsPanels.audio.voice")} color={theme.node.muted}>
                            <div className="grid grid-cols-3 gap-2.5">
                                {audioVoiceOptions.map((item) => (
                                    <OptionPill key={item.value} selected={voice === item.value} theme={theme} onClick={() => onConfigChange("audioVoice", item.value)}>
                                        {item.label}
                                    </OptionPill>
                                ))}
                            </div>
                        </SettingGroup>
                        <SettingGroup title={t("settingsPanels.audio.format")} color={theme.node.muted}>
                            <div className="grid grid-cols-3 gap-2.5">
                                {audioFormatOptions.map((item) => (
                                    <OptionPill key={item.value} selected={format === item.value} theme={theme} onClick={() => onConfigChange("audioFormat", item.value)}>
                                        {item.label}
                                    </OptionPill>
                                ))}
                            </div>
                        </SettingGroup>
                        <SettingGroup title={t("settingsPanels.audio.speed")} color={theme.node.muted}>
                            <div className="grid grid-cols-4 gap-2.5">
                                {speedOptions.map((value) => (
                                    <OptionPill key={value} selected={speed === value} theme={theme} onClick={() => onConfigChange("audioSpeed", value)}>
                                        {audioSpeedLabel(value)}
                                    </OptionPill>
                                ))}
                            </div>
                            <input
                                type="number"
                                min={0.25}
                                max={4}
                                step={0.05}
                                className="h-9 w-full rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::placeholder]:opacity-50"
                                style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                                value={config.audioSpeed || "1"}
                                onChange={(event) => onConfigChange("audioSpeed", event.target.value)}
                                onBlur={(event) => onConfigChange("audioSpeed", normalizeAudioSpeedValue(event.target.value))}
                                onMouseDown={(event) => event.stopPropagation()}
                            />
                        </SettingGroup>
                        <SettingGroup title={t("settingsPanels.audio.instructions")} color={theme.node.muted}>
                            <textarea
                                value={config.audioInstructions || ""}
                                placeholder={t("settingsPanels.audio.instructionsPlaceholder")}
                                className="thin-scrollbar h-20 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                                style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                                onChange={(event) => onConfigChange("audioInstructions", event.target.value)}
                                onMouseDown={(event) => event.stopPropagation()}
                            />
                        </SettingGroup>
                    </>
                )}
            </div>
        </ImageSettingsTheme>
    );
}

function FireRedSettings({ metadata, onConfigChange, theme, hasAudioReference, onAutoTranscribe }: { config: AiConfig; metadata?: CanvasNodeData["metadata"]; onConfigChange: (key: AudioSettingKey, value: string) => void; theme: CanvasTheme; hasAudioReference: boolean; onAutoTranscribe?: () => Promise<string> }) {
    const { t } = useTranslation();
    const [transcribing, setTranscribing] = useState(false);
    const [transcribeError, setTranscribeError] = useState("");
    const mode = metadata?.audioFireRedMode === "design" || metadata?.audioFireRedMode === "edit" ? metadata.audioFireRedMode : "clone";
    const language = metadata?.audioFireRedLanguage === "en" || metadata?.audioFireRedLanguage === "zh" ? metadata.audioFireRedLanguage : "auto";
    const runAutoTranscribe = async () => {
        if (transcribing || !onAutoTranscribe) return;
        setTranscribing(true);
        setTranscribeError("");
        try {
            onConfigChange("audioFireRedTranscript", (await onAutoTranscribe()).trim());
        } catch (error) {
            if (!(error instanceof DOMException && error.name === "AbortError")) {
                setTranscribeError(error instanceof Error ? error.message : String(error));
            }
        } finally {
            setTranscribing(false);
        }
    };
    return (
        <div className="space-y-3">
            <SettingGroup title={t("canvas.fireRed.mode")} color={theme.node.muted}>
                <div className="grid grid-cols-3 gap-2">
                    {(["clone", "design", "edit"] as const).map((value) => (
                        <OptionPill key={value} selected={mode === value} theme={theme} onClick={() => onConfigChange("audioFireRedMode", value)}>
                            {t(`canvas.fireRed.modes.${value}`)}
                        </OptionPill>
                    ))}
                </div>
                {mode === "edit" ? <p className="!m-0 text-xs leading-5" style={hasAudioReference ? undefined : { color: "#dc2626" }}>{hasAudioReference ? t("canvas.fireRed.editHint") : t("canvas.fireRed.editNeedsAudio")}</p> : null}
                {mode === "clone" && !hasAudioReference ? null : mode === "clone" ? <p className="!m-0 text-xs leading-5" style={{ color: theme.node.muted }}>{t("canvas.fireRed.cloneHint")}</p> : null}
                {mode === "design" ? <p className="!m-0 text-xs leading-5">{t("canvas.fireRed.designHint")}</p> : null}
            </SettingGroup>
            {mode === "clone" ? (
                hasAudioReference ? (
                    <SettingGroup
                        title={t("canvas.fireRed.transcript")}
                        color={theme.node.muted}
                        action={
                            <button
                                type="button"
                                className="inline-flex cursor-pointer items-center gap-1 text-xs transition hover:opacity-75 disabled:cursor-default disabled:opacity-50"
                                style={{ color: theme.node.text }}
                                disabled={transcribing || !onAutoTranscribe}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => void runAutoTranscribe()}
                            >
                                {transcribing ? <LoaderCircle className="size-3 animate-spin" /> : <Wand2 className="size-3" />}
                                {transcribing ? t("canvas.fireRed.transcribing") : t("canvas.fireRed.autoTranscribe")}
                            </button>
                        }
                    >
                        <textarea
                            value={metadata?.audioFireRedTranscript || ""}
                            placeholder={t("canvas.fireRed.transcriptPlaceholder")}
                            className="thin-scrollbar h-12 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                            style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                            onChange={(event) => onConfigChange("audioFireRedTranscript", event.target.value)}
                            onMouseDown={(event) => event.stopPropagation()}
                        />
                        {transcribeError ? <p className="!m-0 text-xs leading-4" style={{ color: theme.node.text, opacity: 0.75 }}>{transcribeError}</p> : null}
                    </SettingGroup>
                ) : (
                    <SettingGroup title={t("canvas.fireRed.transcript")} color={theme.node.muted}>
                        <p className="!m-0 text-xs leading-5" style={{ color: "#dc2626" }}>{t("canvas.fireRed.cloneNeedsAudio")}</p>
                    </SettingGroup>
                )
            ) : null}
            {mode === "design" ? (
                <SettingGroup title={t("canvas.fireRed.voiceDescription")} color={theme.node.muted}>
                    <textarea
                        value={metadata?.audioFireRedVoiceDesc || ""}
                        placeholder={t("canvas.fireRed.voiceDescriptionPlaceholder")}
                        className="thin-scrollbar h-12 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                        style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                        onChange={(event) => onConfigChange("audioFireRedVoiceDesc", event.target.value)}
                        onMouseDown={(event) => event.stopPropagation()}
                    />
                </SettingGroup>
            ) : null}
            {mode !== "edit" ? (
                <SettingGroup title={t("canvas.fireRed.language")} color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2">
                        {(["auto", "zh", "en"] as const).map((value) => (
                            <OptionPill key={value} selected={language === value} theme={theme} onClick={() => onConfigChange("audioFireRedLanguage", value)}>
                                {t(`canvas.fireRed.languages.${value}`)}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
            ) : null}
            <SettingGroup title={t("canvas.fireRed.seed")} color={theme.node.muted}>
                <input
                    type="number"
                    min={0}
                    step={1}
                    className="h-8 w-full rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none [&::placeholder]:opacity-50"
                    style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                    placeholder={t("canvas.fireRed.seedPlaceholder")}
                    value={metadata?.audioFireRedSeed || ""}
                    onChange={(event) => onConfigChange("audioFireRedSeed", event.target.value)}
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

function SettingGroup({ title, color, action, children }: { title: string; color: string; action?: ReactNode; children: ReactNode }) {
    return (
        <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs font-medium" style={{ color }}>
                <span>{title}</span>
                {action}
            </div>
            {children}
        </div>
    );
}
