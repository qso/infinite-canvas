import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, LoaderCircle, Maximize2, RotateCcw, Sparkles, Square } from "lucide-react";
import { App, Button, Modal, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { normalizeVideoModeValue } from "@/components/video-settings-panel";
import { H3_REFERENCE_PROMPT_TEMPLATES, isMiniMaxH3 } from "@/constant/comfyui";
import { isDreamMakerSeedance, SEEDANCE_FRAMES_PROMPT_TEMPLATES, SEEDANCE_REFERENCE_PROMPT_TEMPLATES } from "@/constant/dreammaker";
import { isFireRedSpeech, isFireRedUnderstand } from "@/constant/firered";
import { buildGenerationConfig } from "@/lib/canvas/canvas-generation-helpers";
import { runFireRedUnderstandTask } from "@/lib/canvas/fire-red-generation";
import { getPromptOptimizeSpec, optimizeModelPrompt } from "@/lib/prompt-optimizer";
import { resolveModelForCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasPromptChipInput } from "./canvas-prompt-chip-input";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { CanvasNodeReferenceBar } from "./canvas-node-reference-bar";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onStop: (nodeId: string) => void;
    mentionReferences?: CanvasResourceReference[];
    nodes: CanvasNodeData[];
    connectedNodes?: CanvasNodeData[];
    onDisconnectReference?: (fromNodeId: string, toNodeId: string) => void;
    onStartReferenceSelection?: (nodeId: string) => void;
    onImageSettingsOpenChange?: (open: boolean) => void;
    modeOverride?: CanvasNodeGenerationMode; // Plugin nodes set their generation type through useBuiltinPanel.mode.
};

export function CanvasNodePromptPanel({ node, nodes, isRunning, onPromptChange, onConfigChange, onGenerate, onStop, mentionReferences = [], connectedNodes = [], onDisconnectReference, onStartReferenceSelection, onImageSettingsOpenChange, modeOverride }: CanvasNodePromptPanelProps) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = modeOverride ?? defaultMode(node.type);
    const config = buildGenerationConfig(globalConfig, node, mode);
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
    // FireRedAudio 识别/理解：连接音频参考后允许空提示词（空 = 纯转写）。
    const fireRedUnderstanding = mode === "text" && isFireRedUnderstand(config.model);
    const hasAudioReference = connectedNodes.some((item) => (item.type === CanvasNodeType.Audio || item.type === CanvasNodeType.Music) && Boolean(item.metadata?.content)) || mentionReferences.some((reference) => reference.kind === "audio");
    const allowEmptyPrompt = fireRedUnderstanding && hasAudioReference;
    // FireRedAudio 语音：外层提示词含义随模式变化（编辑 = 指令，其余 = 要合成的文本）。
    const fireRedSpeech = mode === "audio" && isFireRedSpeech(config.model);
    const fireRedSpeechMode = node.metadata?.audioFireRedMode === "design" || node.metadata?.audioFireRedMode === "edit" ? node.metadata.audioFireRedMode : "clone";
    const placeholderKey = fireRedUnderstanding
        ? "fireRedUnderstand"
        : fireRedSpeech
          ? fireRedSpeechMode === "edit"
                ? "fireRedEditText"
                : "fireRedSpeechText"
          : mode === "image" && hasImageContent
            ? "editImage"
            : mode === "text" && hasTextContent
              ? "editText"
              : mode;
    const normalizedVideoMode = normalizeVideoModeValue(config.videoMode);
    const showReferenceTemplates = mode === "video" && isMiniMaxH3(config.model) && normalizedVideoMode === "reference";
    const showSeedanceTemplates = mode === "video" && isDreamMakerSeedance(config.model) && (normalizedVideoMode === "reference" || normalizedVideoMode === "frames");
    const isEditingExistingContent = hasTextContent || hasImageContent;
    const [prompt, setPrompt] = useState(node.metadata?.composerContent ?? node.metadata?.prompt ?? "");
    const [expanded, setExpanded] = useState(false);
    const [optimizing, setOptimizing] = useState(false);
    const [promptBeforeOptimize, setPromptBeforeOptimize] = useState<string | null>(null);
    const optimizeControllerRef = useRef<AbortController | null>(null);

    // Restore prompts only when switching nodes; preserve the current input after generation on the same node.
    useEffect(() => {
        optimizeControllerRef.current?.abort();
        setOptimizing(false);
        setPromptBeforeOptimize(null);
        setPrompt(node.metadata?.composerContent ?? node.metadata?.prompt ?? "");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [node.id]);

    const updatePrompt = (value: string) => {
        setPrompt(value);
        if (isEditingExistingContent) onConfigChange(node.id, { composerContent: value });
        else onPromptChange(node.id, value);
    };

    // 图像编辑的参考图（按生成顺序）：编辑已有图片且未开原地覆盖时，节点自身是第 1 张参考图。
    const mentionImages = mentionReferences.filter((reference) => reference.kind === "image");
    const mentionVideos = mentionReferences.filter((reference) => reference.kind === "video");
    const mentionAudios = mentionReferences.filter((reference) => reference.kind === "audio");
    const selfIsReference = mode === "image" && hasImageContent && globalConfig.nodeRegenerateBehavior !== "overwrite";
    const imageReferenceInfo = { count: mentionImages.length + (selfIsReference ? 1 : 0), firstUrl: selfIsReference ? node.metadata?.content : mentionImages[0]?.previewUrl };
    const optimizeSpec = getPromptOptimizeSpec({
        mode,
        model: config.model,
        config,
        imageCount: imageReferenceInfo.count,
        videoCount: mentionVideos.length,
        audioCount: mentionAudios.length,
    });

    const handleOptimizePrompt = async () => {
        if (optimizing) {
            optimizeControllerRef.current?.abort();
            setOptimizing(false);
            return;
        }
        const draft = prompt.trim();
        if (!draft) {
            message.warning("请先输入简短的提示词或想法，再进行优化");
            return;
        }
        const textModel = resolveModelForCapability(globalConfig, globalConfig.textModel, "text");
        if (!isAiConfigReady(globalConfig, textModel)) {
            message.warning("请先在设置中配置文本模型（用于提示词优化）");
            openConfigDialog(true);
            return;
        }
        const controller = new AbortController();
        optimizeControllerRef.current = controller;
        setPromptBeforeOptimize(prompt);
        setOptimizing(true);
        try {
            const optimized = await optimizeModelPrompt(
                { ...globalConfig, textModel },
                draft,
                {
                    mode,
                    model: config.model,
                    config,
                    imageCount: imageReferenceInfo.count,
                    videoCount: mentionVideos.length,
                    audioCount: mentionAudios.length,
                },
                (partial) => {
                    if (!controller.signal.aborted && partial.trim()) updatePrompt(partial);
                },
                controller.signal,
            );
            if (!controller.signal.aborted && optimized) {
                updatePrompt(optimized);
                message.success(`已按${optimizeSpec.specLabel}优化提示词`);
            }
        } catch (error) {
            if (!(error instanceof DOMException && error.name === "AbortError")) {
                message.error(error instanceof Error ? error.message : "提示词优化失败");
                setPromptBeforeOptimize(null);
            }
        } finally {
            if (optimizeControllerRef.current === controller) optimizeControllerRef.current = null;
            setOptimizing(false);
        }
    };

    const handleUndoOptimize = () => {
        if (promptBeforeOptimize === null) return;
        updatePrompt(promptBeforeOptimize);
        setPromptBeforeOptimize(null);
    };
    // 声音克隆「自动识别」：用 FireRedAudio 自己的 ASR 转写第一个上游音频参考，填入参考转写框。
    const fireRedTranscribeControllerRef = useRef<AbortController | null>(null);
    const handleFireRedAutoTranscribe = useCallback(async (): Promise<string> => {
        const reference = connectedNodes.find((item) => (item.type === CanvasNodeType.Audio || item.type === CanvasNodeType.Music) && item.metadata?.content);
        if (!reference?.metadata?.content) throw new Error(t("canvas.fireRed.cloneNeedsAudio"));
        fireRedTranscribeControllerRef.current?.abort();
        const controller = new AbortController();
        fireRedTranscribeControllerRef.current = controller;
        const result = await runFireRedUnderstandTask("", [{ id: reference.id, name: `${reference.title || reference.id}.wav`, type: reference.metadata.mimeType || "audio/wav", url: reference.metadata.content, storageKey: reference.metadata.storageKey, durationMs: reference.metadata.durationMs }], false, { signal: controller.signal, onTaskId: () => {} });
        return result.text;
    }, [connectedNodes, t]);

    const submit = () => {
        if (isRunning) return;
        const text = prompt.trim();
        if (!text && !allowEmptyPrompt) return;
        onGenerate(node.id, mode, text);
    };

    const openExpandedEditor = () => {
        setExpanded(true);
    };

    return (
        <div
            data-canvas-no-zoom
            className="rounded-2xl border p-3 shadow-2xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <CanvasNodeReferenceBar nodeId={node.id} nodes={nodes} connectedNodes={connectedNodes} onDisconnect={onDisconnectReference} onStartSelection={onStartReferenceSelection} />
            {showReferenceTemplates ? <ReferenceTemplateChips templates={H3_REFERENCE_PROMPT_TEMPLATES} prompt={prompt} onApply={updatePrompt} /> : null}
            {showSeedanceTemplates ? <ReferenceTemplateChips templates={normalizedVideoMode === "reference" ? SEEDANCE_REFERENCE_PROMPT_TEMPLATES : SEEDANCE_FRAMES_PROMPT_TEMPLATES} prompt={prompt} onApply={updatePrompt} /> : null}
            <CanvasPromptChipInput
                value={prompt}
                references={mentionReferences}
                onChange={updatePrompt}
                onSubmit={submit}
                className="thin-scrollbar h-40 w-full cursor-text resize-none rounded-xl px-3 py-2 text-sm leading-5 outline-none"
                style={{ background: "transparent", color: theme.node.text }}
                placeholder={t(`canvas.promptPanel.${placeholderKey}`)}
            />

            <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <Tooltip title={t("canvas.promptPanel.expandEditor")}>
                        <Button type="text" className="!h-8 !w-8 !min-w-8 shrink-0 !rounded-full !bg-transparent !p-0" style={{ color: theme.node.text }} icon={<Maximize2 className="size-3.5" />} onClick={openExpandedEditor} aria-label={t("canvas.promptPanel.expandEditor")} />
                    </Tooltip>
                    <CanvasPromptLibrary onSelect={updatePrompt} />
                    {(mode === "image" || mode === "video") ? (
                        <>
                            <Tooltip title={optimizing ? "停止优化" : `按${optimizeSpec.specLabel}优化提示词`}>
                                <Button
                                    type="text"
                                    className="!h-8 !w-8 !min-w-8 shrink-0 !rounded-full !bg-transparent !p-0"
                                    style={{ color: theme.node.text }}
                                    disabled={!optimizing && !prompt.trim()}
                                    icon={optimizing ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                                    onClick={() => void handleOptimizePrompt()}
                                    aria-label="优化提示词"
                                />
                            </Tooltip>
                            {promptBeforeOptimize !== null && !optimizing ? (
                                <Tooltip title="撤销提示词优化">
                                    <Button
                                        type="text"
                                        className="!h-8 !w-8 !min-w-8 shrink-0 !rounded-full !bg-transparent !p-0"
                                        style={{ color: theme.node.text }}
                                        icon={<RotateCcw className="size-3.5" />}
                                        onClick={handleUndoOptimize}
                                        aria-label="撤销提示词优化"
                                    />
                                </Tooltip>
                            ) : null}
                        </>
                    ) : null}
                    {mode === "image" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="image" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <CanvasImageSettingsPopover
                                config={config}
                                placement="topLeft"
                                buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3"
                                imageReferences={imageReferenceInfo}
                                onConfigChange={(key, value) => onConfigChange(node.id, key === "count" ? { count: Number(value) || 1 } : { [key]: value })}
                                onMissingConfig={() => openConfigDialog(true)}
                                onOpenChange={onImageSettingsOpenChange}
                            />
                        </>
                    ) : mode === "video" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="video" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <CanvasVideoSettingsPopover config={config} buttonClassName="!h-10 !max-w-[220px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))} />
                        </>
                    ) : mode === "audio" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="audio" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <CanvasAudioSettingsPopover config={config} metadata={node.metadata} hasAudioReference={hasAudioReference} onAutoTranscribe={handleFireRedAutoTranscribe} buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                        </>
                    ) : (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="text" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <CanvasTextSettingsPopover config={config} count={node.metadata?.textCount || 1} onConfigChange={(_, value) => onConfigChange(node.id, { reasoningEffort: value })} onCountChange={(textCount) => onConfigChange(node.id, { textCount })} />
                        </>
                    )}
                </div>
                <Button
                    type="primary"
                    className="!h-10 !min-w-16 shrink-0 !rounded-full !px-3"
                    danger={isRunning}
                    disabled={!isRunning && !prompt.trim() && !allowEmptyPrompt}
                    onClick={() => (isRunning ? onStop(node.id) : submit())}
                    aria-label={t(isRunning ? "canvas.promptPanel.stopGeneration" : "canvas.promptPanel.generate")}
                >
                    <span className="flex items-center gap-1.5">
                        {isRunning ? (
                            <>
                                <LoaderCircle className="size-4 animate-spin" />
                                <Square className="size-3.5 fill-current" />
                                <span className="text-xs font-medium">{t("canvas.promptPanel.stop")}</span>
                            </>
                        ) : (
                            <ArrowUp className="size-4" />
                        )}
                    </span>
                </Button>
            </div>
            <Modal title={t("canvas.promptPanel.editorTitle")} open={expanded} centered width={760} footer={null} onCancel={() => setExpanded(false)} destroyOnHidden>
                <div data-canvas-no-zoom className="pt-2" onWheelCapture={(event) => event.stopPropagation()}>
                    <CanvasNodeReferenceBar nodeId={node.id} nodes={nodes} connectedNodes={connectedNodes} onDisconnect={onDisconnectReference} onStartSelection={(nodeId) => { setExpanded(false); onStartReferenceSelection?.(nodeId); }} />
                    {showReferenceTemplates ? <ReferenceTemplateChips templates={H3_REFERENCE_PROMPT_TEMPLATES} prompt={prompt} onApply={updatePrompt} /> : null}
                    {showSeedanceTemplates ? <ReferenceTemplateChips templates={normalizedVideoMode === "reference" ? SEEDANCE_REFERENCE_PROMPT_TEMPLATES : SEEDANCE_FRAMES_PROMPT_TEMPLATES} prompt={prompt} onApply={updatePrompt} /> : null}
                    <CanvasPromptChipInput
                        value={prompt}
                        references={mentionReferences}
                        onChange={updatePrompt}
                        className="thin-scrollbar h-[52dvh] min-h-80 w-full cursor-text overflow-y-auto rounded-xl border p-4 text-[15px] leading-6 outline-none"
                        style={{ background: "transparent", borderColor: theme.toolbar.border, color: theme.node.text }}
                        placeholder={t(`canvas.promptPanel.${placeholderKey}`)}
                    />
                    {(mode === "image" || mode === "video") ? (
                        <div className="mt-3 flex items-center justify-end gap-2">
                            {promptBeforeOptimize !== null && !optimizing ? (
                                <Button size="small" icon={<RotateCcw className="size-3.5" />} onClick={handleUndoOptimize}>
                                    撤销优化
                                </Button>
                            ) : null}
                            <Button
                                size="small"
                                icon={optimizing ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                                disabled={!optimizing && !prompt.trim()}
                                onClick={() => void handleOptimizePrompt()}
                            >
                                {optimizing ? "停止优化" : `按${optimizeSpec.specLabel}优化`}
                            </Button>
                        </div>
                    ) : null}
                </div>
            </Modal>
        </div>
    );
}

function ReferenceTemplateChips({ templates, prompt, onApply }: { templates: Array<{ label: string; prompt: string }>; prompt: string; onApply: (value: string) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <div className="mb-2 flex flex-wrap gap-1.5">
            {templates.map((template) => (
                <button
                    key={template.label}
                    type="button"
                    className="cursor-pointer rounded-full border px-2.5 py-1 text-xs transition hover:opacity-75"
                    style={{ background: "transparent", borderColor: theme.toolbar.border, color: theme.node.text }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={() => onApply(prompt.trim() ? `${prompt.trim()}\n${template.prompt}` : template.prompt)}
                >
                    {template.label}
                </button>
            ))}
        </div>
    );
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    if (key === "videoMode") return { videoMode: value };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string): Partial<CanvasNodeData["metadata"]> {
    if (key === "audioVoice") return { audioVoice: value };
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSpeed") return { audioSpeed: value };
    if (key === "audioInstructions") return { audioInstructions: value };
    if (key === "audioFireRedMode") return { audioFireRedMode: value === "design" || value === "edit" ? value : "clone" };
    if (key === "audioFireRedTranscript") return { audioFireRedTranscript: value };
    if (key === "audioFireRedVoiceDesc") return { audioFireRedVoiceDesc: value };
    if (key === "audioFireRedLanguage") return { audioFireRedLanguage: value === "en" || value === "zh" ? value : "auto" };
    return { audioFireRedSeed: value };
}
