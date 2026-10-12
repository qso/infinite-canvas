import { type ReactNode, useEffect, useState } from "react";
import { ConfigProvider, Input, InputNumber, Switch } from "antd";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

import i18n from "@/i18n";
import { isQwenImage21, QWEN_IMAGE_21_DEFAULT_STEPS, QWEN_IMAGE_21_MAX_STEPS } from "@/constant/comfyui";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { readImageMeta } from "@/lib/image-utils";
import { computeMediaSize, inferMediaRatio, inferMediaScale, mediaRatioOptions, mediaScaleOptions, parseAspectRatio, parsePixelSize, readMediaDimensions } from "@/lib/media-size";
import type { AiConfig } from "@/stores/use-config-store";

const qualityOptions = [
    { value: "auto", labelKey: "auto" },
    { value: "low", labelKey: "low" },
    { value: "medium", labelKey: "medium" },
    { value: "high", labelKey: "high" },
    { value: "xhigh", labelKey: "xhigh" },
    { value: "max", labelKey: "max" },
];
const qwenResolutionOptions = [
    { value: "1024", label: "1K" },
    { value: "1536", label: "1.5K" },
    { value: "2048", label: "2K" },
    { value: "4096", label: "4K" },
    { value: "0", label: "跟随原图" },
];

export const imageQualityOptions = qualityOptions.map((item) => ({ value: item.value, get label() { return i18n.t(`settingsPanels.common.${item.labelKey}`); } }));
export const imageAspectOptions = mediaRatioOptions.map((item) => ({ value: item.value, label: item.value === "auto" ? i18n.t("settingsPanels.common.auto") : item.value }));
export const imageScaleOptions = mediaScaleOptions.map((value) => ({ value, label: value === "auto" ? i18n.t("settingsPanels.common.auto") : value }));

type ImageConfigKey = "quality" | "size" | "count" | "background" | "imageSteps" | "imageCfg" | "imageSeed" | "imageNegative" | "imageResolution";
export type ImageReferenceInfo = { count: number; firstUrl?: string };
type ImageSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: ImageConfigKey, value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
    maxCount?: number;
    quickCount?: number;
    /** 已连接的参考图（按生成时的顺序）；有参考图即为图像编辑模式，输出跟随第一张。 */
    imageReferences?: ImageReferenceInfo;
};

export function ImageSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5", maxCount = 15, quickCount = 10, imageReferences }: ImageSettingsPanelProps) {
    const { t } = useTranslation();
    const qwen = isQwenImage21(config.model || config.imageModel);
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
    const count = Math.max(1, Math.min(maxCount, Math.floor(Math.abs(Number(config.count)) || 1)));
    const activeSize = config.size || "auto";
    const transparentBackground = config.background === "transparent";
    const selectedScale = inferMediaScale(activeSize);
    const selectedRatio = inferMediaRatio(activeSize);
    const dimensions = readMediaDimensions(activeSize, selectedScale, selectedRatio);
    const editResolution = config.imageResolution || "1024";
    // 图像编辑的预估输出：跟随第 1 张参考图的比例（与云端 TextEncode 的缩放数学一致，32 对齐；4K 档为超分后的长边）。
    const editOutputSize = (() => {
        if (!qwen || !hasImageReferences || !firstReferenceSize) return null;
        const ratio = firstReferenceSize.width / firstReferenceSize.height;
        if (followOriginal) return { width: Math.max(32, Math.round(firstReferenceSize.width / 32) * 32), height: Math.max(32, Math.round(firstReferenceSize.height / 32) * 32) };
        if (Number(editResolution) >= 4096) {
            const shortSide = Math.max(32, Math.round((4096 * Math.min(ratio, 1 / ratio)) / 32) * 32);
            return ratio >= 1 ? { width: 4096, height: shortSide } : { width: shortSide, height: 4096 };
        }
        const budget = Math.min(2048, Math.max(256, Math.round(Number(editResolution) || 1024)));
        return { width: Math.max(32, Math.round(Math.sqrt(budget * budget * ratio) / 32) * 32), height: Math.max(32, Math.round(Math.sqrt(budget * budget / ratio) / 32) * 32) };
    })();
    const applySize = (scale: string, ratio: string) => onConfigChange("size", computeMediaSize(scale, ratio));
    const selectScale = (scale: string) => applySize(scale, selectedRatio === "auto" ? "1:1" : selectedRatio);
    const selectRatio = (ratio: string) => (qwen ? onConfigChange("size", ratio) : applySize(selectedScale, ratio));
    const activeDimensions = qwen
        ? (() => {
              const pixels = parsePixelSize(activeSize);
              if (pixels) return { width: alignDimension(pixels.width, true, 32), height: alignDimension(pixels.height, true, 32) };
              const ratio = parseAspectRatio(selectedRatio === "auto" ? "1:1" : selectedRatio) || { width: 1, height: 1 };
              const budget = editResolution === "0" ? 1024 : Math.round(Number(editResolution) || 1024);
              if (budget >= 4096) {
                  const shortSide = alignDimension((4096 * Math.min(ratio.width, ratio.height)) / Math.max(ratio.width, ratio.height), true, 32);
                  return ratio.width >= ratio.height ? { width: 4096, height: shortSide } : { width: shortSide, height: 4096 };
              }
              const aspect = ratio.width / ratio.height;
              return { width: alignDimension(Math.sqrt(budget * budget * aspect), true, 32), height: alignDimension(Math.sqrt(budget * budget / aspect), true, 32) };
          })()
        : dimensions;
    // Qwen 统一分辨率档：1K/1.5K/2K 是面积预算，4K 是长边 4096 的超分档，「跟随原图」只在图像编辑时生效。
    const selectQwenResolution = (value: string) => {
        if (parsePixelSize(activeSize)) onConfigChange("size", selectedRatio === "auto" ? "1:1" : selectedRatio);
        onConfigChange("imageResolution", value);
    };
    const updateDimension = (key: "width" | "height", value: number | null) => {
        const next = Math.max(1, Math.floor(value || activeDimensions[key] || 1024));
        const width = key === "width" ? next : activeDimensions.width;
        const height = key === "height" ? next : activeDimensions.height;
        onConfigChange("size", `${alignDimension(width, snapDimensionToStep, dimensionStep)}x${alignDimension(height, snapDimensionToStep, dimensionStep)}`);
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div
                className={className}
                style={{ color: theme.node.text }}
                onMouseDown={(event) => {
                    event.stopPropagation();
                    if (event.target instanceof HTMLInputElement) return;
                    if (document.activeElement instanceof HTMLInputElement && event.currentTarget.contains(document.activeElement)) document.activeElement.blur();
                }}
            >
                {showTitle ? <div className="text-lg font-semibold">{t("settingsPanels.image.title")}</div> : null}
                {qwen ? (
                    <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                        由云端 ComfyUI 生成（BF16）。无参考图时为文生图；连接参考图后自动变为图像编辑，第一张是编辑目标，提示词里可用 &lt;image1&gt;、&lt;image2&gt; 引用。
                    </p>
                ) : null}
                {!qwen ? (
                    <div className="space-y-2.5">
                        <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.quality")}</SettingTitle>
                        <div className="grid grid-cols-3 gap-2.5">
                            {qualityOptions.map((item) => (
                                <OptionPill key={item.value} selected={quality === item.value} theme={theme} onClick={() => onConfigChange("quality", item.value)}>
                                    {t(`settingsPanels.common.${item.labelKey}`)}
                                </OptionPill>
                            ))}
                        </div>
                    </div>
                ) : null}
                {!qwen ? (
                    <div className="space-y-2.5">
                        <div className="flex items-center justify-between gap-3">
                            <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.size")}</SettingTitle>
                            <div className="flex items-center gap-2">
                                <span className="text-xs font-medium" style={{ color: theme.node.muted }}>
                                    {t("settingsPanels.image.align16")}
                                </span>
                                <span title={t("settingsPanels.image.align16Hint")} onMouseDown={(event) => event.stopPropagation()}>
                                    <Switch size="small" checked={snapDimensionToStep} onChange={setSnapDimensionToStep} />
                                </span>
                            </div>
                        </div>
                        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                            <DimensionInput prefix="W" value={dimensions.width} disabled={selectedRatio === "auto"} theme={theme} alignToStep={snapDimensionToStep} step={dimensionStep} onChange={(value) => updateDimension("width", value)} />
                            <span className="text-lg opacity-45">↔</span>
                            <DimensionInput prefix="H" value={dimensions.height} disabled={selectedRatio === "auto"} theme={theme} alignToStep={snapDimensionToStep} step={dimensionStep} onChange={(value) => updateDimension("height", value)} />
                        </div>
                    </div>
                ) : null}
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.resolution")}</SettingTitle>
                    {qwen ? (
                        <>
                            <div className="grid grid-cols-3 gap-2.5">
                                {(hasImageReferences ? qwenResolutionOptions : qwenResolutionOptions.filter((item) => item.value !== "0")).map((item) => (
                                    <OptionPill key={item.value} selected={editResolution === item.value} theme={theme} onClick={() => selectQwenResolution(item.value)}>
                                        {item.label}
                                    </OptionPill>
                                ))}
                                <ResolutionInput value={qwenResolutionOptions.some((item) => item.value === editResolution) ? "" : editResolution} theme={theme} onChange={(value) => selectQwenResolution(value.trim() || "1024")} />
                            </div>
                            <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                                {hasImageReferences
                                    ? "1K/1.5K/2K 是像素预算，输出跟随第 1 张参考图的比例；「跟随原图」保持第 1 张参考图的原始尺寸；「4K」先原生 2K 采样再经 SeedVR2 超分到长边 4096，耗时更高。"
                                    : "1K/1.5K/2K 是像素预算（1K≈1024²、2K≈2048²），配合宽高比得到下方「输出尺寸」；「4K」先原生 2K 采样再经 SeedVR2 超分到长边 4096，耗时更高。连接参考图后可切换为跟随原图。"}
                            </p>
                        </>
                    ) : (
                        <div className="grid grid-cols-4 gap-2.5">
                            {mediaScaleOptions.map((value) => (
                                <OptionPill key={value} selected={selectedScale === value} theme={theme} onClick={() => selectScale(value)}>
                                    {value === "auto" ? t("settingsPanels.common.auto") : value}
                                </OptionPill>
                            ))}
                        </div>
                    )}
                </div>
                {qwen && hasImageReferences ? (
                    <div className="space-y-2.5">
                        <SettingTitle color={theme.node.muted}>输出尺寸</SettingTitle>
                        <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>
                            {(() => {
                                const sizeText = editOutputSize ? (followOriginal ? `：约 ${editOutputSize.width}×${editOutputSize.height}（32 对齐）` : `，输出约 ${editOutputSize.width}×${editOutputSize.height}`) : imageReferences?.firstUrl ? "（正在读取参考图尺寸…）" : "";
                                return followOriginal ? `保持第 1 张参考图的原始尺寸${sizeText}。` : `按分辨率预算缩放第 1 张参考图${sizeText}。`;
                            })()}
                            {(imageReferences?.count || 0) > 1 ? `其余 ${(imageReferences?.count || 0) - 1} 张参考图只作为内容参考，不影响输出尺寸；提示词里可用 <image1>、<image2> 引用。` : "提示词里可用 <image1> 引用。"}
                        </p>
                    </div>
                ) : (
                    <div className="space-y-2.5">
                        <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.aspectRatio")}</SettingTitle>
                        <div className="grid grid-cols-4 gap-2.5">
                            {mediaRatioOptions.map((item) => (
                                <button
                                    key={item.value}
                                    type="button"
                                    className="flex h-[72px] cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border bg-transparent text-sm transition hover:opacity-80"
                                    style={{ borderColor: selectedRatio === item.value ? theme.node.text : theme.node.stroke, background: "transparent", color: theme.node.text }}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onClick={() => selectRatio(item.value)}
                                >
                                    <AspectIcon width={item.width} height={item.height} color={theme.node.text} />
                                    <span>{item.value === "auto" ? t("settingsPanels.common.auto") : item.value}</span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}
                {qwen && !hasImageReferences ? (
                    <div className="space-y-2.5">
                        <div className="flex items-center justify-between gap-3">
                            <SettingTitle color={theme.node.muted}>输出尺寸</SettingTitle>
                            <div className="flex items-center gap-2">
                                <span className="text-xs font-medium" style={{ color: theme.node.muted }}>
                                    32 倍数对齐
                                </span>
                                <span title="输入完成后自动向上补成 32 的倍数（模型要求）" onMouseDown={(event) => event.stopPropagation()}>
                                    <Switch size="small" checked={snapDimensionToStep} onChange={setSnapDimensionToStep} />
                                </span>
                            </div>
                        </div>
                        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5">
                            <DimensionInput prefix="W" value={activeDimensions.width} disabled={selectedRatio === "auto"} theme={theme} alignToStep={snapDimensionToStep} step={32} onChange={(value) => updateDimension("width", value)} />
                            <span className="text-lg opacity-45">↔</span>
                            <DimensionInput prefix="H" value={activeDimensions.height} disabled={selectedRatio === "auto"} theme={theme} alignToStep={snapDimensionToStep} step={32} onChange={(value) => updateDimension("height", value)} />
                        </div>
                        <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>文生图的最终输出尺寸（随上方分辨率和比例自动计算，可直接改）；连接参考图后输出跟随第 1 张参考图，此处自动锁定。</p>
                    </div>
                ) : null}
                {!qwen ? (
                    <div className="flex items-center justify-between gap-3">
                        <div className="space-y-0.5">
                            <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.transparent")}</SettingTitle>
                            <div className="text-xs" style={{ color: theme.node.muted, opacity: 0.75 }}>
                                {t("settingsPanels.image.transparentHint")}
                            </div>
                        </div>
                        <span onMouseDown={(event) => event.stopPropagation()}>
                            <Switch size="small" checked={transparentBackground} onChange={(checked) => onConfigChange("background", checked ? "transparent" : "")} />
                        </span>
                    </div>
                ) : null}
                {qwen ? (
                    <details className="group">
                        <summary className="!flex cursor-pointer list-none items-center justify-between py-1 text-sm [&::-webkit-details-marker]:hidden">
                            高级设置
                            <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
                        </summary>
                        <div className="space-y-4 pt-3">
                            <SettingGroup title="采样步数" color={theme.node.muted}>
                                <InputNumber className="!w-full !rounded-xl" aria-label="采样步数" min={1} max={QWEN_IMAGE_21_MAX_STEPS} precision={0} placeholder={String(QWEN_IMAGE_21_DEFAULT_STEPS)} value={config.imageSteps ? Number(config.imageSteps) : null} onChange={(value) => onConfigChange("imageSteps", value === null ? "" : String(value))} />
                                <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>默认 {QWEN_IMAGE_21_DEFAULT_STEPS} 步；官方管线推荐 40-50 步，步数越多耗时越长。</p>
                            </SettingGroup>
                            <SettingGroup title="CFG" color={theme.node.muted}>
                                <InputNumber className="!w-full !rounded-xl" aria-label="CFG" min={1} max={10} step={0.5} value={Number(config.imageCfg) || 1} onChange={(value) => onConfigChange("imageCfg", value === null ? "1" : String(value))} />
                                <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>官方链路保持 1；大于 1 时才会使用下方的负面提示词。</p>
                            </SettingGroup>
                            <SettingGroup title="负面提示词" color={theme.node.muted}>
                                <Input.TextArea
                                    className="!rounded-xl"
                                    aria-label="负面提示词"
                                    rows={2}
                                    placeholder="仅 CFG 大于 1 时生效"
                                    value={config.imageNegative || ""}
                                    onChange={(event) => onConfigChange("imageNegative", event.target.value)}
                                    onMouseDown={(event) => event.stopPropagation()}
                                />
                            </SettingGroup>
                            <SettingGroup title="随机种子" color={theme.node.muted}>
                                <InputNumber className="!w-full !rounded-xl" aria-label="随机种子" min={0} max={Number.MAX_SAFE_INTEGER} precision={0} controls={false} placeholder="留空，每次随机" value={config.imageSeed ? Number(config.imageSeed) : null} onChange={(value) => onConfigChange("imageSeed", value === null ? "" : String(value))} />
                                <p className="text-xs leading-relaxed" style={{ color: theme.node.muted }}>固定种子便于在相同参数下对比结果。</p>
                            </SettingGroup>
                        </div>
                    </details>
                ) : null}
                <div className="space-y-2.5">
                    <SettingTitle color={theme.node.muted}>{t("settingsPanels.image.count")}</SettingTitle>
                    <div className="grid grid-cols-4 gap-2.5">
                        {Array.from({ length: quickCount }, (_, index) => index + 1).map((value) => (
                            <OptionPill key={value} selected={count === value} theme={theme} onClick={() => onConfigChange("count", String(value))}>
                                {t("settingsPanels.image.images", { count: value })}
                            </OptionPill>
                        ))}
                        <CountInput value={count} max={maxCount} theme={theme} onChange={(value) => onConfigChange("count", String(value || 1))} />
                    </div>
                </div>
            </div>
        </ImageSettingsTheme>
    );
}

export function ImageSettingsTheme({ theme, children }: { theme: CanvasTheme; children: ReactNode }) {
    return (
        <ConfigProvider
            theme={{
                token: { colorBgContainer: theme.toolbar.panel, colorBgElevated: theme.toolbar.panel, colorBorder: theme.node.stroke, colorPrimary: theme.node.activeStroke, colorText: theme.node.text, colorTextLightSolid: theme.node.panel },
                components: {
                    Button: { defaultBg: theme.toolbar.panel, defaultBorderColor: theme.node.stroke, defaultColor: theme.node.text },
                    Slider: { railBg: theme.node.stroke, railHoverBg: theme.node.stroke, trackBg: theme.node.activeStroke, handleColor: theme.node.text, handleActiveColor: theme.node.text },
                },
            }}
        >
            {children}
        </ConfigProvider>
    );
}

export function imageQualityLabel(value: string) {
    return qualityOptions.some((item) => item.value === value) ? i18n.t(`settingsPanels.common.${value}`) : value;
}

export function imageSizeLabel(size: string) {
    const scale = inferMediaScale(size);
    const ratio = inferMediaRatio(size);
    if (ratio === "auto" || size === "auto") return i18n.t("settingsPanels.common.auto");
    if (scale === "auto") return ratio;
    return `${scale} · ${ratio}`;
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80"
            style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
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
            <input
                type="number"
                min={256}
                max={4096}
                step={32}
                className="min-w-0 flex-1 bg-transparent px-2 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                placeholder="1024"
                defaultValue={value}
                key={value}
                onBlur={(event) => onChange(event.currentTarget.value.trim() || "1024")}
                onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                }}
                onMouseDown={(event) => event.stopPropagation()}
            />
            <span className="grid w-7 place-items-center pr-1" style={{ color: theme.node.muted }}>
                px
            </span>
        </label>
    );
}

function DimensionInput({ prefix, value, disabled, theme, alignToStep, step, onChange }: { prefix: string; value: number; disabled: boolean; theme: CanvasTheme; alignToStep: boolean; step: number; onChange: (value: number | null) => void }) {
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

function CountInput({ value, max, theme, onChange }: { value: number; max: number; theme: CanvasTheme; onChange: (value: number | null) => void }) {
    return (
        <label className="col-span-2 flex h-9 overflow-hidden rounded-full border text-sm" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
            <input
                type="number"
                min={1}
                max={max}
                className="min-w-0 flex-1 bg-transparent px-3 text-center outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                style={{ color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                value={value || ""}
                onChange={(event) => onChange(Number(event.target.value) || null)}
                onMouseDown={(event) => event.stopPropagation()}
            />
        </label>
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

function alignDimension(value: number, enabled: boolean, step: number) {
    return enabled ? Math.ceil(value / step) * step : value;
}
