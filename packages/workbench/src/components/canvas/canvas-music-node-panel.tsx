import { useRef, useState } from "react";
import { ArrowUp, Download, FileText, LoaderCircle, Music4, RefreshCw, Settings2, Square } from "lucide-react";
import { saveAs } from "file-saver";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { Button } from "@infinite-canvas/plugin-sdk/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@infinite-canvas/plugin-sdk/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@infinite-canvas/plugin-sdk/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@infinite-canvas/plugin-sdk/ui/tooltip";

import {
    MUSIC_ENDPOINT,
    MUSIC_MODEL,
    type MusicCreationMode,
    type MusicFormat,
    type MusicGenerationDraft,
    type MusicOutputType,
    type MusicPlanningMode,
} from "@workbench/constant/music";
import { canvasThemes } from "@workbench/lib/canvas-theme";
import {
    audioExtension,
    buildMusicGenerationRequest,
    hasResumableMusicTask,
    musicDraftFromRequest,
    readMusicDraft,
    readMusicReferenceAnalysis,
    selectMusicReference,
} from "@workbench/lib/canvas/canvas-generation-helpers";
import { audioMetadata, createCanvasNode } from "@workbench/lib/canvas/canvas-node-factory";
import { getGroupResourceNodes } from "@workbench/lib/canvas/canvas-resource-references";
import { hostActions } from "@workbench/lib/canvas/host-actions";
import { createMusicAnalysis, createMusicGenerationTask, getMusicGenerationContent, getMusicGenerationScore, MusicApiError, uploadMusicReference, waitForMusicAnalysis, waitForMusicGenerationTask } from "@workbench/services/api/music";
import { deleteStoredMedia, readMediaBlob, uploadMediaFile, type UploadedFile } from "@workbench/services/file-storage";
import { useThemeStore } from "@workbench/stores/use-theme-store";
import { workbenchMessageOptions } from "@workbench/components/ui/sonner";
import { CanvasDialog } from "./canvas-dialog";
import { CanvasNodeReferenceBar } from "./canvas-node-reference-bar";
import { CanvasSegments } from "./canvas-segments";
import { isMusicReferenceNode } from "./canvas-node-generation";
import type { CanvasNodePanelProps } from "@infinite-canvas/plugin-sdk";
import { canvasApply } from "@infinite-canvas/plugin-sdk/builtin";
import { getPluginErrorMessage } from "@infinite-canvas/shared/plugins";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@infinite-canvas/shared/canvas/schema/canvas";
import { NODE_DEFAULT_SIZE } from "@infinite-canvas/shared/canvas/schema/node-specs";

const STAGE_LABELS: Record<string, string> = {
    queued: "排队中",
    planning: "乐谱规划中",
    instrumentalizing: "纯音乐化处理",
    semantic: "声学语义生成",
    synthesizing: "音频合成中",
    decoding: "波形解码中",
    saving: "保存音频中",
    completed: "已完成",
    failed: "失败",
};

const ANALYSIS_STAGE_LABELS: Record<string, string> = {
    queued: "等待分析参考音频",
    decoding: "解码音频",
    separating: "人声伴奏分离",
    transcribing: "提取旋律乐谱",
    captioning: "分析曲风标签",
    lyrics: "提取参考歌词",
    analysis_completed: "参考分析完成",
    completed: "参考分析完成",
    failed: "参考分析失败",
};

const CREATION_MODES: Array<{ value: MusicCreationMode; label: string; hint: string }> = [
    { value: "original", label: "原创创作", hint: "" },
    { value: "melody", label: "旋律参考", hint: "参考原曲主旋律与节奏，重新编曲填词。" },
    { value: "full", label: "和弦延续", hint: "保留完整伴奏和弦与骨架，按新风格歌词重塑。" },
    { value: "style", label: "曲风迁移", hint: "自动提取参考曲风描述，从零创作同风格新歌。" },
];

export function CanvasMusicNodePanel({ ctx }: CanvasNodePanelProps) {
    const { node } = ctx;
    const nodes = ctx.getNodes();
    const connectedNodes = ctx.getUpstream();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [analysisEditor, setAnalysisEditor] = useState(false);
    const [localRunning, setLocalRunning] = useState(false);
    const controllerRef = useRef<AbortController | null>(null);

    const draft = readMusicDraft(node.metadata);
    const taskId = node.metadata?.musicTaskId;
    const pendingTask = hasResumableMusicTask(node);
    const analysisPending = Boolean(node.metadata?.musicAnalysisId) && (node.metadata?.musicAnalysisStatus === "queued" || node.metadata?.musicAnalysisStatus === "running");
    const isRunning = localRunning || ctx.isGenerating;
    const locked = isRunning || Boolean(node.metadata?.musicSavePending);

    const report = (error: unknown) => {
        if (!ctx.scope.signal.aborted) toast.error(error instanceof Error ? error.message : getPluginErrorMessage(error), workbenchMessageOptions.error);
    };

    const patchNode = (targetId: string, patch: Partial<CanvasNodeMetadata>, extraTitle?: string) => {
        return ctx.commands.execute(
            canvasApply,
            { ops: [{ type: "update_node", id: targetId, metadata: patch, ...(extraTitle ? { patch: { title: extraTitle } } : {}) }] },
            { scope: ctx.scope },
        );
    };

    const update = (patch: Partial<MusicGenerationDraft>) => {
        void patchNode(node.id, {
            musicDraft: { ...draft, ...patch },
            ...(patch.referenceNodeId !== undefined ? { musicReferenceStyle: undefined } : {}),
        }).catch(report);
    };

    const referenceNodes = connectedNodes.filter((source) => isMusicReferenceNode(source, nodes));
    const eligibleNodes = nodes.filter((item) => isMusicReferenceNode(item, nodes));
    const audioReferences = [
        ...new Map(
            referenceNodes
                .flatMap((source) => (source.type === CanvasNodeType.Group ? getGroupResourceNodes(source.id, nodes) : [source]))
                .filter((item) => (item.type === CanvasNodeType.Audio || item.type === CanvasNodeType.Music) && (item.metadata?.storageKey || item.metadata?.content))
                .map((item) => [item.id, item]),
        ).values(),
    ];
    const connectedLyrics = referenceNodes
        .flatMap((source) => (source.type === CanvasNodeType.Group ? getGroupResourceNodes(source.id, nodes) : [source]))
        .filter((item) => item.type === CanvasNodeType.Text)
        .map((item) => item.metadata?.content || item.metadata?.prompt || "")
        .filter(Boolean)
        .join("\n\n");

    const selectedReference = selectMusicReference(node, audioReferences);
    const mode = draft.creationMode || "original";
    const outputType = draft.outputType || "song";
    const planningMode = mode === "melody" || mode === "full" ? mode : draft.cot;
    const analysis = readMusicReferenceAnalysis(node, selectedReference);
    const referenceStyle = node.metadata?.musicReferenceStyle ?? analysis?.style ?? "";
    const inheritedLyrics = analysis?.lyrics || (mode !== "original" ? analysis?.source_lyrics || (selectedReference?.metadata?.musicRequest as { lyrics?: string } | undefined)?.lyrics || "" : "");
    const effectiveLyrics = connectedLyrics.trim() ? connectedLyrics : inheritedLyrics;
    const hasReferenceInput = Boolean(analysis && (mode === "style" ? Boolean(analysis.style?.trim()) && Boolean(referenceStyle.trim()) : Boolean(draft.abc.trim() || (mode === "melody" ? analysis.abc_melody?.trim() : analysis.abc_full?.trim()))));
    const canGenerate = mode === "original" ? Boolean(draft.style.trim()) : hasReferenceInput && (mode === "style" || Boolean(draft.style.trim()));

    const stage = node.metadata?.musicTaskStage || node.metadata?.musicTaskStatus;
    const knownStage = stage && stage in STAGE_LABELS;

    const onDisconnect = (fromNodeId: string, toNodeId: string) => {
        const ids = ctx.getConnections().filter((edge) => edge.fromNodeId === fromNodeId && edge.toNodeId === toNodeId).map((edge) => edge.id);
        void ctx.commands.execute(canvasApply, { ops: [{ type: "delete_connections", ids }] }, { scope: ctx.scope }).catch(report);
    };

    const onStartSelection = (nodeId: string) => {
        void hostActions.nodeSelectReferences({ nodeId }, ctx.scope.signal).catch(report);
    };

    const stopCurrent = () => {
        controllerRef.current?.abort(new DOMException("Aborted", "AbortError"));
        controllerRef.current = null;
        setLocalRunning(false);
    };

    const analyzeReference = async (extractLyrics = false, resume = false) => {
        if (localRunning) return;
        const reference = selectedReference;
        if (!resume && !reference) {
            toast.warning("请先连接一条音频或音乐节点作为参考", workbenchMessageOptions.warning);
            return;
        }
        const referenceKey = reference?.metadata?.storageKey || reference?.metadata?.content;
        const sameReference = Boolean(reference && node.metadata?.musicAnalysisNodeId === reference.id && node.metadata.musicAnalysisStorageKey === referenceKey);
        const controller = new AbortController();
        controllerRef.current = controller;
        setLocalRunning(true);
        const signal = AbortSignal.any([ctx.scope.signal, controller.signal]);
        try {
            let request = resume ? (node.metadata?.musicAnalysisRequest as Parameters<typeof createMusicAnalysis>[0] | undefined) : undefined;
            if (resume && (!request || request.id !== node.metadata?.musicAnalysisId)) throw new Error("缺少参考分析请求信息");
            if (!request) {
                const previous = sameReference ? (node.metadata?.musicAnalysisRequest as Parameters<typeof createMusicAnalysis>[0] | undefined) : undefined;
                let audioId = reference?.metadata?.musicAudioStorageKey === referenceKey ? reference?.metadata?.musicAudioId || null : null;
                const refTaskId = reference?.type === CanvasNodeType.Music && reference.metadata?.musicTaskEndpoint === MUSIC_ENDPOINT && reference.metadata.musicTaskStatus === "completed" && !reference.metadata.musicContentUnavailable ? reference.metadata.musicTaskId || null : null;
                if (!refTaskId && !audioId) {
                    const blob = await readMediaBlob(reference?.metadata?.storageKey, reference?.metadata?.content, { signal });
                    audioId = (await uploadMusicReference(blob, { signal })).id;
                    if (reference?.id) await patchNode(reference.id, { musicAudioId: audioId, musicAudioStorageKey: referenceKey });
                }
                request = {
                    id: crypto.randomUUID(),
                    source: { audio_id: refTaskId ? null : audioId, music_task_id: refTaskId },
                    score: mode === "melody" || mode === "full" || Boolean(previous?.score),
                    style: mode === "style" || Boolean(previous?.style),
                    lyrics: extractLyrics || (draft.outputType !== "instrumental" && Boolean(previous?.lyrics)),
                };
                await patchNode(node.id, {
                    status: "loading",
                    musicError: undefined,
                    errorDetails: undefined,
                    musicAnalysisId: request.id,
                    musicAnalysisRequest: request as unknown as Record<string, unknown>,
                    musicAnalysisStatus: "queued",
                    musicAnalysisStage: "queued",
                    musicAnalysisNodeId: reference?.id,
                    musicAnalysisStorageKey: referenceKey,
                    musicAnalysisMissing: false,
                    musicAnalysis: undefined,
                    musicDraft: { ...draft, referenceNodeId: reference?.id, ...(!sameReference && node.metadata?.musicAnalysisNodeId ? { abc: "" } : {}) },
                    ...(!sameReference ? { musicReferenceStyle: undefined } : {}),
                });
                await createMusicAnalysis(request, { signal });
            }
            const task = await waitForMusicAnalysis(request.id, {
                signal,
                onTask: (current) => {
                    void patchNode(node.id, { musicAnalysisStatus: current.status, musicAnalysisStage: current.stage });
                },
            });
            if (task.status === "failed" || !task.result) throw new Error(task.error || "参考音频分析失败");
            const currentNode = ctx.getNode(node.id);
            await patchNode(node.id, {
                musicAnalysis: task.result as unknown as Record<string, unknown>,
                musicAnalysisStatus: "completed",
                musicAnalysisStage: "analysis_completed",
                musicAnalysisMissing: false,
                musicReferenceStyle: currentNode?.metadata?.musicReferenceStyle ?? task.result.style ?? undefined,
                status: currentNode?.metadata?.storageKey || currentNode?.metadata?.content ? "success" : "idle",
            });
        } catch (error) {
            if (!signal.aborted) {
                const detail = error instanceof Error ? error.message : "参考音频分析失败";
                const hasContent = Boolean(ctx.getNode(node.id)?.metadata?.storageKey || ctx.getNode(node.id)?.metadata?.content);
                await patchNode(node.id, {
                    status: hasContent ? "success" : "error",
                    musicError: detail,
                    errorDetails: detail,
                    ...(error instanceof MusicApiError && error.status === 404 ? { musicAnalysisMissing: true, musicAnalysisStatus: "failed", musicAnalysisStage: "failed" } : {}),
                });
                toast.error(detail, workbenchMessageOptions.error);
            }
        } finally {
            if (controllerRef.current === controller) controllerRef.current = null;
            setLocalRunning(false);
        }
    };

    const runMusicTask = async (targetId: string, submit = false) => {
        const targetNode = ctx.getNode(targetId);
        const targetTaskId = targetNode?.metadata?.musicTaskId;
        const request = targetNode?.metadata?.musicRequest as ReturnType<typeof buildMusicGenerationRequest> | undefined;
        if (targetNode?.type !== CanvasNodeType.Music || !targetTaskId || targetNode.metadata?.storageKey || targetNode.metadata?.content || targetNode.metadata?.musicContentUnavailable) return;
        const controller = new AbortController();
        controllerRef.current = controller;
        setLocalRunning(true);
        const signal = AbortSignal.any([ctx.scope.signal, controller.signal]);
        let uploaded: UploadedFile | undefined;
        let attached = false;
        try {
            await patchNode(targetId, { status: "loading", errorDetails: undefined, musicError: undefined });
            const recordTask = (task: Awaited<ReturnType<typeof createMusicGenerationTask>>) => {
                void patchNode(targetId, {
                    musicRequest: (request || task.request) as unknown as Record<string, unknown>,
                    musicTaskStatus: task.status,
                    musicTaskStage: task.stage,
                    musicTaskMissing: false,
                    musicSeed: task.seed,
                    musicOutput: (task.output || undefined) as Record<string, unknown> | undefined,
                    ...(task.status === "failed" ? { status: "error", errorDetails: task.error || "音乐生成失败", musicError: task.error || "音乐生成失败" } : {}),
                });
            };
            const task = submit
                ? await createMusicGenerationTask(request!, { signal }).then((created) => {
                      recordTask(created);
                      return created.status === "completed" || created.status === "failed" ? created : waitForMusicGenerationTask(targetTaskId, { signal, onTask: recordTask });
                  })
                : await waitForMusicGenerationTask(targetTaskId, { signal, onTask: recordTask });
            if (task.status === "failed") throw new Error(task.error || "音乐生成失败");
            const output = task.output;
            if (!output || !/^audio\/(?:x-)?(?:wav|wave|flac)$/i.test(output.mime_type)) throw new Error("音乐输出格式无效");
            const blob = await getMusicGenerationContent(targetTaskId, { signal });
            const audioBlob = blob.type === output.mime_type ? blob : new Blob([blob], { type: output.mime_type });
            uploaded = await uploadMediaFile(audioBlob, "audio", signal);
            await patchNode(targetId, {
                ...audioMetadata(uploaded),
                durationMs: output.duration_ms,
                musicOutput: output as unknown as Record<string, unknown>,
                musicSeed: task.seed,
                musicSavePending: false,
                status: "success",
                errorDetails: undefined,
                musicError: undefined,
            });
            attached = true;
        } catch (error) {
            if (!attached && uploaded?.storageKey) await deleteStoredMedia([uploaded.storageKey]).catch(() => {});
            if (!signal.aborted) {
                const detail = error instanceof Error ? error.message : "音乐生成失败";
                const missingTask = error instanceof MusicApiError && error.status === 404;
                const contentUnavailable = error instanceof MusicApiError && error.status === 410;
                const hasContent = Boolean(ctx.getNode(targetId)?.metadata?.storageKey || ctx.getNode(targetId)?.metadata?.content);
                await patchNode(targetId, {
                    status: hasContent ? "success" : "error",
                    errorDetails: detail,
                    musicError: detail,
                    ...(contentUnavailable ? { musicContentUnavailable: true } : {}),
                    ...(missingTask ? { musicTaskMissing: true } : {}),
                });
                toast.error(detail, workbenchMessageOptions.error);
            }
        } finally {
            if (controllerRef.current === controller) controllerRef.current = null;
            setLocalRunning(false);
        }
    };

    const handleGenerate = async () => {
        if (localRunning) return;
        if (pendingTask) {
            await runMusicTask(node.id);
            return;
        }
        try {
            if (mode !== "original" && !hasReferenceInput) {
                toast.warning("请先分析参考音频", workbenchMessageOptions.warning);
                return;
            }
            const request = Object.freeze({
                ...buildMusicGenerationRequest(
                    crypto.randomUUID(),
                    {
                        ...draft,
                        style: mode === "style" && !draft.style.trim() ? referenceStyle : draft.style,
                        cot: mode === "melody" || mode === "full" ? mode : draft.cot,
                        abc: mode === "style" ? "" : draft.abc,
                    },
                    connectedLyrics || inheritedLyrics,
                ),
                ...(mode !== "original" ? { reference: { analysis_id: node.metadata!.musicAnalysisId!, mode, style_override: mode === "style" ? referenceStyle : null } } : {}),
            });
            const metadata: CanvasNodeMetadata = {
                musicAnalysisId: analysis ? node.metadata?.musicAnalysisId : undefined,
                musicAnalysis: analysis as unknown as Record<string, unknown> | undefined,
                musicAnalysisStatus: analysis ? "completed" : undefined,
                musicAnalysisStage: analysis ? "analysis_completed" : undefined,
                musicAnalysisRequest: analysis ? node.metadata?.musicAnalysisRequest : undefined,
                musicAnalysisNodeId: analysis ? selectedReference?.id : undefined,
                musicAnalysisStorageKey: analysis ? node.metadata?.musicAnalysisStorageKey : undefined,
                musicReferenceStyle: analysis ? node.metadata?.musicReferenceStyle : undefined,
                model: MUSIC_MODEL,
                musicDraft: { ...musicDraftFromRequest(request), style: draft.style, ...(outputType === "instrumental" ? { lyrics: draft.lyrics, cot: draft.cot, abc: draft.abc } : {}), creationMode: mode, referenceNodeId: selectedReference?.id } as unknown as Record<string, unknown>,
                musicRequest: request as unknown as Record<string, unknown>,
                musicTaskId: request.id,
                musicTaskEndpoint: MUSIC_ENDPOINT,
                musicTaskStatus: "queued",
                musicTaskStage: "queued",
                musicTaskMissing: false,
                musicSeed: undefined,
                musicOutput: undefined,
                musicScore: undefined,
                musicError: undefined,
                musicSavePending: false,
                musicContentUnavailable: false,
                status: "loading",
                errorDetails: undefined,
            };
            const hasContent = Boolean(node.metadata?.storageKey || node.metadata?.content);
            if (hasContent) {
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Music];
                const target = {
                    ...createCanvasNode(CanvasNodeType.Music, { x: node.position.x + node.width + 96 + spec.width / 2, y: node.position.y + node.height / 2 }, metadata),
                    title: request.style.slice(0, 32),
                };
                const refs = Array.from(new Set([node.id, ...referenceNodes.map((r) => r.id)]));
                await ctx.commands.execute(
                    canvasApply,
                    {
                        ops: [
                            { type: "add_node", node: target },
                            ...refs.map((fromNodeId) => ({ type: "connect_nodes" as const, connection: { id: nanoid(), fromNodeId, toNodeId: target.id } })),
                        ],
                        selection: { nodeIds: [target.id], connectionId: null },
                    },
                    { scope: ctx.scope },
                );
                await runMusicTask(target.id, true);
            } else {
                await patchNode(node.id, metadata, request.style.slice(0, 32));
                await runMusicTask(node.id, true);
            }
        } catch (error) {
            report(error);
        }
    };

    const handleDownloadScore = async (variant: "used" | "source" = "used") => {
        if (!taskId) return;
        try {
            const score = variant === "source" ? await getMusicGenerationScore(taskId, { signal: ctx.scope.signal }, "source") : node.metadata?.musicScore || await getMusicGenerationScore(taskId, { signal: ctx.scope.signal });
            if (!score.trim()) throw new Error("该任务没有可下载的 ABC 乐谱");
            if (variant === "used") await patchNode(node.id, { musicScore: score });
            saveAs(new Blob([score], { type: "text/plain;charset=utf-8" }), `music-${node.id}${variant === "source" ? "-source" : ""}.abc`);
        } catch (error) {
            report(error);
        }
    };

    const handleRearrange = async () => {
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Music];
        const target = {
            ...createCanvasNode(CanvasNodeType.Music, { x: node.position.x + node.width + 96 + spec.width / 2, y: node.position.y + node.height / 2 }, {
                musicDraft: { ...draft, creationMode: "melody", referenceNodeId: node.id, abc: "" } as unknown as Record<string, unknown>,
            }),
            title: `${node.title || "音乐"} · 改写`,
        };
        await ctx.commands.execute(
            canvasApply,
            {
                ops: [
                    { type: "add_node", node: target },
                    { type: "connect_nodes", connection: { id: nanoid(), fromNodeId: node.id, toNodeId: target.id } },
                ],
                selection: { nodeIds: [target.id], connectionId: null },
            },
            { scope: ctx.scope },
        );
    };

    const handleExportText = async (text: string, title: string) => {
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
        const textNode: CanvasNodeData = {
            ...createCanvasNode(CanvasNodeType.Text, { x: node.position.x + node.width + 96 + spec.width / 2, y: node.position.y + node.height / 2 }, { content: text, prompt: text, status: "success", fontSize: 14 }),
            title,
        };
        await ctx.commands.execute(canvasApply, { ops: [{ type: "add_node", node: textNode }] }, { scope: ctx.scope });
        toast.success("已插入文本节点", workbenchMessageOptions.success);
    };

    const textAreaClass = "thin-scrollbar w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none";
    const inputClass = "h-8 w-full rounded-xl border bg-transparent px-2.5 text-sm outline-none";
    const fieldStyle = { borderColor: theme.node.stroke, color: theme.node.text };

    return (
        <div
            data-canvas-no-zoom
            className="rounded-2xl border p-3 text-sm shadow-2xl backdrop-blur"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            <div className={locked ? "pointer-events-none opacity-60" : undefined}>
                <CanvasNodeReferenceBar nodeId={node.id} scope={ctx.scope} nodes={eligibleNodes} connectedNodes={referenceNodes} onDisconnect={onDisconnect} onStartSelection={onStartSelection} />
            </div>

            <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2">
                <CanvasSegments<MusicOutputType>
                    label="音乐类型"
                    compact
                    value={outputType}
                    onChange={(next) => !locked && update({ outputType: next })}
                    options={[{ label: "歌曲", value: "song" }, { label: "纯音乐", value: "instrumental" }]}
                />
            </div>

            <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2">
                <Select value={mode} disabled={locked} onValueChange={(creationMode) => update({ creationMode: creationMode as MusicCreationMode, abc: "" })}>
                    <SelectTrigger className="h-8 w-auto rounded-full px-3 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent data-canvas-no-zoom className="z-[1200]">
                        {CREATION_MODES.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                    </SelectContent>
                </Select>
                {audioReferences.length > 1 ? (
                    <Select value={selectedReference?.id || ""} disabled={locked} onValueChange={(referenceNodeId) => update({ referenceNodeId, abc: "" })}>
                        <SelectTrigger className="h-8 max-w-44 rounded-full px-3 text-xs"><SelectValue placeholder="选择主参考音频" /></SelectTrigger>
                        <SelectContent data-canvas-no-zoom className="z-[1200]">{audioReferences.map((ref) => <SelectItem key={ref.id} value={ref.id}>{ref.title}</SelectItem>)}</SelectContent>
                    </Select>
                ) : mode !== "original" && selectedReference ? (
                    <span className="max-w-44 truncate text-xs" style={{ color: theme.node.muted }}>{selectedReference.title}</span>
                ) : null}
                {mode !== "original" ? (
                    <Button type="button" variant="ghost" size="sm" disabled={locked || !selectedReference} onClick={() => void analyzeReference(false)}>
                        <Settings2 className="size-3.5" />
                        分析参考
                    </Button>
                ) : null}
            </div>

            {mode !== "original" ? <p className="mb-2 text-xs leading-5" style={{ color: theme.node.muted }}>{CREATION_MODES.find((m) => m.value === mode)?.hint}</p> : null}
            {analysis || selectedReference ? (
                <div className="mb-2 flex flex-wrap gap-1.5">
                    {analysis ? <Button type="button" variant="ghost" size="sm" onClick={() => setAnalysisEditor(true)}><FileText className="size-3.5" />查看分析</Button> : null}
                    {outputType !== "instrumental" ? <Button type="button" variant="ghost" size="sm" disabled={locked || !selectedReference} onClick={() => void analyzeReference(true)}>提取歌词</Button> : null}
                </div>
            ) : null}
            {mode !== "original" && !analysis && !analysisPending ? <p className="mb-2 text-xs leading-5" style={{ color: theme.node.muted }}>{selectedReference ? "请先点击「分析参考」提取乐谱或曲风" : "请先连接一条音频或音乐节点作为参考"}</p> : null}
            {analysis || analysisPending ? <div className="mb-2 flex items-center gap-2 text-xs" style={{ color: theme.node.muted }}>{analysisPending && isRunning ? <LoaderCircle className="size-3.5 animate-spin" /> : null}{ANALYSIS_STAGE_LABELS[node.metadata?.musicAnalysisStage || "queued"] || node.metadata?.musicAnalysisStage}</div> : null}

            <div className="space-y-2">
                <div className="text-xs font-medium" style={{ color: theme.node.muted }}>音乐风格</div>
                <textarea
                    value={draft.style}
                    disabled={locked}
                    onChange={(event) => update({ style: event.target.value })}
                    rows={2}
                    className={textAreaClass}
                    style={fieldStyle}
                    placeholder={outputType === "instrumental" ? "例如：warm acoustic guitar and cello, 86 BPM, serene" : "例如：indie folk, warm acoustic guitar, female vocals, 92 BPM"}
                />
                {outputType !== "instrumental" ? (
                    <>
                        <div className="text-xs font-medium" style={{ color: theme.node.muted }}>歌词</div>
                        <textarea
                            value={draft.lyrics}
                            disabled={locked}
                            onChange={(event) => update({ lyrics: event.target.value })}
                            rows={3}
                            className={textAreaClass}
                            style={fieldStyle}
                            placeholder="例如：[Verse]\n夜色落进窗台...\n（留空可连接文本节点或自动参考原曲歌词）"
                        />
                    </>
                ) : null}
            </div>

            {!draft.lyrics.trim() && outputType !== "instrumental" && effectiveLyrics.trim() ? (
                <pre className="thin-scrollbar mt-2 max-h-16 overflow-auto whitespace-pre-wrap break-words text-xs leading-5" style={{ color: theme.node.muted }}>{effectiveLyrics}</pre>
            ) : null}

            <div className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="inline-flex shrink-0 items-center gap-1.5 px-1 text-xs font-medium"><Music4 className="size-3.5" />{MUSIC_MODEL}</span>
                    {outputType !== "instrumental" ? (
                        <Select value={planningMode} disabled={locked || mode === "melody" || mode === "full"} onValueChange={(cot) => update({ cot: cot as MusicPlanningMode })}>
                            <SelectTrigger className="h-8 w-auto rounded-full px-3 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent data-canvas-no-zoom className="z-[1200]">
                                <SelectItem value="full">完整乐谱规划</SelectItem>
                                <SelectItem value="melody">主旋律规划</SelectItem>
                                <SelectItem value="off">跳过乐谱规划</SelectItem>
                            </SelectContent>
                        </Select>
                    ) : null}
                    <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
                        <PopoverTrigger asChild>
                            <Button type="button" variant="ghost" size="sm" className="h-8 rounded-full px-2.5 text-xs"><Settings2 className="size-3.5" />高级</Button>
                        </PopoverTrigger>
                        <PopoverContent data-canvas-no-zoom className="z-[1200] w-80 space-y-3 p-4" side="top" align="start">
                            <div className="grid grid-cols-2 gap-2.5 text-xs">
                                <div className="space-y-1">
                                    <div style={{ color: theme.node.muted }}>随机种子</div>
                                    <input className={inputClass} style={fieldStyle} disabled={locked} value={draft.seed} placeholder="留空随机" onChange={(e) => update({ seed: e.target.value })} />
                                </div>
                                <div className="space-y-1">
                                    <div style={{ color: theme.node.muted }}>格式</div>
                                    <Select value={draft.format} disabled={locked} onValueChange={(format) => update({ format: format as MusicFormat })}>
                                        <SelectTrigger className="h-8 rounded-xl"><SelectValue /></SelectTrigger>
                                        <SelectContent data-canvas-no-zoom className="z-[1300]"><SelectItem value="wav">WAV</SelectItem><SelectItem value="flac">FLAC</SelectItem></SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-1">
                                    <div style={{ color: theme.node.muted }}>步数</div>
                                    <input className={inputClass} style={fieldStyle} disabled={locked} value={draft.steps} onChange={(e) => update({ steps: e.target.value })} />
                                </div>
                                <div className="space-y-1">
                                    <div style={{ color: theme.node.muted }}>CFG</div>
                                    <input className={inputClass} style={fieldStyle} disabled={locked} value={draft.cfgScale} placeholder={planningMode === "off" ? "1.01" : "1"} onChange={(e) => update({ cfgScale: e.target.value })} />
                                </div>
                            </div>
                            {mode !== "style" && (outputType === "instrumental" || planningMode !== "off") ? (
                                <div className="space-y-1 text-xs">
                                    <div style={{ color: theme.node.muted }}>ABC 乐谱（可选）</div>
                                    <textarea value={draft.abc} disabled={locked} onChange={(e) => update({ abc: e.target.value })} rows={4} className={`${textAreaClass} font-mono text-xs`} style={fieldStyle} placeholder="X:1..." />
                                </div>
                            ) : null}
                        </PopoverContent>
                    </Popover>
                    {node.metadata?.musicScore || (node.metadata?.musicOutput as { has_score?: boolean } | undefined)?.has_score ? (
                        <Tooltip><TooltipTrigger asChild>
                            <Button type="button" variant="ghost" size="icon-sm" className="rounded-full" onClick={() => void handleDownloadScore("used")} aria-label="下载 ABC 乐谱"><Download className="size-3.5" /></Button>
                        </TooltipTrigger><TooltipContent>下载 ABC 乐谱</TooltipContent></Tooltip>
                    ) : null}
                </div>
                {isRunning ? (
                    <Button type="button" variant="destructive" className="h-9 rounded-full px-3" onClick={stopCurrent}>
                        <LoaderCircle className="size-3.5 animate-spin" />
                        <Square className="size-3 fill-current" />
                        停止
                    </Button>
                ) : pendingTask || analysisPending ? (
                    <Button type="button" variant="outline" className="h-9 rounded-full px-3" onClick={() => void (analysisPending ? analyzeReference(false, true) : runMusicTask(node.id))}>
                        <RefreshCw className="size-3.5" />
                        继续查询
                    </Button>
                ) : (
                    <Button type="button" className="h-9 min-w-14 rounded-full px-3" disabled={!canGenerate} onClick={() => void handleGenerate()} aria-label="生成音乐">
                        <ArrowUp className="size-4" />
                    </Button>
                )}
            </div>

            {taskId ? (
                <div className="mt-2 space-y-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                    <div className="truncate" title={taskId}>任务：{taskId}</div>
                    {stage ? <div>{knownStage ? STAGE_LABELS[stage] : stage}{node.metadata?.musicSeed !== undefined ? ` · 种子：${node.metadata.musicSeed}` : ""}</div> : null}
                    {node.metadata?.storageKey || node.metadata?.content ? (
                        <Button type="button" variant="ghost" size="sm" onClick={() => void handleRearrange()}>
                            <Music4 className="size-3.5" />
                            基于此曲二创改写
                        </Button>
                    ) : null}
                    {pendingTask && !isRunning && node.metadata?.musicTaskMissing && node.metadata.musicRequest ? (
                        <Button type="button" variant="ghost" size="sm" onClick={() => void runMusicTask(node.id, true)}>
                            <RefreshCw className="size-3.5" />
                            重新提交该任务
                        </Button>
                    ) : null}
                </div>
            ) : null}
            {node.metadata?.musicError ? <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-5 text-red-400">{node.metadata.musicError}</p> : null}

            <CanvasDialog title="参考音频分析结果" open={analysisEditor && Boolean(analysis)} width={720} onClose={() => setAnalysisEditor(false)}>
                <div data-canvas-no-zoom className="space-y-4 pt-2" onWheelCapture={(event) => event.stopPropagation()}>
                    {analysis?.style ? (
                        <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-sm">
                                <span>曲风描述</span>
                                <Button type="button" variant="ghost" size="sm" disabled={!referenceStyle.trim()} onClick={() => void handleExportText(referenceStyle, "曲风描述")}>
                                    <FileText className="size-3.5" />插入文本节点
                                </Button>
                            </div>
                            <textarea value={referenceStyle} disabled={locked} onChange={(e) => void patchNode(node.id, { musicReferenceStyle: e.target.value })} rows={3} className={textAreaClass} style={fieldStyle} />
                        </div>
                    ) : null}
                    {analysis?.abc_full || analysis?.abc_melody ? (
                        <div className="space-y-1.5">
                            <div className="text-sm">ABC 乐谱</div>
                            <textarea className={`${textAreaClass} font-mono text-xs`} style={fieldStyle} value={draft.abc || (mode === "melody" ? analysis.abc_melody : analysis.abc_full) || ""} disabled={locked || mode === "style"} onChange={(e) => update({ abc: e.target.value })} rows={8} />
                        </div>
                    ) : null}
                    {outputType !== "instrumental" && (analysis?.lyrics || analysis?.source_lyrics) ? (
                        <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-sm">
                                <span>歌词</span>
                                <Button type="button" variant="ghost" size="sm" onClick={() => void handleExportText(draft.lyrics || analysis.lyrics || analysis.source_lyrics || "", "参考歌词")}>
                                    <FileText className="size-3.5" />插入文本节点
                                </Button>
                            </div>
                            <textarea value={draft.lyrics || analysis.lyrics || analysis.source_lyrics || ""} disabled={locked} onChange={(e) => update({ lyrics: e.target.value })} rows={5} className={textAreaClass} style={fieldStyle} />
                        </div>
                    ) : null}
                </div>
            </CanvasDialog>
        </div>
    );
}
