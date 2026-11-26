import { type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, useRef, useState } from "react";
import { Slider } from "radix-ui";
import { Switch } from "@infinite-canvas/plugin-sdk/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@infinite-canvas/plugin-sdk/ui/tooltip";

import { H3_DEFAULT_STEPS, H3_MAX_STEPS, isMiniMaxH3, isMiniMaxH3Fast } from "@workbench/constant/comfyui";
import { getDreamMakerVideoSpec } from "@workbench/constant/dreammaker";
import { type CanvasTheme } from "@workbench/lib/canvas-theme";
import { normalizeGenerationOptions, visibleOptions } from "@workbench/lib/generation-options";
import { clampVideoSeconds, computeVideoSize, inferVideoRatio, parseAspectRatio, parseVideoResolution, readVideoDimensions, VIDEO_SECONDS_MAX, VIDEO_SECONDS_MIN, videoRatioOptions } from "@workbench/lib/media-size";
import { ArrowLeftRight, ChevronDown } from "lucide-react";
import { boolConfig, type AiConfig } from "@workbench/stores/use-config-store";

const videoModeOptions = [
    { value: "frames", label: "首尾帧模式" },
    { value: "reference", label: "全能参考模式" },
];
const resolutionOptions = [
    { value: "480", label: "480p" },
    { value: "720", label: "720p" },
    { value: "1080", label: "1080p" },
];

const h3ResolutionOptions = [...resolutionOptions, { value: "1440", label: "2K" }, { value: "2160", label: "4K" }];

export const videoResolutionOptions = resolutionOptions.map((item) => ({ value: item.value, label: item.label }));
export const videoSizeOptions = videoRatioOptions.map((item) => ({ value: item.value, label: item.value === "auto" ? "自动" : item.value }));
export const videoSecondsRange = { min: VIDEO_SECONDS_MIN, max: VIDEO_SECONDS_MAX };

type VideoSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: "vquality" | "videoSize" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoMode" | "videoSteps" | "videoSeed" | "videoRefImageSize" | "videoHd", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

export function VideoSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5" }: VideoSettingsPanelProps) {
    const activeModel = config.model || config.videoModel;
    const h3 = isMiniMaxH3(activeModel);
    const fast = isMiniMaxH3Fast(activeModel);
    const dmSpec = getDreamMakerVideoSpec(activeModel);
    const dmSeedance = dmSpec?.family === "seedance";
    const dmH3 = dmSpec?.family === "h3";
    const modes = dmSeedance
        ? [
              { value: "text", label: "文生视频" },
              { value: "frames", label: "图生视频" },
              { value: "reference", label: "多模态参考" },
              ...(dmSpec.supportsEditExtend ? [{ value: "edit", label: "视频编辑" }, { value: "extend", label: "视频延长" }] : []),
          ]
        : h3 || dmH3
          ? [{ value: "text", label: "文生视频" }, { value: "frames", label: "图生视频" }, { value: "reference", label: "参考生视频" }]
          : videoModeOptions;
    const isSmartSeconds = dmSeedance && String(config.videoSeconds || "").trim() === "-1";
    const maxSeconds = dmSpec ? dmSpec.maxSeconds : VIDEO_SECONDS_MAX;
    const rawSeconds = Math.max(VIDEO_SECONDS_MIN, Math.min(maxSeconds, Math.floor(Number(config.videoSeconds) || 6)));
    const seconds = Number(clampVideoSeconds(String(rawSeconds)));
    const rawMode = normalizeVideoModeValue(config.videoMode);
    const videoMode = modes.some((item) => item.value === rawMode) ? rawMode : "frames";
    const rawQuality = (config.vquality || "").trim().toLowerCase();
    const resolution = dmSeedance && rawQuality === "480_draft" && dmSpec.resolutions.includes("480_draft")
        ? "480_draft"
        : dmSpec
          ? dmSpec.resolutions.includes(parseVideoResolution(config.vquality))
              ? parseVideoResolution(config.vquality)
              : dmSpec.defaultResolution
          : parseVideoResolution(config.vquality);
    const selectedRatio = inferVideoRatio(config.videoSize || config.size || "auto");
    const dimensions = readVideoDimensions(config.videoSize || config.size || "auto", resolution === "480_draft" ? "480" : resolution, selectedRatio);
    const options = normalizeGenerationOptions(config.generationOptions);
    const resolutionList = dmSpec
        ? dmSpec.resolutions.map((value) => ({ value, label: value === "480_draft" ? "480p 草稿" : value === "1440" ? "2K" : value === "2160" ? "4K" : value === "768" ? "768P" : `${value}p` }))
        : h3
          ? h3ResolutionOptions
          : visibleOptions(options.videoResolution.filter((option) => option.enabled), resolution);
    const ratioEntries = options.videoRatio.map((option) => ({ ...option, ...(parseAspectRatio(option.value) ?? { width: 0, height: 0 }) }));
    const ratioList = visibleOptions(ratioEntries.filter((option) => option.enabled), selectedRatio)
        .map((option) => ({ ...option, ...(parseAspectRatio(option.value) ?? { width: 0, height: 0 }) }));
    const applySize = (nextResolution: string, ratio: string) => {
        onConfigChange("vquality", nextResolution);
        onConfigChange("videoSize", dmSpec ? ratio : computeVideoSize(nextResolution === "480_draft" ? "480" : nextResolution, ratio));
    };
    const selectResolution = (nextResolution: string) => {
        if (selectedRatio === "auto" || dmSpec) onConfigChange("vquality", nextResolution);
        else applySize(nextResolution, selectedRatio);
    };

    return (
        <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
            {showTitle ? <div className="text-lg font-semibold">视频设置</div> : null}
            {h3 || dmSeedance ? (
                <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-medium">生成声音</span>
                        <Switch size="sm" aria-label="生成声音" checked={boolConfig(config.videoGenerateAudio, true)} onCheckedChange={(checked) => onConfigChange("videoGenerateAudio", String(checked))} />
                    </div>
                    <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                        {dmSeedance ? "开启后同期生成环境音效或人声；无需音轨时关闭（输出纯静音）。" : "关闭后输出静音视频。只去掉配乐、保留人声或音效，请在提示词中说明。"}
                    </p>
                </div>
            ) : null}
            <SettingGroup title="清晰度" color={theme.node.muted}>
                <div className={`grid ${resolutionList.length >= 4 || h3 ? "grid-cols-3" : dmSpec ? "grid-cols-2" : "grid-cols-4"} gap-2.5`}>
                    {resolutionList.map((item) => (
                        <OptionPill key={item.value} selected={resolution === item.value} theme={theme} onClick={() => selectResolution(item.value)}>
                            {item.label}
                        </OptionPill>
                    ))}
                    {!dmSpec ? <ResolutionInput value={resolution} theme={theme} onChange={selectResolution} /> : null}
                </div>
                {h3 && Number(resolution) > 1440 ? <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>按分辨率和时长自动选择生成尺寸（越长越省），再经放大链补到目标分辨率：更稳、显存更省。</p> : null}
                {dmSeedance && resolution === "480_draft" ? <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>低算力预览草稿，生成后可在视频节点一键升级为 1080p 或 4K 正式成片。</p> : null}
            </SettingGroup>
            {!dmSpec ? (
                <SettingGroup title="尺寸" color={theme.node.muted}>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                        <DimensionInput prefix="W" value={dimensions.width} disabled={selectedRatio === "auto"} theme={theme} onChange={(value) => updateDimension("width", value, dimensions, onConfigChange)} />
                        <ArrowLeftRight className="size-4 opacity-45" aria-hidden="true" />
                        <DimensionInput prefix="H" value={dimensions.height} disabled={selectedRatio === "auto"} theme={theme} onChange={(value) => updateDimension("height", value, dimensions, onConfigChange)} />
                    </div>
                </SettingGroup>
            ) : null}
            <SettingGroup title="比例" color={theme.node.muted}>
                <div className="grid grid-cols-4 gap-2.5">
                    {ratioList.map((item) => (
                        <button
                            key={item.value}
                            type="button"
                            className="flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border bg-transparent text-sm transition hover:opacity-80"
                            style={{ borderColor: selectedRatio === item.value ? theme.node.text : theme.node.stroke, color: theme.node.text }}
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={() => applySize(resolution, item.value)}
                        >
                            <SizePreview width={item.width} height={item.height} color={theme.node.text} />
                            <span>{item.value === "auto" ? "自动" : item.value}</span>
                        </button>
                    ))}
                </div>
                {dmSeedance && videoMode === "frames" ? (
                    <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                        图生视频（首尾帧）模式下输出比例强制跟随首帧图片，此处比例参数不会发送。
                    </p>
                ) : null}
                {dmSeedance && (videoMode === "edit" || videoMode === "extend") ? (
                    <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                        视频编辑 / 延长模式下输出比例固定自适应原视频。
                    </p>
                ) : null}
            </SettingGroup>
            <SettingGroup title="秒数" color={theme.node.muted}>
                {dmSeedance && videoMode === "edit" ? (
                    <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                        视频编辑模式时长由原视频决定（自动）。
                    </p>
                ) : (
                    <div className="space-y-2">
                        <div className="flex items-center gap-3" onMouseDown={(event) => event.stopPropagation()}>
                            <DurationSlider seconds={seconds} max={maxSeconds} disabled={isSmartSeconds} theme={theme} onChange={(value) => onConfigChange("videoSeconds", String(value))} />
                            <SecondsInput value={seconds} max={maxSeconds} disabled={isSmartSeconds} theme={theme} onCommit={(value) => onConfigChange("videoSeconds", String(value))} />
                            <span className="shrink-0 text-sm" style={{ color: theme.node.muted }}>s</span>
                        </div>
                        {dmSeedance ? (
                            <div className="flex items-center justify-between gap-2">
                                <span className="text-xs" style={{ color: theme.node.muted }}>智能时长（由模型自动决定）</span>
                                <Switch size="sm" checked={isSmartSeconds} onCheckedChange={(checked) => onConfigChange("videoSeconds", checked ? "-1" : String(seconds))} />
                            </div>
                        ) : null}
                    </div>
                )}
            </SettingGroup>
            <SettingGroup title="模式" color={theme.node.muted}>
                <div className={`grid ${modes.length >= 3 ? "grid-cols-3" : "grid-cols-2"} gap-2.5`}>
                    {modes.map((item) => (
                        <OptionPill key={item.value} selected={videoMode === item.value} theme={theme} onClick={() => onConfigChange("videoMode", item.value)}>
                            {item.label}
                        </OptionPill>
                    ))}
                </div>
            </SettingGroup>
            {dmSpec ? (
                <details className="group">
                    <summary className="flex cursor-pointer list-none items-center justify-between py-1 text-sm [&::-webkit-details-marker]:hidden">
                        高级设置
                        <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
                    </summary>
                    <div className="space-y-3 pt-2">
                        {dmSeedance ? (
                            <div className="space-y-1.5">
                                <SettingTitle color={theme.node.muted}>随机种子</SettingTitle>
                                <input type="text" value={config.videoSeed || ""} placeholder="留空随机 (-1)" className="h-9 w-full rounded-xl border bg-transparent px-3 text-sm outline-none" style={{ borderColor: theme.node.stroke, color: theme.node.text }} onChange={(event) => onConfigChange("videoSeed", event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
                                <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>Seedance 网关不支持 camera_fixed 字段；如需锁机位，请用「优化提示词」写入锁机位描述。</p>
                            </div>
                        ) : null}
                        <div className="flex items-center justify-between gap-3">
                            <span className="text-sm font-medium">添加水印</span>
                            <Switch size="sm" checked={boolConfig(config.videoWatermark, false)} onCheckedChange={(checked) => onConfigChange("videoWatermark", String(checked))} />
                        </div>
                    </div>
                </details>
            ) : null}
            {h3 ? (
                <details className="group">
                    <summary className="flex cursor-pointer list-none items-center justify-between py-1 text-sm [&::-webkit-details-marker]:hidden">
                        高级设置
                        <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
                    </summary>
                    <div className="space-y-3 pt-2">
                        <div className="space-y-1.5">
                            <SettingTitle color={theme.node.muted}>底模精度</SettingTitle>
                            <div className="grid grid-cols-2 gap-2.5">
                                <OptionPill selected={!boolConfig(config.videoHd, false)} theme={theme} onClick={() => onConfigChange("videoHd", "false")}>
                                    标准显存 (int8)
                                </OptionPill>
                                <OptionPill selected={boolConfig(config.videoHd, false)} theme={theme} onClick={() => onConfigChange("videoHd", "true")}>
                                    高精度 (BF16)
                                </OptionPill>
                            </div>
                        </div>
                        {!fast ? (
                            <div className="space-y-1.5">
                                <SettingTitle color={theme.node.muted}>{`采样步数 (1-${H3_MAX_STEPS})`}</SettingTitle>
                                <input type="text" value={config.videoSteps || String(H3_DEFAULT_STEPS)} className="h-9 w-full rounded-xl border bg-transparent px-3 text-sm outline-none" style={{ borderColor: theme.node.stroke, color: theme.node.text }} onChange={(event) => onConfigChange("videoSteps", event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
                            </div>
                        ) : null}
                        <div className="space-y-1.5">
                            <SettingTitle color={theme.node.muted}>随机种子</SettingTitle>
                            <input type="text" value={config.videoSeed || ""} placeholder="留空随机" className="h-9 w-full rounded-xl border bg-transparent px-3 text-sm outline-none" style={{ borderColor: theme.node.stroke, color: theme.node.text }} onChange={(event) => onConfigChange("videoSeed", event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
                        </div>
                        {videoMode === "reference" ? (
                            <div className="space-y-1.5">
                                <SettingTitle color={theme.node.muted}>参考图细节</SettingTitle>
                                <div className="grid grid-cols-2 gap-2.5">
                                    <OptionPill selected={config.videoRefImageSize !== "max"} theme={theme} onClick={() => onConfigChange("videoRefImageSize", "match")}>
                                        自动匹配
                                    </OptionPill>
                                    <OptionPill selected={config.videoRefImageSize === "max"} theme={theme} onClick={() => onConfigChange("videoRefImageSize", "max")}>
                                        保留更多
                                    </OptionPill>
                                </div>
                            </div>
                        ) : null}
                    </div>
                </details>
            ) : null}
        </div>
    );
}

export function videoResolutionLabel(value: string) {
    if (String(value || "").trim().toLowerCase() === "480_draft") return "草稿";
    const resolution = parseVideoResolution(value);
    return resolution === "1440" ? "2K" : resolution === "2160" ? "4K" : resolution === "768" ? "768P" : `${resolution}p`;
}

export function videoSizeLabel(value: string) {
    const ratio = inferVideoRatio(value);
    return ratio === "auto" ? "自适应" : ratio;
}

export function videoSecondsLabel(value: string) {
    if (String(value).trim() === "-1") return "智能";
    return `${value || "6"}s`;
}

export function videoModeLabel(value: string) {
    return ({ "frames": "首尾帧模式", "reference": "全能参考模式", "text": "文生视频", "edit": "视频编辑", "extend": "视频延长" } as Record<string, string>)[normalizeVideoModeValue(value)];
}

export function videoAudioLabel(value: string) {
    return boolConfig(value, true) ? "有声" : "静音";
}

export function normalizeVideoModeValue(value: string | undefined) {
    return value === "reference" || value === "text" || value === "edit" || value === "extend" ? value : "frames";
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
    onConfigChange("videoSize", `${key === "width" ? next : dimensions.width}x${key === "height" ? next : dimensions.height}`);
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

function SettingTitle({ children, color }: { children: string; color: string }) {
    return (
        <div className="text-xs font-medium" style={{ color }}>
            {children}
        </div>
    );
}

function DurationSlider({ seconds, max = VIDEO_SECONDS_MAX, disabled = false, theme, onChange }: { seconds: number; max?: number; disabled?: boolean; theme: CanvasTheme; onChange: (value: number) => void }) {
    const [tipOpen, setTipOpen] = useState(false);
    const [tipInteraction, setTipInteraction] = useState<"keyboard" | "drag" | null>(null);
    const drag = useRef<{ pointerId: number; seconds: number; x: number } | null>(null);
    const span = max - VIDEO_SECONDS_MIN;
    const pointerX = (event: PointerEvent) => event.pointerType === "mouse" ? Math.floor(event.pageX) : event.pageX;

    function moveThumb(event: PointerEvent<HTMLSpanElement>) {
        if (disabled) return;
        const start = drag.current;
        if (!start || event.pointerId !== start.pointerId) return;
        event.preventDefault();
        const delta = (pointerX(event) - start.x) / event.currentTarget.getBoundingClientRect().width * span;
        const value = Math.max(VIDEO_SECONDS_MIN, Math.min(max, start.seconds + delta));
        const next = [VIDEO_SECONDS_MIN, max, start.seconds, Math.round(value)].reduce((best, candidate) =>
            Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best);
        if (next !== seconds) onChange(next);
    }

    function handleKey(event: KeyboardEvent<HTMLSpanElement>) {
        if (disabled) return;
        let delta: number;
        switch (event.key) {
            case "Home": case "End": setTipInteraction("keyboard"); return;
            case "PageUp": delta = 2; break;
            case "PageDown": delta = -2; break;
            case "ArrowUp": case "ArrowRight": delta = 1; break;
            case "ArrowDown": case "ArrowLeft": delta = -1; break;
            default: return;
        }
        setTipInteraction("keyboard");
        if (event.key.startsWith("Arrow") && !event.shiftKey) return;
        event.preventDefault();
        const next = Math.max(VIDEO_SECONDS_MIN, Math.min(max, seconds + delta));
        if (next !== seconds) onChange(next);
    }

    return <TooltipProvider>
        <Slider.Root className="group relative mx-[5px] my-[11px] flex h-3 min-w-0 flex-1 touch-none items-center py-1 select-none"
            style={{ "--duration-active": theme.node.activeStroke, "--duration-handle": theme.toolbar.panel, color: theme.node.text, opacity: disabled ? 0.45 : 1 } as CSSProperties}
            min={VIDEO_SECONDS_MIN} max={max} step={1} disabled={disabled} value={[seconds]} onValueChange={([value]) => onChange(value)}
            onKeyDown={handleKey} onPointerMove={moveThumb}
            onPointerDown={(event) => { if (!disabled && event.button === 0) setTipInteraction("drag"); else event.preventDefault(); }}
            onLostPointerCapture={() => { drag.current = null; setTipInteraction(null); }}>
            <Slider.Track className="relative h-1 w-full rounded-full" style={{ background: theme.node.stroke }}>
                <Slider.Range className="absolute h-full rounded-full bg-(--duration-active) group-hover:bg-[light-dark(#1a1a1a,var(--duration-active))]" />
            </Slider.Track>
            <Tooltip open={!disabled && (tipOpen || tipInteraction !== null)} onOpenChange={setTipOpen}>
                <TooltipTrigger asChild>
                    <Slider.Thumb aria-label="视频秒数" aria-valuetext={`${seconds} 秒`}
                        style={{ translate: `${(seconds - VIDEO_SECONDS_MIN) / span * 100 - 50}%` }}
                        onPointerDown={(event) => { if (!disabled && event.button === 0) drag.current = { pointerId: event.pointerId, seconds, x: pointerX(event) }; }}
                        onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) setTipInteraction("keyboard"); }} onBlur={() => setTipInteraction(null)}
                        className="relative block size-2.5 cursor-pointer rounded-full outline-none before:absolute before:-inset-0.5 after:absolute after:inset-0 after:rounded-full after:bg-(--duration-handle) after:shadow-[0_0_0_2px_currentColor] hover:after:scale-120 focus:after:scale-120 hover:after:outline-5 focus:after:outline-5 after:outline-current/20" />
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6} onEscapeKeyDown={() => setTipInteraction(null)} style={{ color: `light-dark(${theme.node.panel}, white)` }}
                    className="pointer-events-none z-[1300] rounded-md bg-[light-dark(rgb(0_0_0_/_85%),#424242)] px-2 py-1.5 text-sm leading-5 shadow-lg [&_svg]:bg-[light-dark(rgb(0_0_0_/_85%),#424242)] [&_svg]:fill-[light-dark(rgb(0_0_0_/_85%),#424242)]">{seconds}</TooltipContent>
            </Tooltip>
        </Slider.Root>
    </TooltipProvider>;
}

function SecondsInput({ value, max = VIDEO_SECONDS_MAX, disabled = false, theme, onCommit }: { value: number; max?: number; disabled?: boolean; theme: CanvasTheme; onCommit: (value: number) => void }) {
    const commit = (input: HTMLInputElement) => {
        const parsed = Math.floor(Number(input.value) || 6);
        const next = Math.max(VIDEO_SECONDS_MIN, Math.min(max, parsed));
        input.value = String(next);
        onCommit(next);
    };

    return (
        <label className="flex h-9 w-[68px] shrink-0 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <input
                type="number"
                min={VIDEO_SECONDS_MIN}
                max={max}
                disabled={disabled}
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
