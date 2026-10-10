import { type ReactNode } from "react";
import { InputNumber, Slider, Switch } from "antd";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { H3_DEFAULT_STEPS, H3_MAX_STEPS, isMiniMaxH3, isMiniMaxH3Fast } from "@/constant/comfyui";
import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { clampVideoSeconds, computeVideoSize, inferVideoRatio, parseVideoResolution, readVideoDimensions, VIDEO_SECONDS_MAX, VIDEO_SECONDS_MIN, videoRatioOptions } from "@/lib/media-size";
import { boolConfig, type AiConfig } from "@/stores/use-config-store";

const resolutionOptions = [
    { value: "480", label: "480p" },
    { value: "720", label: "720p" },
    { value: "1080", label: "1080p" },
];
// H3 (both cloud versions) natively generates up to 2K; 4K samples at half size and upscales 2x via RTX Video Super Resolution.
const h3ResolutionOptions = [...resolutionOptions, { value: "1440", label: "2K" }, { value: "2160", label: "4K" }];
const videoModeOptions = [
    { value: "frames", labelKey: "frames" },
    { value: "reference", labelKey: "reference" },
];

export const videoResolutionOptions = resolutionOptions.map((item) => ({ value: item.value, label: item.label }));
export const videoSizeOptions = videoRatioOptions.map((item) => ({ value: item.value, get label() { return item.value === "auto" ? i18n.t("settingsPanels.common.auto") : item.value; } }));
export const videoSecondsRange = { min: VIDEO_SECONDS_MIN, max: VIDEO_SECONDS_MAX };

type VideoSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "vquality" | "size" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoMode" | "videoSteps" | "videoSeed" | "videoRefImageSize" | "videoHd", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

export function VideoSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5" }: VideoSettingsPanelProps) {
    const { t } = useTranslation();
    const h3 = isMiniMaxH3(config.model || config.videoModel);
    const fast = isMiniMaxH3Fast(config.model || config.videoModel);
    const modes = h3 ? [{ value: "text", labelKey: "text" }, ...videoModeOptions] : videoModeOptions;
    const seconds = Number(clampVideoSeconds(config.videoSeconds || "6"));
    const videoMode = normalizeVideoModeValue(config.videoMode);
    const resolution = parseVideoResolution(config.vquality);
    const selectedRatio = inferVideoRatio(config.size || "auto");
    const dimensions = readVideoDimensions(config.size || "auto", resolution, selectedRatio);
    const applySize = (nextResolution: string, ratio: string) => {
        onConfigChange("vquality", nextResolution);
        onConfigChange("size", computeVideoSize(nextResolution, ratio));
    };
    const selectResolution = (nextResolution: string) => {
        if (selectedRatio === "auto") onConfigChange("vquality", nextResolution);
        else applySize(nextResolution, selectedRatio);
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.video.title")}</div> : null}
                {h3 ? (
                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-sm font-medium">{t("settingsPanels.video.generateAudio")}</span>
                            <Switch size="small" aria-label="生成声音" checked={boolConfig(config.videoGenerateAudio, true)} onChange={(checked) => onConfigChange("videoGenerateAudio", String(checked))} />
                        </div>
                        <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>关闭后输出静音视频。只去掉配乐、保留人声或音效，请在提示词中说明。</p>
                    </div>
                ) : null}
                <SettingGroup title={t("settingsPanels.video.quality")} color={theme.node.muted}>
                    <div className={`grid ${h3 ? "grid-cols-3" : "grid-cols-4"} gap-2.5`}>
                        {(h3 ? h3ResolutionOptions : resolutionOptions).map((item) => (
                            <OptionPill key={item.value} selected={resolution === item.value} theme={theme} onClick={() => selectResolution(item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                        <ResolutionInput value={resolution} theme={theme} onChange={selectResolution} />
                    </div>
                    {h3 && Number(resolution) > 1440 ? <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>按分辨率和时长自动选择生成尺寸（越长越省），再经放大链补到目标分辨率：更稳、显存更省。</p> : null}
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.size")} color={theme.node.muted}>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                        <DimensionInput prefix="W" value={dimensions.width} disabled={selectedRatio === "auto"} theme={theme} onChange={(value) => updateDimension("width", value, dimensions, onConfigChange)} />
                        <span className="text-lg opacity-45">↔</span>
                        <DimensionInput prefix="H" value={dimensions.height} disabled={selectedRatio === "auto"} theme={theme} onChange={(value) => updateDimension("height", value, dimensions, onConfigChange)} />
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.ratio")} color={theme.node.muted}>
                    <div className="grid grid-cols-4 gap-2.5">
                        {videoRatioOptions.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className="flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border bg-transparent text-sm transition hover:opacity-80"
                                style={{ borderColor: selectedRatio === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => applySize(resolution, item.value)}
                            >
                                <SizePreview width={item.width} height={item.height} color={theme.node.text} />
                                <span>{item.value === "auto" ? t("settingsPanels.common.auto") : item.value}</span>
                            </button>
                        ))}
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.seconds")} color={theme.node.muted}>
                    <div className="flex items-center gap-3" onMouseDown={(event) => event.stopPropagation()}>
                        <Slider className="min-w-0 flex-1" min={VIDEO_SECONDS_MIN} max={VIDEO_SECONDS_MAX} step={1} value={seconds} onChange={(value) => onConfigChange("videoSeconds", String(Array.isArray(value) ? value[0] : value))} />
                        <SecondsInput value={seconds} theme={theme} onCommit={(value) => onConfigChange("videoSeconds", String(value))} />
                        <span className="shrink-0 text-sm" style={{ color: theme.node.muted }}>s</span>
                    </div>
                </SettingGroup>
                <SettingGroup title={t("settingsPanels.video.mode")} color={theme.node.muted}>
                    <div className={`grid ${h3 ? "grid-cols-3" : "grid-cols-2"} gap-2.5`}>
                        {modes.map((item) => (
                            <OptionPill key={item.value} selected={videoMode === item.value} theme={theme} onClick={() => onConfigChange("videoMode", item.value)}>
                                {h3 ? { text: "文生视频", frames: "图生视频", reference: "参考生视频" }[item.value as "text" | "frames" | "reference"] : t(`settingsPanels.video.modes.${item.labelKey}`)}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
                {h3 ? (
                    <details className="group">
                        <summary className="!flex cursor-pointer list-none items-center justify-between py-1 text-sm [&::-webkit-details-marker]:hidden">
                            高级设置
                            <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
                        </summary>
                        <div className="space-y-4 pt-3">
                            <SettingGroup title="底模精度" color={theme.node.muted}>
                                <div className="grid grid-cols-2 gap-2.5">
                                    <OptionPill selected={!boolConfig(config.videoHd, false)} theme={theme} onClick={() => onConfigChange("videoHd", "false")}>标准</OptionPill>
                                    <OptionPill selected={boolConfig(config.videoHd, false)} theme={theme} onClick={() => onConfigChange("videoHd", "true")}>高精度</OptionPill>
                                </div>
                                <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                                    {boolConfig(config.videoHd, false)
                                        ? "BF16 全精度底模 + FP16 VAE，画质更高，耗时约增加 30-160%，首次切换需重新加载模型。"
                                        : "INT8 量化底模 + INT8 VAE，速度优先，适合日常生成。"}
                                </p>
                            </SettingGroup>
                            {fast ? (
                                <SettingGroup title="加速配方" color={theme.node.muted}>
                                    <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>DMAD 蒸馏 LoRA + kitchen INT8 注意力 + SelfLiftAvatar 分块采样（低清→升维→空间分块）+ SigmaRefiner 尾段精修。比标准版快一个数量级。</p>
                                </SettingGroup>
                            ) : (
                                <SettingGroup title="采样步数" color={theme.node.muted}>
                                    <InputNumber className="!w-full !rounded-xl" aria-label="采样步数" min={1} max={H3_MAX_STEPS} precision={0} placeholder={String(H3_DEFAULT_STEPS)} value={config.videoSteps ? Number(config.videoSteps) : null} onChange={(value) => onConfigChange("videoSteps", value === null ? "" : String(value))} />
                                    <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>默认 {H3_DEFAULT_STEPS} 步，步数越多通常耗时越长。</p>
                                </SettingGroup>
                            )}
                            <SettingGroup title="随机种子" color={theme.node.muted}>
                                <InputNumber className="!w-full !rounded-xl" aria-label="随机种子" min={0} max={Number.MAX_SAFE_INTEGER} precision={0} controls={false} placeholder="留空，每次随机" value={config.videoSeed ? Number(config.videoSeed) : null} onChange={(value) => onConfigChange("videoSeed", value === null ? "" : String(value))} />
                                <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>固定种子便于在相同参数下对比结果。</p>
                            </SettingGroup>
                            {videoMode === "reference" ? (
                                <SettingGroup title="参考图细节" color={theme.node.muted}>
                                    <div className="grid grid-cols-2 gap-2.5">
                                        <OptionPill selected={config.videoRefImageSize !== "max"} theme={theme} onClick={() => onConfigChange("videoRefImageSize", "match")}>自动匹配</OptionPill>
                                        <OptionPill selected={config.videoRefImageSize === "max"} theme={theme} onClick={() => onConfigChange("videoRefImageSize", "max")}>保留更多</OptionPill>
                                    </div>
                                    <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>保留大参考图的更多细节会增加耗时；小图不会被放大。</p>
                                </SettingGroup>
                            ) : null}
                        </div>
                    </details>
                ) : null}
                {h3 ? <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>{fast ? "加速版由云端 ComfyUI 生成，速度优先；追求最高画质请用标准版。图生视频按图片顺序使用首帧、尾帧；参考生视频可在提示词中用 <Picture 1> 指定图片。" : "由云端 ComfyUI 生成。图生视频按图片顺序使用首帧、尾帧；参考生视频可在提示词中用 &lt;Picture 1&gt; 指定图片。尺寸和时长会对齐模型支持的格式。"}比例为「自动」并连接参考视频时，输出尺寸和时长会自动跟随该视频。</p> : null}
            </div>
        </ImageSettingsTheme>
    );
}

export function videoResolutionLabel(value: string) {
    const resolution = parseVideoResolution(value);
    return resolution === "1440" ? "2K" : resolution === "2160" ? "4K" : `${resolution}p`;
}

export function videoSizeLabel(value: string) {
    const ratio = inferVideoRatio(value);
    return ratio === "auto" ? i18n.t("settingsPanels.video.adaptive") : ratio;
}

export function videoSecondsLabel(value: string) {
    if (String(value).trim() === "-1") return i18n.t("settingsPanels.video.smart");
    return `${value || "6"}s`;
}

export function videoModeLabel(value: string) {
    return i18n.t(`settingsPanels.video.modes.${normalizeVideoModeValue(value)}`);
}

export function videoAudioLabel(value: string) {
    return boolConfig(value, true) ? "有声" : "静音";
}

export function normalizeVideoModeValue(value: string | undefined) {
    return value === "reference" || value === "text" ? value : "frames";
}

export function normalizeVideoSizeValue(value: string, resolution = "720") {
    if (value === "auto") return "auto";
    if (/^\d+x\d+$/.test(value || "")) return value;
    const ratio = inferVideoRatio(value);
    return ratio === "auto" ? "auto" : computeVideoSize(resolution, ratio);
}

export function normalizeVideoResolutionValue(value: string) {
    return parseVideoResolution(value);
}

function updateDimension(key: "width" | "height", value: number | null, dimensions: { width: number; height: number }, onConfigChange: VideoSettingsPanelProps["onConfigChange"]) {
    const next = Math.max(1, Math.floor(value || dimensions[key] || 720));
    onConfigChange("size", `${key === "width" ? next : dimensions.width}x${key === "height" ? next : dimensions.height}`);
}

function OptionPill({ selected, disabled = false, theme, onClick, children }: { selected: boolean; disabled?: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" disabled={disabled} className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-35" style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()} onClick={onClick}>
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

function ResolutionInput({ value, theme, onChange }: { value: string; theme: CanvasTheme; onChange: (value: string) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input type="number" min={1} className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value} onChange={(event) => onChange(event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
            <span className="grid w-7 place-items-center pr-1" style={{ color: theme.node.muted }}>
                p
            </span>
        </label>
    );
}

function SecondsInput({ value, theme, onCommit }: { value: number; theme: CanvasTheme; onCommit: (value: number) => void }) {
    const commit = (input: HTMLInputElement) => {
        const next = Number(clampVideoSeconds(input.value));
        input.value = String(next);
        onCommit(next);
    };

    return (
        <label className="flex h-9 w-[68px] shrink-0 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text }}>
            <input
                type="number"
                min={VIDEO_SECONDS_MIN}
                max={VIDEO_SECONDS_MAX}
                className="min-w-0 flex-1 bg-transparent px-2 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                defaultValue={value}
                key={value}
                onBlur={(event) => commit(event.currentTarget)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function DimensionInput({ prefix, value, disabled, theme, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input type="number" min={1} disabled={disabled} className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" value={value || ""} onChange={(event) => onChange(Number(event.target.value) || null)} onMouseDown={(event) => event.stopPropagation()} />
        </label>
    );
}

function SizePreview({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const longSide = Math.max(width, height);
    const previewWidth = Math.max(10, Math.round((width / longSide) * 26));
    const previewHeight = Math.max(10, Math.round((height / longSide) * 26));
    return <span className="rounded-[3px] border-2" style={{ width: previewWidth, height: previewHeight, borderColor: color }} />;
}
