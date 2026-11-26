import { BookOpen, FolderPlus, LoaderCircle, Plus, RotateCcw, Send, SlidersHorizontal, Sparkles, Square, X } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Button } from "@infinite-canvas/plugin-sdk/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@infinite-canvas/plugin-sdk/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@infinite-canvas/plugin-sdk/ui/select";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@infinite-canvas/plugin-sdk/ui/tooltip";
import { cn } from "@infinite-canvas/plugin-sdk/ui/utils";
import { workbenchMessageOptions } from "@workbench/components/ui/sonner";
import { AudioSettingsPanel } from "@workbench/components/audio-settings-panel";
import { CreateAgentSettings } from "./create-agent-settings";
import { ImageSettingsPanel, imageSizeLabel } from "@workbench/components/image-settings-panel";
import { ImageThumbnail } from "@workbench/components/image-thumbnail";
import { ModelPicker } from "@workbench/components/model-picker";
import { VideoSettingsPanel, videoResolutionLabel, videoSecondsLabel, videoSizeLabel } from "@workbench/components/video-settings-panel";
import { getDreamMakerImageSpec } from "@workbench/constant/dreammaker";
import { audioFormatLabel, audioSpeedLabel, audioVoiceLabel } from "@workbench/lib/audio-generation";
import { canvasThemes } from "@workbench/lib/canvas-theme";
import { getPromptOptimizeSpec, optimizeModelPrompt } from "@workbench/lib/prompt-optimizer";
import { useThemeStore } from "@workbench/stores/use-theme-store";
import { resolveModelForCapability, useConfigStore, type AiConfig } from "@workbench/stores/use-config-store";
import type { ReferenceImage } from "@workbench/types/image";
import type { CreateMode } from "@workbench/services/create/logs";
import { CreationPromptEditor } from "./create-prompt-editor";

const createTypes = [["agent", "Agent 模式", "Agent"], ["image", "图片创作", "图片"], ["video", "视频创作", "视频"], ["audio", "音频创作", "音频"]] as const;

type UpdateAiConfig = <K extends Exclude<keyof AiConfig, "channels">>(key: K, value: AiConfig[K]) => unknown;

export function CreateComposer({ type, onTypeChange, prompt, onPromptChange, references, running, config, updateConfig, onGenerate, onAddFiles, onRemoveReference, onPreviewReference, onOpenPrompts, onOpenAssets, openConfigDialog, onStop, inline = false }: {
    type: CreateMode;
    onTypeChange: (type: CreateMode) => void;
    prompt: string;
    onPromptChange: (prompt: string) => void;
    references: ReferenceImage[];
    running: boolean;
    config: AiConfig;
    updateConfig: UpdateAiConfig;
    onGenerate: () => void;
    onAddFiles: (files: File[]) => void;
    onRemoveReference: (id: string) => void;
    onPreviewReference: (reference: ReferenceImage, references?: ReferenceImage[]) => void;
    onOpenPrompts: () => void;
    onOpenAssets: () => void;
    openConfigDialog: (shouldPromptContinue?: boolean) => void;
    onStop?: () => void;
    inline?: boolean;
}) {
    const fileInput = useRef<HTMLInputElement>(null);
    const typeIndicatorId = useId();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const [optimizing, setOptimizing] = useState(false);
    const [promptBeforeOptimize, setPromptBeforeOptimize] = useState<string | null>(null);
    const optimizeControllerRef = useRef<AbortController | null>(null);
    const disabled = !prompt || running;
    const modelKey = type === "agent" ? "textModel" : type === "image" ? "imageModel" : type === "video" ? "videoModel" : "audioModel";
    const activeModel = config[modelKey] || config.model;
    const dmImgSpec = type === "image" ? getDreamMakerImageSpec(activeModel) : null;
    const displayImageCount = dmImgSpec?.family === "mj" ? Math.max(4, Math.min(12, Math.ceil((Number(config.count) || 1) / 4) * 4)) : Math.max(1, Math.min(10, Number(config.count) || 1));
    const summary = type === "agent" ? "" : type === "image"
        ? `${imageSizeLabel(config.size).replace(/^(\d+)k/i, "$1K")} · ${displayImageCount} 张`
        : type === "video"
            ? `${videoResolutionLabel(config.vquality)} · ${videoSizeLabel(config.videoSize)} · ${videoSecondsLabel(config.videoSeconds)}`
            : `${audioVoiceLabel(config.audioVoice)} · ${audioFormatLabel(config.audioFormat)} · ${audioSpeedLabel(config.audioSpeed)}`;

    const optimizeSpec = type === "image" || type === "video"
        ? getPromptOptimizeSpec({ mode: type, model: activeModel, config: { ...config, model: activeModel }, imageCount: references.length, videoCount: 0, audioCount: 0 })
        : null;

    const handleOptimize = async () => {
        if (type !== "image" && type !== "video") return;
        if (optimizing) {
            optimizeControllerRef.current?.abort();
            setOptimizing(false);
            return;
        }
        const draft = prompt.trim();
        if (!draft) {
            toast.warning("请先输入简短的提示词或想法，再进行优化", workbenchMessageOptions.warning);
            return;
        }
        const textModel = resolveModelForCapability(config, config.textModel, "text");
        if (!isAiConfigReady(config, textModel)) {
            toast.warning("请先在设置中配置文本模型（用于提示词优化）", workbenchMessageOptions.warning);
            openConfigDialog(true);
            return;
        }
        const controller = new AbortController();
        optimizeControllerRef.current = controller;
        setPromptBeforeOptimize(prompt);
        setOptimizing(true);
        try {
            const optimized = await optimizeModelPrompt(
                { ...config, textModel },
                draft,
                { mode: type, model: activeModel, config: { ...config, model: activeModel }, imageCount: references.length, videoCount: 0, audioCount: 0 },
                (partial) => {
                    if (!controller.signal.aborted && partial.trim()) onPromptChange(partial);
                },
                controller.signal,
            );
            if (!controller.signal.aborted && optimized) {
                onPromptChange(optimized);
                toast.success(`已按${optimizeSpec?.specLabel || "模型规范"}优化提示词`, workbenchMessageOptions.success);
            }
        } catch (error) {
            if (!(error instanceof DOMException && error.name === "AbortError")) {
                toast.error(error instanceof Error ? error.message : "提示词优化失败", workbenchMessageOptions.error);
                setPromptBeforeOptimize(null);
            }
        } finally {
            if (optimizeControllerRef.current === controller) optimizeControllerRef.current = null;
            setOptimizing(false);
        }
    };
    return (
        <div className={inline ? "relative w-full" : "pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background to-transparent px-3 pb-3 pt-12 sm:px-6 sm:pb-5"}>
            <div className="pointer-events-auto mx-auto max-w-[1000px] rounded-[24px] border bg-card px-3 pb-3 pt-3 sm:px-4 shadow-[0_16px_50px_rgba(0,0,0,0.09)]">
                <div
                    className="flex min-h-[84px] items-center gap-3 overflow-x-auto px-1 py-2"
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                        event.preventDefault();
                        onAddFiles(Array.from(event.dataTransfer.files));
                    }}
                >
                    <button
                        type="button"
                        className="grid h-[72px] w-14 shrink-0 -rotate-6 place-items-center rounded-sm border border-dashed bg-muted/60 text-muted-foreground transition hover:rotate-0 hover:bg-muted hover:text-foreground"
                        onClick={() => fileInput.current?.click()}
                    >
                        <Plus className="size-5" />
                        <span className="sr-only">添加参考图</span>
                    </button>
                    <TooltipProvider delayDuration={120}>
                        {references.map((item, index) => (
                            <Tooltip key={item.id}>
                                <TooltipTrigger asChild>
                                    <div className="group relative h-[72px] w-14 shrink-0 overflow-hidden rounded-sm border">
                                        <button type="button" className="block size-full cursor-zoom-in" aria-label={`查看${item.name}`} onClick={() => onPreviewReference(item, references)}>
                                            {item.storageKey
                                                ? <ImageThumbnail storageKey={item.storageKey} alt={item.name} className="size-full" />
                                                : item.url || item.dataUrl ? <img src={item.url || item.dataUrl} alt={item.name} className="size-full object-cover" /> : null}
                                        </button>
                                        <button type="button" className="absolute right-1 top-1 rounded-full bg-background/90 p-1 text-foreground opacity-0 shadow-sm transition group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => onRemoveReference(item.id)}>
                                            <X className="size-3" />
                                            <span className="sr-only">移除参考图</span>
                                        </button>
                                    </div>
                                </TooltipTrigger>
                                <TooltipContent side="top" sideOffset={8} className="border-0 bg-transparent p-0 text-inherit shadow-none [&>svg]:hidden">
                                    <div className="overflow-hidden rounded-xl border bg-popover text-popover-foreground shadow-xl">
                                        {item.storageKey
                                            ? <ImageThumbnail storageKey={item.storageKey} alt={item.name} className="size-32" />
                                            : item.url || item.dataUrl ? <img src={item.url || item.dataUrl} alt={item.name} className="size-32 object-cover" /> : null}
                                        <div className="max-w-32 truncate border-t px-2 py-1 text-[11px]">图片{index + 1} · {item.name}</div>
                                    </div>
                                </TooltipContent>
                            </Tooltip>
                        ))}
                    </TooltipProvider>
                </div>
                <CreationPromptEditor
                    value={prompt}
                    references={references}
                    placeholder={type === "agent" ? "描述你想完成的任务，Agent 会先给出生成卡片，确认后再生成…" : type === "image" ? "描述画面主体、风格、构图、光线和用途，输入 @ 引用参考图…" : type === "video" ? "描述镜头运动、主体动作、场景氛围和画面风格，输入 @ 引用参考图…" : "描述要生成的声音内容、语气和用途，例如温暖自然的中文旁白…"}
                    onChange={onPromptChange}
                    onSubmit={onGenerate}
                />
                <div className="mt-1.5 flex items-center gap-1.5 sm:flex-wrap sm:gap-2">
                    <Select value={type} onValueChange={(value) => onTypeChange(value as CreateMode)}>
                        <SelectTrigger size="sm" aria-label="创作类型" className="shrink-0 rounded-full sm:hidden"><SelectValue /></SelectTrigger>
                        <SelectContent>{createTypes.map(([value, , short]) => <SelectItem key={value} value={value}>{short}</SelectItem>)}</SelectContent>
                    </Select>
                    <div className="relative hidden shrink-0 sm:flex items-center rounded-full border bg-muted/60 p-0.5" role="tablist" aria-label="创作类型">
                        {createTypes.map(([value, label]) => (
                            <button
                                key={value}
                                type="button"
                                role="tab"
                                aria-selected={type === value}
                                className={cn(
                                    "relative h-7 rounded-full px-3 text-sm transition-colors",
                                    type === value ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                                )}
                                onClick={() => onTypeChange(value)}
                            >
                                {type === value ? <motion.span layoutId={typeIndicatorId} className="absolute inset-0 rounded-full bg-background shadow-sm dark:bg-input/80" transition={{ type: "spring", stiffness: 500, damping: 34 }} /> : null}
                                <span className="relative">{label}</span>
                            </button>
                        ))}
                    </div>
                    <ModelPicker
                        config={config}
                        value={type === "agent" ? config.textModel : config[modelKey] || config.model}
                        capability={type === "agent" ? "text" : type}
                        onChange={(model) => updateConfig(modelKey, model)}
                        className="min-w-0 flex-1 sm:max-w-[220px] sm:min-w-[9rem] sm:flex-none"
                        onMissingConfig={() => openConfigDialog(false)}
                    />
                    {type === "agent" ? <CreateAgentSettings /> : <Popover>
                        <PopoverTrigger asChild>
                            <Button type="button" variant="outline" aria-label="生成参数" className="h-8 shrink-0 rounded-full px-2.5 font-normal sm:px-3">
                                <SlidersHorizontal data-icon="inline-start" />
                                <span className="hidden truncate sm:inline">{summary}</span>
                            </Button>
                        </PopoverTrigger>
                        <PopoverContent align="start" side="top" collisionPadding={12} onOpenAutoFocus={(event) => event.preventDefault()}
                            className={cn("thin-scrollbar overflow-y-auto overscroll-contain p-4", type === "image" ? "max-h-[min(680px,var(--radix-popover-content-available-height,70dvh))] w-[min(520px,calc(100vw-24px))]" : "max-h-[min(560px,var(--radix-popover-content-available-height,70dvh))] w-[min(340px,calc(100vw-24px))]")}>
                            {type === "image"
                                ? <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} imageReferences={{ count: references.length, firstUrl: references[0]?.dataUrl || references[0]?.url }} className="w-full space-y-4" />
                                : type === "video"
                                    ? <VideoSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="w-full space-y-4" />
                                    : <AudioSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} className="w-full space-y-4" />}
                        </PopoverContent>
                    </Popover>}
                    <TooltipProvider>
                        {optimizeSpec ? (
                            <>
                                <ComposerTool
                                    label={optimizing ? "停止优化" : `按${optimizeSpec.specLabel}优化提示词`}
                                    icon={optimizing ? <LoaderCircle className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                                    onClick={() => void handleOptimize()}
                                />
                                {promptBeforeOptimize !== null && !optimizing ? (
                                    <ComposerTool
                                        label="撤销提示词优化"
                                        icon={<RotateCcw className="size-4" />}
                                        onClick={() => { onPromptChange(promptBeforeOptimize); setPromptBeforeOptimize(null); }}
                                    />
                                ) : null}
                            </>
                        ) : null}
                        <ComposerTool label="提示词库" icon={<BookOpen className="size-4" />} onClick={onOpenPrompts} />
                        <ComposerTool label="我的资产" icon={<FolderPlus className="size-4" />} onClick={onOpenAssets} />
                    </TooltipProvider>
                    <Button type="button" size="icon" className="ml-auto shrink-0 rounded-full" disabled={running ? !onStop : disabled} aria-busy={running} onClick={running && onStop ? onStop : onGenerate}>
                        {running && onStop ? <Square className="size-4 fill-current" /> : running ? <LoaderCircle className="animate-spin" /> : <Send />}
                        <span className="sr-only">{running && onStop ? "停止" : "生成"}</span>
                    </Button>
                </div>
            </div>
            <input
                ref={fileInput}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    if (event.target.files) onAddFiles(Array.from(event.target.files));
                    event.target.value = "";
                }}
            />
        </div>
    );
}

function ComposerTool({ label, icon, onClick }: { label: string; icon: ReactNode; onClick: () => void }) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={label} onClick={onClick}>{icon}</Button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
        </Tooltip>
    );
}
