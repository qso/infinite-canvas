import { useEffect, useRef, useState } from "react";
import { ArrowUp, LoaderCircle, Maximize2, RotateCcw, Sparkles, Square } from "lucide-react";
import { Button } from "@infinite-canvas/plugin-sdk/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@infinite-canvas/plugin-sdk/ui/tooltip";
import { toast } from "sonner";
import { workbenchMessageOptions } from "@workbench/components/ui/sonner";
import { CanvasDialog } from "./canvas-dialog";

import { ModelPicker } from "@workbench/components/model-picker";
import { normalizeVideoModeValue } from "@workbench/components/video-settings-panel";
import { H3_REFERENCE_PROMPT_TEMPLATES, isMiniMaxH3 } from "@workbench/constant/comfyui";
import { isDreamMakerSeedance, SEEDANCE_FRAMES_PROMPT_TEMPLATES, SEEDANCE_REFERENCE_PROMPT_TEMPLATES } from "@workbench/constant/dreammaker";
import { isFireRedSpeech, isFireRedUnderstand } from "@workbench/constant/firered";
import { buildGenerationConfig } from "@workbench/lib/canvas/canvas-generation-helpers";
import { runFireRedUnderstandTask } from "@workbench/lib/canvas/fire-red-generation";
import { getPromptOptimizeSpec, optimizeModelPrompt } from "@workbench/lib/prompt-optimizer";
import { resolveModelForCapability, useConfigStore, useEffectiveConfig, type AiConfig } from "@workbench/stores/use-config-store";
import { canvasThemes } from "@workbench/lib/canvas-theme";
import { computeMediaSize, inferMediaScale } from "@workbench/lib/media-size";
import { getNodeDefinition } from "@workbench/lib/canvas/node-registry";
import { useThemeStore } from "@workbench/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasPromptLibrary } from "./canvas-prompt-library";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasPromptChipInput } from "./canvas-prompt-chip-input";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasNodeData } from "@infinite-canvas/shared/canvas/schema/canvas";
import type { CanvasNodeContext } from "@infinite-canvas/plugin-sdk";
import { canvasApply, nodeGenerate, nodeStop } from "@infinite-canvas/plugin-sdk/builtin";
import { hostActions } from "@workbench/lib/canvas/host-actions";
import { getPluginErrorMessage } from "@infinite-canvas/shared/plugins";
import { buildNodeMentionReferences } from "@workbench/lib/canvas/canvas-resource-references";
import { applyNodeConfigPatch } from "@workbench/lib/canvas/canvas-node-factory";
import { isNodeGenerationStopped } from "@workbench/lib/canvas/confirm-node-stop";
import { CanvasNodeReferenceBar } from "./canvas-node-reference-bar";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

type CanvasNodePromptPanelProps = {
    ctx: CanvasNodeContext;
    mode: CanvasNodeGenerationMode;
    onImageSettingsOpenChange?: (open: boolean) => void;
};

export function CanvasNodePromptPanel({ ctx, mode, onImageSettingsOpenChange }: CanvasNodePromptPanelProps) {
    const { node, isGenerating: isRunning } = ctx;
    const nodes = ctx.getNodes();
    const connectedNodes = ctx.getUpstream();
    const mentionReferences = buildNodeMentionReferences(node, nodes, ctx.getConnections(), ctx.scope);
    const globalConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const fixedRatio = mode === "image" ? getNodeDefinition(node.type)?.useBuiltinPanel?.imageAspectRatio : undefined;
    const nodeConfig = buildGenerationConfig(globalConfig, node, mode);
    const config = fixedRatio ? { ...nodeConfig, size: computeMediaSize(inferMediaScale(nodeConfig.size) === "auto" ? "2k" : inferMediaScale(nodeConfig.size), fixedRatio), count: "1" } : nodeConfig;
    const hasTextContent = mode === "text" && Boolean(node.metadata?.content);
    const hasImageContent = mode === "image" && Boolean(node.metadata?.storageKey || node.metadata?.content);
    const fireRedUnderstanding = mode === "text" && isFireRedUnderstand(config.model);
    const hasAudioReference = connectedNodes.some((item) => (item.type === CanvasNodeType.Audio || item.type === CanvasNodeType.Music) && Boolean(item.metadata?.storageKey || item.metadata?.content)) || mentionReferences.some((reference) => reference.kind === "audio");
    const allowEmptyPrompt = fireRedUnderstanding && hasAudioReference;
    const fireRedSpeech = mode === "audio" && isFireRedSpeech(config.model);
    const fireRedSpeechMode = node.metadata?.audioFireRedMode === "design" || node.metadata?.audioFireRedMode === "edit" ? node.metadata.audioFireRedMode : "clone";
    const canUseReferences = allowEmptyPrompt || mentionReferences.some((reference) => reference.nodeId !== node.id && (mode === "audio" ? reference.kind === "text" : mode !== "text" || reference.kind === "text" || reference.kind === "image"));
    const normalizedVideoMode = normalizeVideoModeValue(config.videoMode);
    const showReferenceTemplates = mode === "video" && isMiniMaxH3(config.model) && normalizedVideoMode === "reference";
    const showSeedanceTemplates = mode === "video" && isDreamMakerSeedance(config.model) && (normalizedVideoMode === "reference" || normalizedVideoMode === "frames");
    const [prompt, setPrompt] = useState(node.metadata?.composerContent ?? node.metadata?.prompt ?? "");
    const [expanded, setExpanded] = useState(false);
    const [optimizing, setOptimizing] = useState(false);
    const [promptBeforeOptimize, setPromptBeforeOptimize] = useState<string | null>(null);
    const optimizeControllerRef = useRef<AbortController | null>(null);
    const report = (error: unknown) => { if (!ctx.scope.signal.aborted) void toast.error(getPluginErrorMessage(error), workbenchMessageOptions.error); };
    const onConfigChange = (nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => {
        const current = ctx.getNode(nodeId);
        if (!current) return;
        const next = applyNodeConfigPatch(structuredClone(current) as CanvasNodeData, patch);
        const size = next.width !== current.width || next.height !== current.height ? { width: next.width, height: next.height, position: next.position } : undefined;
        void ctx.commands.execute(canvasApply, { ops: [{ type: "update_node", id: nodeId, metadata: patch, patch: size }] }, { scope: ctx.scope }).catch(report);
    };
    const onStartReferenceSelection = (nodeId: string) => { void hostActions.nodeSelectReferences({ nodeId }, ctx.scope.signal).catch(report); };
    const onDisconnectReference = (fromNodeId: string, toNodeId: string) => {
        const ids = ctx.getConnections().filter((edge) => edge.fromNodeId === fromNodeId && edge.toNodeId === toNodeId).map((edge) => edge.id);
        void ctx.commands.execute(canvasApply, { ops: [{ type: "delete_connections", ids }] }, { scope: ctx.scope }).catch(report);
    };

    useEffect(() => {
        optimizeControllerRef.current?.abort();
        setOptimizing(false);
        setPromptBeforeOptimize(null);
        setPrompt(node.metadata?.composerContent ?? node.metadata?.prompt ?? "");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [node.id]);

    const updatePrompt = (value: string) => {
        setPrompt(value);
        onConfigChange(node.id, { composerContent: value });
    };

    const submit = () => {
        const text = prompt;
        if ((!text && !canUseReferences) || isRunning) return;
        void ctx.commands.execute(nodeGenerate, { nodeId: node.id, mode, prompt: text }, { scope: ctx.scope }).catch((error) => {
            if (!isNodeGenerationStopped(error)) report(error);
        });
    };

    const mentionImages = mentionReferences.filter((reference) => reference.kind === "image");
    const mentionVideos = mentionReferences.filter((reference) => reference.kind === "video");
    const mentionAudios = mentionReferences.filter((reference) => reference.kind === "audio");
    const selfIsReference = mode === "image" && hasImageContent;
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
            toast.warning("请先输入简短的提示词或想法，再进行优化", workbenchMessageOptions.warning);
            return;
        }
        const textModel = resolveModelForCapability(globalConfig, globalConfig.textModel, "text");
        if (!isAiConfigReady(globalConfig, textModel)) {
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
                toast.success(`已按${optimizeSpec.specLabel}优化提示词`, workbenchMessageOptions.success);
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

    const handleUndoOptimize = () => {
        if (promptBeforeOptimize === null) return;
        updatePrompt(promptBeforeOptimize);
        setPromptBeforeOptimize(null);
    };

    const handleFireRedAutoTranscribe = async () => {
        const audio = connectedNodes.find((item) => (item.type === CanvasNodeType.Audio || item.type === CanvasNodeType.Music) && (item.metadata?.storageKey || item.metadata?.content));
        if (!audio) throw new Error("声音克隆需要连接参考音频（建议 5–10 秒清晰人声）");
        const ref = { id: audio.id, name: `${audio.title || audio.id}.wav`, type: audio.metadata?.mimeType || "audio/wav", url: audio.metadata?.content || "", storageKey: audio.metadata?.storageKey };
        const result = await runFireRedUnderstandTask("", [ref], false, { signal: ctx.scope.signal, onTaskId: () => undefined });
        return result.text;
    };

    const promptPlaceholder = fireRedUnderstanding
        ? "输入关于音频的问题；留空直接转写语音"
        : fireRedSpeech
          ? fireRedSpeechMode === "edit"
                ? "输入语音编辑指令（如：把“明天”改成“后天”）"
                : "输入要合成的语音文本"
          : ({ "image": "描述要生成的图片内容", "video": "描述要生成的视频内容", "audio": "描述要生成的音频内容", "text": "请输入你想要生成的文本内容", "editImage": "请输入你想要把这张图修改成什么", "editText": "请输入你想要将本段文本修改成什么" } as Record<string, string>)[mode === "image" && hasImageContent ? "editImage" : mode === "text" && hasTextContent ? "editText" : mode];

    return (
        <div
            data-canvas-no-zoom
            className="rounded-2xl border p-3 shadow-2xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <CanvasNodeReferenceBar nodeId={node.id} scope={ctx.scope} nodes={nodes} connectedNodes={connectedNodes} onDisconnect={onDisconnectReference} onStartSelection={onStartReferenceSelection} />
            {showReferenceTemplates ? <ReferenceTemplateChips templates={H3_REFERENCE_PROMPT_TEMPLATES} prompt={prompt} onApply={updatePrompt} /> : null}
            {showSeedanceTemplates ? <ReferenceTemplateChips templates={normalizedVideoMode === "reference" ? SEEDANCE_REFERENCE_PROMPT_TEMPLATES : SEEDANCE_FRAMES_PROMPT_TEMPLATES} prompt={prompt} onApply={updatePrompt} /> : null}
            <CanvasPromptChipInput
                value={prompt}
                references={mentionReferences}
                onChange={updatePrompt}
                onSubmit={submit}
                className="thin-scrollbar h-40 w-full cursor-text resize-none rounded-xl px-3 py-2 text-sm leading-5 outline-none"
                style={{ background: "transparent", color: theme.node.text }}
                placeholder={promptPlaceholder}
            />

            <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    <Tooltip><TooltipTrigger asChild>
                        <Button type="button" variant="ghost" size="icon-sm" className="shrink-0 rounded-full" style={{ color: theme.node.text }} onClick={() => setExpanded(true)} aria-label="放大编辑"><Maximize2 className="size-3.5" /></Button>
                    </TooltipTrigger><TooltipContent>放大编辑</TooltipContent></Tooltip>
                    <CanvasPromptLibrary onSelect={updatePrompt} />
                    {(mode === "image" || mode === "video") ? (
                        <>
                            <Tooltip><TooltipTrigger asChild>
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon-sm"
                                    className="shrink-0 rounded-full"
                                    style={{ color: theme.node.text }}
                                    disabled={!optimizing && !prompt.trim()}
                                    onClick={() => void handleOptimizePrompt()}
                                    aria-label="优化提示词"
                                >
                                    {optimizing ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                                </Button>
                            </TooltipTrigger><TooltipContent>{optimizing ? "停止优化" : `按${optimizeSpec.specLabel}优化提示词`}</TooltipContent></Tooltip>
                            {promptBeforeOptimize !== null && !optimizing ? (
                                <Tooltip><TooltipTrigger asChild>
                                    <Button type="button" variant="ghost" size="icon-sm" className="shrink-0 rounded-full" style={{ color: theme.node.text }} onClick={handleUndoOptimize} aria-label="撤销提示词优化">
                                        <RotateCcw className="size-3.5" />
                                    </Button>
                                </TooltipTrigger><TooltipContent>撤销提示词优化</TooltipContent></Tooltip>
                            ) : null}
                        </>
                    ) : null}
                    {mode === "image" ? (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="image" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <CanvasImageSettingsPopover
                                config={config}
                                fixedRatio={fixedRatio}
                                imageReferences={imageReferenceInfo}
                                placement="topLeft"
                                buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3"
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
                            <CanvasAudioSettingsPopover config={config} metadata={node.metadata as CanvasNodeData["metadata"]} hasAudioReference={hasAudioReference} onAutoTranscribe={handleFireRedAutoTranscribe} buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                        </>
                    ) : (
                        <>
                            <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="text" onMissingConfig={() => openConfigDialog(true)} className="max-w-[190px]" />
                            <CanvasTextSettingsPopover config={config} count={node.metadata?.textCount || 1} onConfigChange={(_, value) => onConfigChange(node.id, { reasoningEffort: value })} onCountChange={(textCount) => onConfigChange(node.id, { textCount })} />
                        </>
                    )}
                </div>
                <Button
                    type="button" variant={isRunning ? "destructive" : "default"}
                    className="h-10 min-w-16 shrink-0 rounded-full px-3"
                    disabled={!isRunning && !prompt && !canUseReferences}
                    onClick={() => (isRunning ? void ctx.commands.execute(nodeStop, { nodeId: node.id, confirm: true }, { scope: ctx.scope }).catch(report) : submit())}
                    aria-label={(isRunning ? "停止生成" : "生成")}
                >
                    <span className="flex items-center gap-1.5">
                        {isRunning ? (
                            <>
                                <LoaderCircle className="size-4 animate-spin" />
                                <Square className="size-3.5 fill-current" />
                                <span className="text-xs font-medium">停止</span>
                            </>
                        ) : (
                            <ArrowUp className="size-4" />
                        )}
                    </span>
                </Button>
            </div>
            <CanvasDialog title="编辑提示词" open={expanded} width={760} onClose={() => setExpanded(false)}>
                <div data-canvas-no-zoom className="pt-2" onWheelCapture={(event) => event.stopPropagation()}>
                    <CanvasNodeReferenceBar nodeId={node.id} scope={ctx.scope} nodes={nodes} connectedNodes={connectedNodes} onDisconnect={onDisconnectReference} onStartSelection={(nodeId) => { setExpanded(false); onStartReferenceSelection?.(nodeId); }} />
                    {showReferenceTemplates ? <ReferenceTemplateChips templates={H3_REFERENCE_PROMPT_TEMPLATES} prompt={prompt} onApply={updatePrompt} /> : null}
                    {showSeedanceTemplates ? <ReferenceTemplateChips templates={normalizedVideoMode === "reference" ? SEEDANCE_REFERENCE_PROMPT_TEMPLATES : SEEDANCE_FRAMES_PROMPT_TEMPLATES} prompt={prompt} onApply={updatePrompt} /> : null}
                    <CanvasPromptChipInput
                        value={prompt}
                        references={mentionReferences}
                        onChange={updatePrompt}
                        className="thin-scrollbar h-[52dvh] min-h-80 w-full cursor-text overflow-y-auto rounded-xl border p-4 text-[15px] leading-6 outline-none"
                        style={{ background: "transparent", borderColor: theme.toolbar.border, color: theme.node.text }}
                        placeholder={promptPlaceholder}
                    />
                    {(mode === "image" || mode === "video") ? (
                        <div className="mt-3 flex items-center justify-end gap-2">
                            {promptBeforeOptimize !== null && !optimizing ? (
                                <Button type="button" variant="outline" size="sm" onClick={handleUndoOptimize}>
                                    <RotateCcw className="size-3.5" />
                                    撤销优化
                                </Button>
                            ) : null}
                            <Button type="button" variant="outline" size="sm" disabled={!optimizing && !prompt.trim()} onClick={() => void handleOptimizePrompt()}>
                                {optimizing ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                                {optimizing ? "停止优化" : `按${optimizeSpec.specLabel}优化`}
                            </Button>
                        </div>
                    ) : null}
                </div>
            </CanvasDialog>
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

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSize") return { size: value };
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
