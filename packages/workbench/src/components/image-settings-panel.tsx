import { generationLevelLabels } from "@workbench/constant/labels";
import { type ReactNode, useEffect, useState } from "react";
import { Switch } from "@infinite-canvas/plugin-sdk/ui/switch";
import { ChevronDown, ArrowLeftRight } from "lucide-react";

import { isQwenImage21, QWEN_IMAGE_21_DEFAULT_STEPS, QWEN_IMAGE_21_MAX_STEPS } from "@workbench/constant/comfyui";
import { getDreamMakerImageSpec } from "@workbench/constant/dreammaker";
import { alignQwen32, resolveQwenCanvasPlan } from "@workbench/services/api/comfyui-qwen";
import { type CanvasTheme } from "@workbench/lib/canvas-theme";
import { normalizeGenerationOptions, visibleOptions } from "@workbench/lib/generation-options";
import { readImageMeta } from "@workbench/lib/image-utils";
import { computeMediaSize, inferMediaRatio, inferMediaScale, mediaRatioOptions, mediaScaleOptions, parseAspectRatio, parsePixelSize, readMediaDimensions } from "@workbench/lib/media-size";
import { boolConfig, type AiConfig } from "@workbench/stores/use-config-store";

export const imageQualityOptions = [
    { value: "auto", label: "自动" },
    { value: "low", label: "低" },
    { value: "medium", label: "中" },
    { value: "high", label: "高" },
    { value: "xhigh", label: "极高" },
    { value: "max", label: "最高" },
];
const DIMENSION_STEP = 16;

export const imageAspectOptions = mediaRatioOptions.map((item) => ({ value: item.value, label: item.value === "auto" ? "自动" : item.value }));
export const imageScaleOptions = mediaScaleOptions.map((value) => ({ value, label: value === "auto" ? "自动" : value }));

export type ImageConfigKey =
    | "quality"
    | "size"
    | "count"
    | "background"
    | "imageSteps"
    | "imageCfg"
    | "imageSeed"
    | "imageNegative"
    | "imageResolution"
    | "dmMjQuality"
    | "dmMjHd"
    | "dmMjRaw"
    | "dmMjStylize"
    | "dmMjChaos"
    | "dmMjWeird"
    | "dmMjExp"
    | "dmMjTile"
    | "dmMjIw"
    | "dmMjMode"
    | "dmGptFormat"
    | "dmGptModeration"
    | "dmArkSizeTier"
    | "dmArkOptimizePrompt"
    | "dmArkWebSearch"
    | "dmArkLayerDecomposition";

export type ImageReferenceInfo = { count: number; firstUrl?: string };

const qwenResolutionOptions = [
    { value: "1024", label: "1K" },
    { value: "1536", label: "1.5K" },
    { value: "2048", label: "2K" },
    { value: "4096", label: "4K" },
    { value: "0", label: "跟随原图" },
];

type ImageSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: ImageConfigKey, value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    /** 固定宽高比时只保留质量、分辨率与透明背景。 */
    fixedRatio?: string;
    imageReferences?: ImageReferenceInfo;
};

export function ImageSettingsPanel({ config, onConfigChange, theme, showTitle = true, fixedRatio, imageReferences, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5" }: ImageSettingsPanelProps) {
    const activeModel = config.model || config.imageModel;
    const qwen = isQwenImage21(activeModel);
    const dmSpec = getDreamMakerImageSpec(activeModel);
    const dmMj = dmSpec?.family === "mj";
    const dmArk = dmSpec?.family === "ark";
    const dmGpt = dmSpec?.family === "gpt";
    const [snapDimensionToStep, setSnapDimensionToStep] = useState(true);
    const dimensionStep = qwen ? 32 : 16;
    const hasImageReferences = (imageReferences?.count || 0) > 0;
    const [firstReferenceSize, setFirstReferenceSize] = useState<{ width: number; height: number } | null>(null);
    useEffect(() => {
        const url = hasImageReferences ? imageReferences?.firstUrl : undefined;
        if (!url) {
            setFirstReferenceSize(null);
            return;
        }
        let alive = true;
        void readImageMeta(url).then((meta) => {
            if (alive) setFirstReferenceSize({ width: meta.width, height: meta.height });
        });
        return () => {
            alive = false;
        };
    }, [hasImageReferences, imageReferences?.firstUrl]);
    const followOriginal = qwen && hasImageReferences && (config.imageResolution || "1024") === "0";
    const quality = config.quality || "auto";
    const count = Math.max(1, Math.floor(Math.abs(Number(config.count)) || 1));
    const activeSize = config.size || "auto";
    const transparentBackground = config.background === "transparent";
    const selectedScale = inferMediaScale(activeSize);
    const selectedRatio = inferMediaRatio(activeSize);
    const dimensions = readMediaDimensions(activeSize, selectedScale, selectedRatio);
    const editResolution = config.imageResolution || "1024";
    const arkTiers = dmSpec?.arkTiers || ["1K", "2K"];
    const arkTier = arkTiers.includes((config.dmArkSizeTier || "").toUpperCase()) ? (config.dmArkSizeTier || "").toUpperCase() : arkTiers.includes("2K") ? "2K" : arkTiers[0];
    const mjDisplayCount = Math.max(4, Math.min(12, Math.ceil(count / 4) * 4));
    const arkCustomPixels = dmArk ? parsePixelSize(activeSize) : null;
    const qwenPlan = qwen ? resolveQwenCanvasPlan(config, hasImageReferences) : null;
    const qwenDimensions = qwenPlan?.followOriginal ? (firstReferenceSize || { width: 0, height: 0 }) : { width: qwenPlan?.width || 0, height: qwenPlan?.height || 0 };
    const options = normalizeGenerationOptions(config.generationOptions);
    const qualityList = visibleOptions(options.quality.filter((option) => option.enabled), quality);
    const scaleList = visibleOptions(options.imageScale.filter((option) => option.enabled), selectedScale);
    const ratioEntries = options.imageRatio.map((option) => ({ ...option, ...(parseAspectRatio(option.value) ?? { width: 0, height: 0 }) }));
    const ratioList = visibleOptions(ratioEntries.filter((option) => option.enabled), selectedRatio)
        .map((option) => ({ ...option, ...(parseAspectRatio(option.value) ?? { width: 0, height: 0 }) }));
    const countList = visibleOptions(options.imageCount.filter((option) => option.enabled), String(count))
        .map((option) => option.label === option.value ? { ...option, label: `${option.value} 张` } : option)
        .sort((a, b) => Number(a.value) - Number(b.value));
    const applySize = (scale: string, ratio: string) => onConfigChange("size", computeMediaSize(scale, ratio));
    const selectScale = (scale: string) => applySize(scale, fixedRatio ?? (selectedRatio === "auto" ? "1:1" : selectedRatio));
    const selectRatio = (ratio: string) => (qwen || dmMj || dmArk ? onConfigChange("size", ratio) : applySize(selectedScale, ratio));
    const updateDimension = (key: "width" | "height", value: number | null) => {
        if (qwen) {
            const next = alignQwen32(Math.max(256, Math.floor(value || qwenDimensions[key] || 1024)));
            const width = key === "width" ? next : (qwenDimensions.width || 1024);
            const height = key === "height" ? next : (qwenDimensions.height || 1024);
            onConfigChange("size", `${width}x${height}`);
            return;
        }
        const next = Math.max(1, Math.floor(value || dimensions[key] || 1024));
        const width = key === "width" ? next : dimensions.width;
        const height = key === "height" ? next : dimensions.height;
        onConfigChange("size", `${alignDimension(width, snapDimensionToStep, dimensionStep)}x${alignDimension(height, snapDimensionToStep, dimensionStep)}`);
    };

    return (
        <div
            className={`@container ${className}`}
            style={{ color: theme.node.text }}
            onMouseDown={(event) => {
                event.stopPropagation();
                if (event.target instanceof HTMLInputElement) return;
                if (document.activeElement instanceof HTMLInputElement && event.currentTarget.contains(document.activeElement)) document.activeElement.blur();
            }}
        >
            {showTitle ? <div className="text-lg font-semibold">图像设置</div> : null}
            {qwen ? (
                <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                    由云端 ComfyUI 生成（BF16）。无参考图时为文生图；连接参考图后自动变为图像编辑，第一张是编辑目标，提示词里可用 &lt;image1&gt;、&lt;image2&gt; 引用。
                </p>
            ) : null}
            {dmMj ? (
                <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                    {hasImageReferences
                        ? `由 DreamMaker ${dmSpec.label.replace(/（DreamMaker）$/, "")} 生成（每次 4 张）。已连接参考图将作为图像参考 (irefs)，请配合英文视觉描述使用。`
                        : `由 DreamMaker ${dmSpec.label.replace(/（DreamMaker）$/, "")} 生成，每次出图固定返回 4 张（1 组）；推荐使用简短具体的英文视觉短语。`}
                </p>
            ) : null}
            {dmArk ? (
                <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                    {hasImageReferences
                        ? "已连接参考图，自动转为图生图/融合模式，提示词中可用「图1」「图2」指代并写明不变约束。"
                        : "由 DreamMaker Seedream 生成，原生擅长连贯中文长句描述；避免逗号堆砌标签词。"}
                </p>
            ) : null}
            {dmGpt ? (
                <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                    {hasImageReferences
                        ? "支持多图参考融合与蒙版局部重绘，请在提示词中写清变化动作并显式锁定不变要素。"
                        : "由 DreamMaker GPT Image 生成，擅长精确文字排版、透明背景与结构化写实分镜。"}
                </p>
            ) : null}
            {!qwen && !dmMj && !dmArk ? (
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>质量</SettingTitle>
                    <div className="grid grid-cols-3 gap-2.5 @min-[22rem]:grid-cols-6">
                        {qualityList.map((item) => (
                            <OptionPill key={item.value} selected={quality === item.value} theme={theme} onClick={() => onConfigChange("quality", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                </div>
            ) : null}
            {dmMj && !dmSpec.niji ? (
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>细节与分辨率</SettingTitle>
                    <div className="grid grid-cols-2 gap-2.5">
                        <OptionPill selected={!boolConfig(config.dmMjHd, false)} theme={theme} onClick={() => onConfigChange("dmMjHd", "false")}>
                            标准 1K
                        </OptionPill>
                        <OptionPill selected={boolConfig(config.dmMjHd, false)} theme={theme} onClick={() => onConfigChange("dmMjHd", "true")}>
                            高清 2K (--hd)
                        </OptionPill>
                        <OptionPill selected={(config.dmMjQuality || "4") === "4"} theme={theme} onClick={() => onConfigChange("dmMjQuality", "4")}>
                            精细细节 (--q 4)
                        </OptionPill>
                        <OptionPill selected={config.dmMjQuality === "1"} theme={theme} onClick={() => onConfigChange("dmMjQuality", "1")}>
                            标准细节 (--q 1)
                        </OptionPill>
                    </div>
                    <div className="flex items-center gap-3 pt-1">
                        <div className="shrink-0"><SettingTitle color={theme.node.muted}>原始写实模式 (--raw)</SettingTitle></div>
                        <span className="min-w-0 flex-1 text-xs" style={{ color: theme.node.muted, opacity: 0.75 }}>
                            关闭默认艺术滤镜，适合摄影与精准细节
                        </span>
                        <span className="shrink-0" onMouseDown={(event) => event.stopPropagation()}>
                            <ParameterSwitch label="原始写实模式" checked={boolConfig(config.dmMjRaw, false)} onChange={(checked) => onConfigChange("dmMjRaw", String(checked))} />
                        </span>
                    </div>
                </div>
            ) : null}
            {dmMj && dmSpec.niji ? (
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>调度速度</SettingTitle>
                    <div className="grid grid-cols-2 gap-2.5">
                        <OptionPill selected={config.dmMjMode !== "turbo"} theme={theme} onClick={() => onConfigChange("dmMjMode", "fast")}>
                            标准 (Fast)
                        </OptionPill>
                        <OptionPill selected={config.dmMjMode === "turbo"} theme={theme} onClick={() => onConfigChange("dmMjMode", "turbo")}>
                            极速 (Turbo)
                        </OptionPill>
                    </div>
                </div>
            ) : null}
            {fixedRatio || dmMj || dmArk ? null : (
                <div className="space-y-2.5">
                    <div className="flex items-center justify-between gap-3">
                        <SettingTitle color={theme.node.muted}>{qwen ? "输出尺寸" : "尺寸"}</SettingTitle>
                        {!qwen ? (
                            <div className="flex items-center gap-2">
                                <span className="text-xs font-medium" style={{ color: theme.node.muted }}>
                                    16 倍数对齐
                                </span>
                                <span title="输入完成后自动向上补成 16 的倍数" onMouseDown={(event) => event.stopPropagation()}>
                                    <ParameterSwitch label="16 倍数对齐" checked={snapDimensionToStep} onChange={setSnapDimensionToStep} />
                                </span>
                            </div>
                        ) : null}
                    </div>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                        <DimensionInput prefix="W" value={qwen ? qwenDimensions.width : dimensions.width} disabled={qwen ? followOriginal : selectedRatio === "auto"} theme={theme} alignToStep={qwen ? true : snapDimensionToStep} step={dimensionStep} onChange={(value) => updateDimension("width", value)} />
                        <ArrowLeftRight className="size-4 opacity-45" aria-hidden="true" />
                        <DimensionInput prefix="H" value={qwen ? qwenDimensions.height : dimensions.height} disabled={qwen ? followOriginal : selectedRatio === "auto"} theme={theme} alignToStep={qwen ? true : snapDimensionToStep} step={dimensionStep} onChange={(value) => updateDimension("height", value)} />
                    </div>
                </div>
            )}
            {!dmMj ? (
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>分辨率</SettingTitle>
                    {qwen ? (
                        <div className="grid grid-cols-3 gap-2.5">
                            {(hasImageReferences ? qwenResolutionOptions : qwenResolutionOptions.filter((item) => item.value !== "0")).map((item) => (
                                <OptionPill key={item.value} selected={editResolution === item.value} theme={theme} onClick={() => onConfigChange("imageResolution", item.value)}>
                                    {item.label}
                                </OptionPill>
                            ))}
                        </div>
                    ) : dmArk ? (
                        <div className="grid grid-cols-3 gap-2.5">
                            {arkTiers.map((tier) => (
                                <OptionPill
                                    key={tier}
                                    selected={!arkCustomPixels && arkTier === tier}
                                    theme={theme}
                                    onClick={() => {
                                        onConfigChange("dmArkSizeTier", tier);
                                        if (arkCustomPixels) onConfigChange("size", selectedRatio === "auto" ? "auto" : selectedRatio);
                                    }}
                                >
                                    {tier}
                                </OptionPill>
                            ))}
                        </div>
                    ) : (
                        <div className="grid grid-cols-4 gap-2.5">
                            {scaleList.map((item) => (
                                <OptionPill key={item.value} selected={selectedScale === item.value} theme={theme} onClick={() => selectScale(item.value)}>
                                    {item.label}
                                </OptionPill>
                            ))}
                        </div>
                    )}
                </div>
            ) : null}
            {fixedRatio || followOriginal ? null : (
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>宽高比</SettingTitle>
                    <div className="grid grid-cols-4 gap-2.5 @min-[22rem]:grid-cols-5">
                        {ratioList.map((item) => (
                            <button
                                key={item.value}
                                type="button"
                                className="flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border bg-transparent text-sm transition hover:opacity-80"
                                style={{ borderColor: selectedRatio === item.value ? theme.node.text : theme.node.stroke, background: "transparent", color: theme.node.text }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => selectRatio(item.value)}
                            >
                                <AspectIcon width={item.width} height={item.height} color={theme.node.text} />
                                <span>{item.value === "auto" ? "自动" : item.value}</span>
                            </button>
                        ))}
                    </div>
                </div>
            )}
            {!qwen && !dmMj && !dmArk ? (
                <div className="flex items-center gap-3">
                    <div className="shrink-0"><SettingTitle color={theme.node.muted}>透明背景</SettingTitle></div>
                    <span className="min-w-0 flex-1 text-xs @min-[22rem]:truncate" style={{ color: theme.node.muted, opacity: 0.75 }}>
                        开启后生成无背景的透明图像（仅部分模型可用）
                    </span>
                    <span className="shrink-0" onMouseDown={(event) => event.stopPropagation()}>
                        <ParameterSwitch label="透明背景" checked={transparentBackground} onChange={(checked) => onConfigChange("background", checked ? "transparent" : "")} />
                    </span>
                </div>
            ) : null}
            {dmArk ? (
                <div className="space-y-3">
                    <div className="space-y-2">
                        <SettingTitle color={theme.node.muted}>精确像素尺寸（可选，覆盖档位）</SettingTitle>
                        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                            <DimensionInput
                                prefix="W"
                                value={arkCustomPixels?.width || 0}
                                disabled={false}
                                theme={theme}
                                alignToStep={false}
                                step={16}
                                onChange={(value) => {
                                    const w = Math.max(256, Math.floor(value || 2048));
                                    const h = arkCustomPixels?.height || 2048;
                                    onConfigChange("size", `${w}x${h}`);
                                }}
                            />
                            <ArrowLeftRight className="size-4 opacity-45" aria-hidden="true" />
                            <DimensionInput
                                prefix="H"
                                value={arkCustomPixels?.height || 0}
                                disabled={false}
                                theme={theme}
                                alignToStep={false}
                                step={16}
                                onChange={(value) => {
                                    const w = arkCustomPixels?.width || 2048;
                                    const h = Math.max(256, Math.floor(value || 2048));
                                    onConfigChange("size", `${w}x${h}`);
                                }}
                            />
                        </div>
                    </div>
                    {dmSpec.supportsLayerDecomp ? (
                        <div className="flex items-center gap-3">
                            <div className="shrink-0"><SettingTitle color={theme.node.muted}>图层拆分</SettingTitle></div>
                            <span className="min-w-0 flex-1 text-xs" style={{ color: theme.node.muted, opacity: 0.75 }}>
                                {hasImageReferences ? "将单张参考图拆解为底图和多个独立图层" : "需连接 1 张参考图后生效"}
                            </span>
                            <span className="shrink-0" onMouseDown={(event) => event.stopPropagation()}>
                                <ParameterSwitch label="图层拆分" checked={boolConfig(config.dmArkLayerDecomposition, false)} onChange={(checked) => onConfigChange("dmArkLayerDecomposition", String(checked))} />
                            </span>
                        </div>
                    ) : null}
                    {dmSpec.supportsWebSearch ? (
                        <div className="flex items-center gap-3">
                            <div className="shrink-0"><SettingTitle color={theme.node.muted}>联网搜索增强</SettingTitle></div>
                            <span className="min-w-0 flex-1 text-xs" style={{ color: theme.node.muted, opacity: 0.75 }}>
                                生图前自动检索最新人物或产品外观信息
                            </span>
                            <span className="shrink-0" onMouseDown={(event) => event.stopPropagation()}>
                                <ParameterSwitch label="联网搜索增强" checked={boolConfig(config.dmArkWebSearch, false)} onChange={(checked) => onConfigChange("dmArkWebSearch", String(checked))} />
                            </span>
                        </div>
                    ) : null}
                    {dmSpec.supportsOptimizePrompt ? (
                        <div className="space-y-2">
                            <SettingTitle color={theme.node.muted}>平台提示词改写</SettingTitle>
                            <div className="grid grid-cols-3 gap-2.5">
                                {[{ value: "", label: "关闭" }, { value: "fast", label: "快速" }, { value: "standard", label: "标准" }].map((item) => (
                                    <OptionPill key={item.label} selected={(config.dmArkOptimizePrompt || "") === item.value} theme={theme} onClick={() => onConfigChange("dmArkOptimizePrompt", item.value)}>
                                        {item.label}
                                    </OptionPill>
                                ))}
                            </div>
                        </div>
                    ) : null}
                    <details className="group">
                        <summary className="flex cursor-pointer list-none items-center justify-between py-1 text-sm [&::-webkit-details-marker]:hidden">
                            高级设置
                            <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
                        </summary>
                        <div className="space-y-3 pt-2">
                            <SettingTitle color={theme.node.muted}>随机种子</SettingTitle>
                            <PanelTextInput value={config.imageSeed || ""} theme={theme} placeholder="留空随机 (-1)" onChange={(value) => onConfigChange("imageSeed", value)} />
                        </div>
                    </details>
                </div>
            ) : null}
            {dmGpt ? (
                <details className="group">
                    <summary className="flex cursor-pointer list-none items-center justify-between py-1 text-sm [&::-webkit-details-marker]:hidden">
                        高级设置
                        <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
                    </summary>
                    <div className="space-y-3 pt-2">
                        <div className="space-y-2">
                            <SettingTitle color={theme.node.muted}>输出格式</SettingTitle>
                            <div className="grid grid-cols-3 gap-2.5">
                                {["png", "jpeg", "webp"].map((fmt) => (
                                    <OptionPill key={fmt} selected={(transparentBackground ? "png" : config.dmGptFormat || "png") === fmt} theme={theme} onClick={() => onConfigChange("dmGptFormat", transparentBackground ? "png" : fmt)}>
                                        {fmt.toUpperCase()}
                                    </OptionPill>
                                ))}
                            </div>
                        </div>
                        <div className="space-y-2">
                            <SettingTitle color={theme.node.muted}>审核宽松度</SettingTitle>
                            <div className="grid grid-cols-2 gap-2.5">
                                <OptionPill selected={config.dmGptModeration !== "low"} theme={theme} onClick={() => onConfigChange("dmGptModeration", "auto")}>
                                    标准 (auto)
                                </OptionPill>
                                <OptionPill selected={config.dmGptModeration === "low"} theme={theme} onClick={() => onConfigChange("dmGptModeration", "low")}>
                                    宽松 (low)
                                </OptionPill>
                            </div>
                        </div>
                    </div>
                </details>
            ) : null}
            {dmMj ? (
                <details className="group">
                    <summary className="flex cursor-pointer list-none items-center justify-between py-1 text-sm [&::-webkit-details-marker]:hidden">
                        高级设置
                        <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
                    </summary>
                    <div className="space-y-3 pt-2">
                        <div className="grid grid-cols-2 gap-2.5">
                            <div className="space-y-1.5">
                                <SettingTitle color={theme.node.muted}>风格化 (--stylize)</SettingTitle>
                                <PanelTextInput value={config.dmMjStylize || "100"} theme={theme} placeholder="0-1000" onChange={(value) => onConfigChange("dmMjStylize", value)} />
                            </div>
                            <div className="space-y-1.5">
                                <SettingTitle color={theme.node.muted}>多样化 (--chaos)</SettingTitle>
                                <PanelTextInput value={config.dmMjChaos || "0"} theme={theme} placeholder="0-100" onChange={(value) => onConfigChange("dmMjChaos", value)} />
                            </div>
                            <div className="space-y-1.5">
                                <SettingTitle color={theme.node.muted}>怪异度 (--weird)</SettingTitle>
                                <PanelTextInput value={config.dmMjWeird || "0"} theme={theme} placeholder="0-3000" onChange={(value) => onConfigChange("dmMjWeird", value)} />
                            </div>
                            {!dmSpec.niji ? (
                                <div className="space-y-1.5">
                                    <SettingTitle color={theme.node.muted}>实验美学 (--exp)</SettingTitle>
                                    <PanelTextInput value={config.dmMjExp || "0"} theme={theme} placeholder="0-100" onChange={(value) => onConfigChange("dmMjExp", value)} />
                                </div>
                            ) : null}
                        </div>
                        {!dmSpec.niji ? (
                            <div className="flex items-center justify-between gap-3">
                                <SettingTitle color={theme.node.muted}>无缝平铺 (--tile)</SettingTitle>
                                <span onMouseDown={(event) => event.stopPropagation()}>
                                    <ParameterSwitch label="无缝平铺" checked={boolConfig(config.dmMjTile, false)} onChange={(checked) => onConfigChange("dmMjTile", String(checked))} />
                                </span>
                            </div>
                        ) : null}
                        {hasImageReferences ? (
                            <div className="space-y-1.5">
                                <SettingTitle color={theme.node.muted}>{`参考图权重 (--iw 0-${dmSpec.niji ? 2 : 3})`}</SettingTitle>
                                <PanelTextInput value={config.dmMjIw || "1"} theme={theme} placeholder="1" onChange={(value) => onConfigChange("dmMjIw", value)} />
                            </div>
                        ) : null}
                        <div className="space-y-1.5">
                            <SettingTitle color={theme.node.muted}>负面排除 (--no)</SettingTitle>
                            <PanelTextInput value={config.imageNegative || ""} theme={theme} placeholder="例如：text, watermark" onChange={(value) => onConfigChange("imageNegative", value)} />
                        </div>
                        <div className="space-y-1.5">
                            <SettingTitle color={theme.node.muted}>随机种子</SettingTitle>
                            <PanelTextInput value={config.imageSeed || ""} theme={theme} placeholder="留空随机" onChange={(value) => onConfigChange("imageSeed", value)} />
                        </div>
                    </div>
                </details>
            ) : null}
            {qwen ? (
                <details className="group">
                    <summary className="flex cursor-pointer list-none items-center justify-between py-1 text-sm [&::-webkit-details-marker]:hidden">
                        高级设置
                        <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
                    </summary>
                    <div className="space-y-3 pt-2">
                        <div className="grid grid-cols-2 gap-2.5">
                            <div className="space-y-1.5">
                                <SettingTitle color={theme.node.muted}>{`采样步数 (1-${QWEN_IMAGE_21_MAX_STEPS})`}</SettingTitle>
                                <PanelTextInput value={config.imageSteps || String(QWEN_IMAGE_21_DEFAULT_STEPS)} theme={theme} placeholder={String(QWEN_IMAGE_21_DEFAULT_STEPS)} onChange={(value) => onConfigChange("imageSteps", value)} />
                            </div>
                            <div className="space-y-1.5">
                                <SettingTitle color={theme.node.muted}>CFG (1-10)</SettingTitle>
                                <PanelTextInput value={config.imageCfg || "1"} theme={theme} placeholder="1" onChange={(value) => onConfigChange("imageCfg", value)} />
                            </div>
                        </div>
                        <div className="space-y-1.5">
                            <SettingTitle color={theme.node.muted}>负面提示词</SettingTitle>
                            <PanelTextInput value={config.imageNegative || ""} theme={theme} placeholder="不希望出现的元素" onChange={(value) => onConfigChange("imageNegative", value)} />
                        </div>
                        <div className="space-y-1.5">
                            <SettingTitle color={theme.node.muted}>随机种子</SettingTitle>
                            <PanelTextInput value={config.imageSeed || ""} theme={theme} placeholder="留空随机" onChange={(value) => onConfigChange("imageSeed", value)} />
                        </div>
                    </div>
                </details>
            ) : null}
            {fixedRatio ? null : (
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>生成张数</SettingTitle>
                    {dmMj ? (
                        <div className="grid grid-cols-3 gap-2.5">
                            {[4, 8, 12].map((value) => (
                                <OptionPill key={value} selected={mjDisplayCount === value} theme={theme} onClick={() => onConfigChange("count", String(value))}>
                                    {value} 张 ({value / 4}组)
                                </OptionPill>
                            ))}
                        </div>
                    ) : (
                        <div className="grid grid-cols-4 gap-2.5 @min-[22rem]:grid-cols-6">
                            {countList.map((item) => (
                                <OptionPill key={item.value} selected={count === Number(item.value)} theme={theme} onClick={() => onConfigChange("count", item.value)}>
                                    {item.label}
                                </OptionPill>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function ParameterSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
    return <Switch size="sm" className="image-parameter-switch" aria-label={label} checked={checked} onCheckedChange={onChange}
        onKeyDown={(event) => {
            if (event.key === "ArrowLeft" && checked) onChange(false);
            if (event.key === "ArrowRight" && !checked) onChange(true);
        }} />;
}

export function imageQualityLabel(value: string) {
    return imageQualityOptions.some((item) => item.value === value) ? generationLevelLabels[value] : value;
}

export function imageSizeLabel(size: string) {
    const scale = inferMediaScale(size);
    const ratio = inferMediaRatio(size);
    if (ratio === "auto" || size === "auto") return "自动";
    if (scale === "auto") return ratio;
    return `${scale} · ${ratio}`;
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            className="h-9 cursor-pointer whitespace-nowrap rounded-full border px-2 text-sm transition hover:opacity-80"
            style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function DimensionInput({ prefix, value, disabled, theme, alignToStep, step = DIMENSION_STEP, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; alignToStep: boolean; step?: number; onChange: (value: number | null) => void }) {
    const commit = (input: HTMLInputElement) => {
        const next = alignDimension(Math.max(1, Math.floor(Number(input.value) || value || 1024)), alignToStep, step);
        input.value = String(next);
        onChange(next);
    };

    return (
        <label className="flex h-9 overflow-hidden rounded-xl text-sm" style={{ background: theme.node.fill, color: theme.node.text, opacity: disabled ? 0.55 : 1 }}>
            <span className="grid w-9 place-items-center" style={{ color: theme.node.muted }}>
                {prefix}
            </span>
            <input
                type="number"
                min={1}
                disabled={disabled}
                className="min-w-0 flex-1 bg-transparent px-2 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                defaultValue={value || ""}
                key={`${prefix}-${value}`}
                onBlur={(event) => commit(event.currentTarget)}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
    );
}

function PanelTextInput({ value, theme, placeholder, onChange }: { value: string; theme: CanvasTheme; placeholder?: string; onChange: (value: string) => void }) {
    return (
        <input
            type="text"
            value={value}
            placeholder={placeholder}
            className="h-9 w-full rounded-xl border bg-transparent px-3 text-sm outline-none"
            style={{ borderColor: theme.node.stroke, color: theme.node.text }}
            onChange={(event) => onChange(event.target.value)}
            onMouseDown={(event) => event.stopPropagation()}
        />
    );
}

function AspectIcon({ width, height, color }: { width: number; height: number; color: string }) {
    if (!width || !height) return null;
    const ratio = width / height;
    const boxWidth = ratio >= 1 ? 24 : Math.max(10, 24 * ratio);
    const boxHeight = ratio >= 1 ? Math.max(10, 24 / ratio) : 24;
    return (
        <span className="grid h-7 w-9 place-items-center">
            <span className="border-2" style={{ width: boxWidth, height: boxHeight, borderColor: color }} />
        </span>
    );
}

function SettingTitle({ children, color }: { children: string; color: string }) {
    return (
        <div className="text-xs font-medium" style={{ color }}>
            {children}
        </div>
    );
}

function alignDimension(value: number, enabled: boolean, step = DIMENSION_STEP) {
    return enabled ? Math.ceil(value / step) * step : value;
}
