import { computeMediaSize, inferMediaScale } from "@workbench/lib/media-size";
import { commitHostTransaction } from "@workbench/lib/canvas/host-transaction";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { toast } from "sonner";
import { workbenchMessageOptions } from "@workbench/components/ui/sonner";
import { nanoid } from "nanoid";
import type { CommandContext, PluginCommand } from "@infinite-canvas/plugin-sdk";
import { bindHostActions } from "@workbench/lib/canvas/host-actions";
import { commands, nodeGenerate, nodeRetry, nodeStop, nodeOpenPanel, nodeSetTextContent } from "@infinite-canvas/plugin-sdk/builtin";
import { PluginError, getPluginErrorMessage } from "@infinite-canvas/shared/plugins";
import { ModelExecutionError } from "@infinite-canvas/shared/model-http";
import { CanvasNodeType, isCanvasTaskBinding, isWebVideoTaskOwner, type CanvasNodeData, type CanvasNodeMetadata, type CanvasNodeImage, type CanvasNodeText, type CanvasWebVideoTask } from "@infinite-canvas/shared/canvas/schema/canvas";
import { NODE_DEFAULT_SIZE } from "@infinite-canvas/shared/canvas/schema/node-specs";
import type { CanvasDocumentOp } from "@infinite-canvas/shared/canvas/ops/apply";
import type { CanvasSession } from "@workbench/lib/canvas/canvas-session";
import { prepareImage } from "@workbench/lib/canvas/canvas-session-media";
import { builtinPlugin } from "@workbench/lib/plugins/registry";
import { emitPluginEvent } from "@workbench/lib/plugins/runtime";
import { getNodeDefinition, getNodeSpec, readNodeResource } from "@workbench/lib/canvas/node-registry";
import { registerCanvasNodeAsset } from "@workbench/lib/canvas/register-canvas-asset";
import { useCanvasTasks } from "../use-canvas-tasks";
import { models } from "@workbench/services/api/models/runtime";
import { requestEdit, requestGeneration, requestImageQuestion } from "@workbench/services/api/image";
import { waitForQwenImageTasks } from "@workbench/services/api/comfyui-qwen";
import { promoteDreamMakerDraft, waitForDreamMakerImageTask } from "@workbench/services/api/dreammaker";
import { FireRedApiError } from "@workbench/services/api/firered";
import { requestAudioGeneration } from "@workbench/services/api/audio";
import { createVideoGenerationTask, isVideoTaskFailed, resolveGeneratedVideo, videoChannelFingerprint, waitForVideoGenerationTask } from "@workbench/services/api/video";
import { isMiniMaxH3, isQwenImage21 } from "@workbench/constant/comfyui";
import { isDreamMakerArk, isDreamMakerImage, isDreamMakerMj, isDreamMakerVideo } from "@workbench/constant/dreammaker";
import { FIRERED_SPEECH_OPTION, isFireRedSpeech, isFireRedUnderstand } from "@workbench/constant/firered";
import { fireRedSpeechMetadata, fireRedSpeechSettings, resumeFireRedAudio, resumeFireRedTextResult, runFireRedAcousticEditTask, runFireRedSpeechTask, runFireRedUnderstandTask } from "@workbench/lib/canvas/fire-red-generation";
import type { UploadedFile } from "@workbench/services/file-storage";
import { isBuiltinCloudModel, useConfigStore, useEffectiveConfig, type AiConfig } from "@workbench/stores/use-config-store";
import { useAssetStore } from "@workbench/stores/use-asset-store";
import { getDataUrlByteSize } from "@workbench/lib/image-utils";
import { fitNodeSize } from "@workbench/lib/canvas/canvas-node-size";
import { audioMetadata, buildAudioGenerationMetadata, buildImageGenerationMetadata, createCanvasNode, imageMetadata, videoMetadata } from "@workbench/lib/canvas/canvas-node-factory";
import { buildGenerationConfig, generationReferences, getGenerationCount, hasResumableCloudVideoTask, hasResumableImageTask, hasResumableVideoTask, isGenerationCanceled, resetWebVideoSubmission, resolveMetadataReferences, sourceNodeReferenceImages } from "@workbench/lib/canvas/canvas-generation-helpers";
import { buildNodeGenerationContext, buildNodeResponseMessages } from "@workbench/components/canvas/canvas-node-generation";
import type { CanvasNodeGenerationMode } from "@workbench/components/canvas/canvas-node-prompt-panel";
import type { ReferenceVideo, ReferenceAudio } from "@workbench/types/media";
import { resolveNodeRetryTarget, setTextNodeContent, startNodeGenerationRequest, stopNodeGenerationRequests, type CanvasGenerationRequest } from "@workbench/lib/canvas/node-generation-state";
import { confirmNodeStop, type NodeStopConfirmation } from "@workbench/lib/canvas/confirm-node-stop";
import { readWebVideoTaskResult, sameWebVideoTask, saveWebVideoTask } from "./web-video-task";
import { createImageEditCommands, type ApplyCanvasImageResult } from "./image-edit-generation";
import type { OpenNodePanel } from "./use-plugin-host";

const VIDEO_NODE_MAX_WIDTH = 420;
const VIDEO_NODE_MAX_HEIGHT = 420;
const NODE_STATUS_IDLE = "idle" as const;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;

function generationErrorMessage(error: unknown) {
    console.error("[canvas] node generation", error);
    return error instanceof ModelExecutionError ? error.message : getPluginErrorMessage(error);
}

function applyGeneratedVideo(item: CanvasNodeData, video: UploadedFile, extra: CanvasNodeData["metadata"] = {}): CanvasNodeData {
    const videoSize = fitNodeSize(video.width || item.width, video.height || item.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
    return {
        ...item,
        width: videoSize.width,
        height: videoSize.height,
        position: { x: item.position.x + item.width / 2 - videoSize.width / 2, y: item.position.y + item.height / 2 - videoSize.height / 2 },
        metadata: { ...item.metadata, ...videoMetadata(video), webVideoSubmissionId: undefined, webVideoTask: undefined, ...extra },
    };
}

type NodeGenerationOptions = {
    setDialogNodeId: Dispatch<SetStateAction<string | null>>;
    capturePanel: (nodeId: string) => OpenNodePanel | null;
    setReferencePickerNodeId: Dispatch<SetStateAction<string | null>>;
    setExpandedBatchNodeIds: Dispatch<SetStateAction<Set<string>>>;
};

export function useNodeGeneration(session: CanvasSession, { setDialogNodeId, capturePanel, setReferencePickerNodeId, setExpandedBatchNodeIds }: NodeGenerationOptions) {
    const [stopConfirmations, setStopConfirmations] = useState<(NodeStopConfirmation & { id: string; pending: boolean })[]>([]);
    const presentStop = useCallback((choice: NodeStopConfirmation) => {
        const id = nanoid();
        setStopConfirmations(current => [...current, {
            ...choice, id, pending: false,
            accept: () => {
                setStopConfirmations(items => items.map(item => item.id === id ? { ...item, pending: true } : item));
                return choice.accept();
            },
        }]);
        return () => setStopConfirmations(current => current.filter(item => item.id !== id));
    }, []);
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const projectId = session.projectId;
    const nodesRef = useMemo(() => ({ get current() { return session.getSnapshot().nodes; } }), [session]);
    const connectionsRef = useMemo(() => ({ get current() { return session.getSnapshot().connections; } }), [session]);
    const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
    const [acousticEditNodeId, setAcousticEditNodeId] = useState<string | null>(null);
    const [acousticValues, setAcousticValues] = useState({ speed: 1, pitch: 0, volume: 1 });
    const [acousticRunning, setAcousticRunning] = useState(false);
    const setGenerationNodes = useCallback((value: SetStateAction<CanvasNodeData[]>) => {
        session.updateDocument((document) => ({ ...document, nodes: typeof value === "function" ? value(document.nodes) : value }), { source: { kind: "system", id: "generation" }, history: false });
    }, [session]);
    const generationRequestsRef = useRef(new Map<string, CanvasGenerationRequest>());
    const cancelTask = useCallback((signal: AbortSignal) => {
        for (const request of generationRequestsRef.current.values()) if (request.controller.signal === signal) request.controller.abort();
    }, []);
    const task = useCanvasTasks(session, cancelTask);
    const applyResult = useCallback((nodeId: string, kind: "image" | "video" | "text" | "audio", signal: AbortSignal, update: (nodes: CanvasNodeData[]) => CanvasNodeData[], taskId?: string) => {
        signal.throwIfAborted();
        if (models.tasks && taskId && !task.canApply(taskId, nodeId, signal)) throw new ModelExecutionError("MODEL_TASK_CANCELLED");
        const document = session.getSnapshot();
        const target = document.nodes.find((node) => node.id === nodeId);
        if (!target) return false;
        const nodes = update(document.nodes);
        if (nodes.find((node) => node.id === nodeId) === target) return false;
        session.updateDocument(() => ({ nodes, connections: document.connections }), { source: { kind: "system", id: "generation" }, history: false });
        if (models.tasks && taskId) task.applied(taskId, signal);
        emitPluginEvent("result.applied", { projectId: session.projectId, kind, nodeIds: [nodeId], ...(taskId ? { taskId } : {}) });
        const applied = nodes.find((node) => node.id === nodeId);
        if (applied) registerCanvasNodeAsset(applied, "生成");
        return true;
    }, [session, task.canApply, task.applied]);

    const applyImageResult = useCallback<ApplyCanvasImageResult>(async ({ nodeId, signal, taskId }, url, update, onAccepted) => {
        if (taskId && !task.canApply(taskId, nodeId, signal)) throw new ModelExecutionError("MODEL_TASK_CONFLICT");
        const image = await prepareImage(url, signal);
        signal.throwIfAborted();
        const revision = session.getSnapshot().revision;
        try {
            const applied = applyResult(nodeId, "image", signal, (nodes) => update(nodes, image), taskId);
            if (!applied && taskId) task.applied(taskId, signal);
            return applied;
        } finally {
            // 结果已入图后，发布通知抛错也算受理。
            if (session.getSnapshot().revision !== revision) onAccepted();
        }
    }, [applyResult, session, task.applied, task.canApply]);

    useEffect(() => () => {
        generationRequestsRef.current.forEach(({ controller, release }) => { release(); controller.abort(); });
        generationRequestsRef.current.clear();
    }, [projectId]);
    useEffect(() => session.subscribe(() => {
        const nodes = new Map(session.getSnapshot().nodes.map((node) => [node.id, node]));
        for (const request of generationRequestsRef.current.values()) {
            const node = nodes.get(request.targetNodeId);
            const target = request.mediaTarget;
            if (!node || target && (node.type !== target.type || target.originType !== undefined && nodes.get(request.originNodeId)?.type !== target.originType || target.slotId !== undefined && !node.metadata?.images?.some((image) => image.id === target.slotId)) ||
                request.webVideoSubmissionId && !request.webVideoTask && (node.type !== CanvasNodeType.Video || node.metadata?.webVideoSubmissionId !== request.webVideoSubmissionId)) request.controller.abort(new PluginError("PLUGIN_INACTIVE"));
        }
    }), [session]);
    useEffect(() => session.on("document.committed", (event) => {
        if (event.operation === "transact" && !event.removedNodeIds?.length) return;
        for (const request of generationRequestsRef.current.values()) {
            if (event.operation === "undo" || event.operation === "redo") request.controller.abort();
            else if (request.mediaTarget && request.mediaTarget.revision < event.revision && event.removedNodeIds?.some((id) => id === request.targetNodeId || id === request.originNodeId)) {
                request.controller.abort(new PluginError("PLUGIN_INACTIVE"));
            }
        }
    }), [session]);


    const startGenerationRequest = useMemo(() => startNodeGenerationRequest.bind(null, generationRequestsRef.current, session.signal), [session]);

    const finishGenerationRequest = useCallback((targetNodeId: string, controller: AbortController) => {
        task.finish(targetNodeId, controller.signal);
        const request = generationRequestsRef.current.get(targetNodeId);
        if (request?.controller !== controller || controller.signal.reason?.message === "task-stop") return false;
        request.release();
        generationRequestsRef.current.delete(targetNodeId);
        return true;
    }, []);

    const releaseWebSubmission = useCallback((nodeId: string, submissionId: string) => {
        if (session.signal.aborted || session.getSnapshot().nodes.find((node) => node.id === nodeId)?.metadata?.webVideoSubmissionId !== submissionId) return;
        const request = generationRequestsRef.current.get(nodeId);
        if (request?.webVideoSubmissionId === submissionId) request.webVideoSubmissionId = undefined;
        setGenerationNodes((nodes) => nodes.map((node) => node.id === nodeId ? resetWebVideoSubmission(node) : node));
    }, [session, setGenerationNodes]);

    const mediaReceipt = useCallback((nodeId: string, signal: AbortSignal, taskId: string | undefined, onAccepted: () => void) => {
        if (taskId && !task.canApply(taskId, nodeId, signal)) throw new ModelExecutionError("MODEL_TASK_CONFLICT");
        return { onAccepted: () => {
            // 图已受理，发布通知抛错也能确认当前任务的结果。
            if (taskId) task.applied(taskId, signal);
            onAccepted();
        } };
    }, [task.canApply, task.applied]);

    const observeWebVideo = useCallback(async (request: CanvasGenerationRequest, binding: CanvasWebVideoTask, options?: { previous?: CanvasWebVideoTask; originalFingerprint?: string; onAccepted?: () => void }) => {
        const { signal } = request.controller;
        request.webVideoTask = binding;
        let accepted = false;
        try {
            await readWebVideoTaskResult(session, binding, () => useConfigStore.getState().config, signal, (video) => applyResult(binding.nodeId, "video", signal, (nodes) =>
                nodes.map((node) => isWebVideoTaskOwner(projectId, node, binding) && sameWebVideoTask(node.metadata?.webVideoTask, binding) ? applyGeneratedVideo(node, video) : node),
                binding.id,
            ), { expected: options?.previous ?? null, originalFingerprint: options?.originalFingerprint, onAccepted: () => { accepted = true; options?.onAccepted?.(); } });
        } catch (error) {
            if (accepted) throw error;
            signal.throwIfAborted();
            session.signal.throwIfAborted();
            const current = session.getSnapshot().nodes.find((node) => node.id === binding.nodeId);
            if (!current || !isWebVideoTaskOwner(projectId, current, binding) || !sameWebVideoTask(current.metadata?.webVideoTask, binding) || generationRequestsRef.current.get(binding.nodeId) !== request) throw new PluginError("PLUGIN_INACTIVE", { cause: error });
            const failed = isVideoTaskFailed(error);
            const errorDetails = generationErrorMessage(failed ? new ModelExecutionError("MODEL_TASK_FAILED") : error);
            setGenerationNodes((nodes) => nodes.map((node) => node.id === binding.nodeId
                ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails, webVideoTask: failed ? undefined : binding } } : node));
            throw error;
        }
    }, [projectId, session, applyResult, setGenerationNodes]);

    const attachImageSlotTask = useCallback((nodeId: string, slotIds: string[], taskIds: string[]) => {
        const taskId = taskIds[0];
        if (!taskId) return;
        const targets = new Set(slotIds);
        setGenerationNodes((prev) =>
            prev.map((node) =>
                node.id === nodeId
                    ? { ...node, metadata: { ...node.metadata, images: node.metadata?.images?.map((image) => (targets.has(image.id) ? { ...image, taskId } : image)) } }
                    : node,
            ),
        );
    }, [setGenerationNodes]);

    const applyImageSlotSuccess = useCallback(async (rootId: string, imageId: string, dataUrl: string, signal: AbortSignal, taskId: string | undefined, onAccepted: () => void) => {
        const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
        const applied = await applyImageResult({ nodeId: rootId, signal, taskId }, dataUrl, (prev, uploaded) => {
            const imageSize = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
            const item: CanvasNodeImage = { id: imageId, status: NODE_STATUS_SUCCESS, content: uploaded.url ?? "", storageKey: uploaded.storageKey, naturalWidth: uploaded.width, naturalHeight: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType };
            return prev.map((node) => {
                if (node.id !== rootId || !node.metadata?.images?.some((image) => image.id === imageId)) return node;
                const images = node.metadata?.images?.map((image) => (image.id === imageId ? item : image)) || [];
                if (node.metadata?.primaryImageId) return { ...node, metadata: { ...node.metadata, images } };
                const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
                return {
                    ...node,
                    position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                    ...imageSize,
                    metadata: {
                        ...node.metadata,
                        content: item.content,
                        storageKey: item.storageKey,
                        naturalWidth: item.naturalWidth,
                        naturalHeight: item.naturalHeight,
                        bytes: item.bytes,
                        mimeType: item.mimeType,
                        images,
                        primaryImageId: imageId,
                    },
                };
            });
        }, onAccepted);
        if (!applied) throw new PluginError("PLUGIN_INACTIVE");
    }, [applyImageResult]);

    const completeAudioNodeTask = useCallback(async (nodeId: string, sourceId: string, config: AiConfig, prompt: string, signal: AbortSignal, onAccepted: () => void, referenceAudios: ReferenceAudio[] = []) => {
        const request = generationRequestsRef.current.get(nodeId);
        if (!request || request.controller.signal !== signal) throw new PluginError("PLUGIN_INACTIVE");
        const targetNode = session.getSnapshot().nodes.find((node) => node.id === nodeId);
        if (targetNode?.type !== CanvasNodeType.Audio) throw new PluginError("PLUGIN_INACTIVE");
        request.mediaTarget = { type: CanvasNodeType.Audio, revision: session.getSnapshot().revision };
        if (isFireRedSpeech(config.model)) {
            const sourceMeta = session.getSnapshot().nodes.find((node) => node.id === sourceId)?.metadata || targetNode.metadata || {};
            const settings = fireRedSpeechSettings(sourceMeta);
            const fireRed = await runFireRedSpeechTask(prompt, settings, referenceAudios, {
                signal,
                onTaskId: (fireRedTaskId) => setGenerationNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, fireRedTaskId } } : node))),
            });
            await session.commitMediaResult({ input: fireRed.blob }, signal, (audio) => applyResult(nodeId, "audio", signal, (nodes) =>
                nodes.map((node) => node.id === nodeId && node.type === CanvasNodeType.Audio
                    ? { ...node, metadata: { ...node.metadata, ...audioMetadata(audio), prompt, ...fireRedSpeechMetadata(settings, config.model) } } : node)),
                mediaReceipt(nodeId, signal, undefined, onAccepted));
            return;
        }
        const options = task.options(nodeId, sourceId, signal);
        const result = await requestAudioGeneration(config, prompt, options);
        await session.commitMediaResult({ input: result }, signal, (audio) => applyResult(nodeId, "audio", signal, (nodes) =>
            nodes.map((node) => node.id === nodeId && node.type === CanvasNodeType.Audio
                ? { ...node, metadata: { ...node.metadata, ...audioMetadata(audio), prompt, ...buildAudioGenerationMetadata(config) } } : node), options.taskId),
            mediaReceipt(nodeId, signal, options.taskId, onAccepted));
    }, [session, task.options, applyResult, mediaReceipt, setGenerationNodes]);

    const completeVideoNodeTask = useCallback(
        async (nodeId: string, submissionId: string | undefined, config: AiConfig, prompt: string, images: Parameters<typeof createVideoGenerationTask>[2], signal: AbortSignal, onAccepted: () => void, extra: CanvasNodeData["metadata"] = {}, videos: ReferenceVideo[] = [], audios: ReferenceAudio[] = []) => {
            const request = generationRequestsRef.current.get(nodeId);
            if (!request || request.controller.signal !== signal) throw new PluginError("PLUGIN_INACTIVE");
            signal.throwIfAborted();
            request.mediaTarget = { type: CanvasNodeType.Video, revision: session.getSnapshot().revision };
            if (submissionId) {
                const node = session.getSnapshot().nodes.find((item) => item.id === nodeId);
                if (node?.type !== CanvasNodeType.Video || node.metadata?.webVideoSubmissionId !== submissionId) throw new PluginError("PLUGIN_INACTIVE");
                request.webVideoSubmissionId = submissionId;
            }
            const isCloudVideo = isBuiltinCloudModel(config.model || config.videoModel);
            const options = isCloudVideo ? { signal } : task.options(nodeId, request.originNodeId, signal);
            const originalFingerprint = submissionId ? await videoChannelFingerprint(config, config.model || config.videoModel, submissionId) : undefined;
            signal.throwIfAborted();
            const videoTask = await createVideoGenerationTask(config, prompt, images, { ...options, videos, audios });
            signal.throwIfAborted();
            if (generationRequestsRef.current.get(nodeId) !== request) throw new PluginError("PLUGIN_INACTIVE");
            if (videoTask.result) {
                await session.commitMediaResult(await resolveGeneratedVideo(videoTask.result, signal), signal, (video) => {
                    request.webVideoSubmissionId = undefined;
                    return applyResult(nodeId, "video", signal, (nodes) => nodes.map((node) =>
                        node.id === nodeId && node.type === CanvasNodeType.Video && node.metadata?.webVideoSubmissionId === submissionId && !node.metadata?.webVideoTask ? applyGeneratedVideo(node, video) : node), isCloudVideo ? undefined : options.taskId);
                }, mediaReceipt(nodeId, signal, isCloudVideo ? undefined : options.taskId, onAccepted));
                return;
            }
            if (videoTask.provider === "comfyui" || videoTask.provider === "dreammaker") {
                setGenerationNodes((prev) => prev.map((item) => (item.id === nodeId ? { ...item, metadata: { ...item.metadata, videoTaskId: videoTask.id, videoTaskProvider: videoTask.provider, videoTaskSubApp: videoTask.subApp, model: config.model } } : item)));
                const result = await waitForVideoGenerationTask(config, videoTask, { signal });
                await session.commitMediaResult(await resolveGeneratedVideo(result, signal), signal, (video) => applyResult(nodeId, "video", signal, (nodes) => nodes.map((item) =>
                    item.id === nodeId && item.type === CanvasNodeType.Video ? applyGeneratedVideo(item, video, { prompt, model: config.model, dmDraftTaskId: result.upstreamTaskId, ...extra }) : item)),
                    mediaReceipt(nodeId, signal, undefined, onAccepted));
                return;
            }
            if (submissionId) {
                const binding: CanvasWebVideoTask = { projectId, nodeId, sourceId: request.originNodeId, runId: submissionId, id: videoTask.id, model: videoTask.model, scriptId: videoTask.scriptId, script: videoTask.script, paused: false };
                await observeWebVideo(request, binding, { originalFingerprint, onAccepted });
                return;
            }
            if (!("taskId" in options) || videoTask.id !== options.taskId) throw new ModelExecutionError("MODEL_TASK_CONFLICT");
            const result = await waitForVideoGenerationTask(config, videoTask, options);
            await session.commitMediaResult(await resolveGeneratedVideo(result, signal), signal, (video) => applyResult(nodeId, "video", signal, (nodes) => nodes.map((item) =>
                item.id === nodeId && item.type === CanvasNodeType.Video ? applyGeneratedVideo(item, video, { prompt, model: config.model, ...extra }) : item), videoTask.id), mediaReceipt(nodeId, signal, options.taskId, onAccepted));
        },
        [projectId, session, observeWebVideo, applyResult, mediaReceipt, setGenerationNodes, task.options],
    );

    const pollCloudVideoNodeTask = useCallback(
        async (node: CanvasNodeData, automatic = false, parentSignal?: AbortSignal) => {
            const taskId = node.metadata?.videoTaskId;
            const provider = node.metadata?.videoTaskProvider;
            if (!taskId || (provider !== "comfyui" && provider !== "dreammaker")) return;
            const active = generationRequestsRef.current.get(node.id);
            if (active && !active.controller.signal.aborted) return;
            const generationConfig = buildGenerationConfig(effectiveConfig, node, "video");
            const controller = startGenerationRequest(node.id, node.id, node.id, new AbortController(), parentSignal);
            setRunningNodeId(node.id);
            setGenerationNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : item)));
            try {
                const result = await waitForVideoGenerationTask(
                    generationConfig,
                    { id: taskId, model: generationConfig.model, scriptId: "", script: "", provider, subApp: node.metadata?.videoTaskSubApp },
                    { signal: controller.signal },
                );
                await session.commitMediaResult(await resolveGeneratedVideo(result, controller.signal), controller.signal, (video) => applyResult(node.id, "video", controller.signal, (nodes) => nodes.map((item) =>
                    item.id === node.id ? applyGeneratedVideo(item, video, { prompt: item.metadata?.prompt, model: generationConfig.model, dmDraftTaskId: result.upstreamTaskId }) : item)),
                    mediaReceipt(node.id, controller.signal, undefined, () => undefined));
            } catch (error) {
                if (!controller.signal.aborted && !session.signal.aborted && !isGenerationCanceled(error)) {
                    const errorDetails = generationErrorMessage(error);
                    setGenerationNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, ...(isVideoTaskFailed(error) ? { videoTaskId: undefined } : {}) } } : item)));
                    if (!automatic) throw error;
                }
            } finally {
                if (finishGenerationRequest(node.id, controller)) setRunningNodeId((current) => current === node.id ? null : current);
            }
        },
        [applyResult, effectiveConfig, finishGenerationRequest, mediaReceipt, session, setGenerationNodes, startGenerationRequest],
    );

    const pollCloudImageNodeTask = useCallback(
        async (node: CanvasNodeData) => {
            const slots = (node.metadata?.images || []).filter((slot) => slot.status === NODE_STATUS_LOADING && slot.taskId);
            if (!slots.length) return;
            const active = generationRequestsRef.current.get(node.id);
            if (active && !active.controller.signal.aborted) return;
            const controller = startGenerationRequest(node.id, node.id, node.id);
            setRunningNodeId(node.id);
            const isDreamMaker = isDreamMakerImage(node.metadata?.model || "");
            const dreamMakerCache = new Map<string, Promise<Array<{ id: string; dataUrl: string }>>>();
            let hasSuccess = false;
            try {
                await Promise.all(
                    slots.map(async (slot) => {
                        try {
                            let image: { id: string; dataUrl: string };
                            if (isDreamMaker) {
                                const key = slot.taskId!;
                                let pending = dreamMakerCache.get(key);
                                if (!pending) {
                                    pending = waitForDreamMakerImageTask(key, controller.signal, node.metadata?.model);
                                    dreamMakerCache.set(key, pending);
                                }
                                const items = await pending;
                                const siblingIdx = Math.max(0, slots.filter((s) => s.taskId === key).indexOf(slot));
                                image = items[siblingIdx] || items[0];
                            } else {
                                [image] = await waitForQwenImageTasks([slot.taskId!], controller.signal);
                            }
                            await applyImageSlotSuccess(node.id, slot.id, image.dataUrl, controller.signal, undefined, () => { hasSuccess = true; });
                        } catch (error) {
                            if (controller.signal.aborted || isGenerationCanceled(error)) return;
                            const errorDetails = generationErrorMessage(error);
                            setGenerationNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, images: item.metadata?.images?.map((img) => (img.id === slot.id ? { ...img, status: NODE_STATUS_ERROR, errorDetails } : img)) } } : item)));
                        }
                    }),
                );
                if (!controller.signal.aborted && !session.signal.aborted) {
                    setGenerationNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: hasSuccess || item.metadata?.storageKey || item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR } } : item)));
                }
            } finally {
                if (finishGenerationRequest(node.id, controller)) setRunningNodeId((current) => current === node.id ? null : current);
            }
        },
        [applyImageSlotSuccess, finishGenerationRequest, session.signal, setGenerationNodes, startGenerationRequest],
    );

    const promoteVideoDraftNode = useCallback(
        async (node: CanvasNodeData, targetResolution: "1080p" | "4k") => {
            const draftTaskId = node.metadata?.dmDraftTaskId;
            if (!draftTaskId) return;
            const childId = nanoid();
            const generationConfig = buildGenerationConfig(effectiveConfig, node, "video");
            const vquality = targetResolution === "4k" ? "2160" : "1080";
            const childNode: CanvasNodeData = {
                id: childId,
                type: CanvasNodeType.Video,
                title: `${node.title || "Seedance"} · ${targetResolution.toUpperCase()}`,
                position: { x: node.position.x + node.width + 96, y: node.position.y },
                width: node.width,
                height: node.height,
                metadata: {
                    prompt: node.metadata?.prompt,
                    status: NODE_STATUS_LOADING,
                    model: generationConfig.model,
                    size: node.metadata?.size,
                    seconds: node.metadata?.seconds,
                    vquality,
                    generateAudio: node.metadata?.generateAudio,
                    watermark: node.metadata?.watermark,
                    videoMode: node.metadata?.videoMode,
                },
            };
            session.transact([
                { type: "add_node", node: childNode },
                { type: "connect_nodes", connection: { id: nanoid(), fromNodeId: node.id, toNodeId: childId } },
            ], { selection: { nodeIds: [childId], connectionId: null }, source: { kind: "ui" } });
            setDialogNodeId(null);
            setRunningNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const promoted = await promoteDreamMakerDraft(draftTaskId, targetResolution, controller.signal);
                setGenerationNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, videoTaskId: promoted.id, videoTaskProvider: "dreammaker", videoTaskSubApp: promoted.subApp } } : item)));
                const videoResult = await waitForVideoGenerationTask(
                    generationConfig,
                    { id: promoted.id, model: generationConfig.model, scriptId: "", script: "", provider: "dreammaker", subApp: promoted.subApp },
                    { signal: controller.signal },
                );
                await session.commitMediaResult(await resolveGeneratedVideo(videoResult, controller.signal), controller.signal, (video) => applyResult(childId, "video", controller.signal, (nodes) => nodes.map((item) =>
                    item.id === childId ? applyGeneratedVideo(item, video, { prompt: node.metadata?.prompt, model: generationConfig.model, vquality }) : item)),
                    mediaReceipt(childId, controller.signal, undefined, () => undefined));
            } catch (error) {
                if (!controller.signal.aborted && !isGenerationCanceled(error)) {
                    const errorDetails = generationErrorMessage(error);
                    toast.error(errorDetails, workbenchMessageOptions.error);
                    setGenerationNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails, ...(isVideoTaskFailed(error) ? { videoTaskId: undefined } : {}) } } : item)));
                }
            } finally {
                if (finishGenerationRequest(childId, controller)) setRunningNodeId((current) => current === childId ? null : current);
            }
        },
        [applyResult, effectiveConfig, finishGenerationRequest, mediaReceipt, session, setDialogNodeId, setGenerationNodes, startGenerationRequest],
    );

    const pollVideoNodeTask = useCallback(
        async (node: CanvasNodeData, automatic = false, parentSignal?: AbortSignal) => {
            const saved = node.metadata?.webVideoTask;
            if (!saved || !isWebVideoTaskOwner(projectId, node, saved)) throw new ModelExecutionError("MODEL_TASK_CONFLICT");
            if (models.tasks) throw new ModelExecutionError("MODEL_CONFIG_MISSING");
            if (automatic && saved.paused) return;
            const active = generationRequestsRef.current.get(node.id);
            if (active && !active.controller.signal.aborted) throw new PluginError("PLUGIN_INACTIVE");
            const controller = startGenerationRequest(node.id, saved.sourceId, node.id, new AbortController(), parentSignal);
            const request = generationRequestsRef.current.get(node.id)!;
            setRunningNodeId(node.id);
            try {
                await observeWebVideo(request, saved.paused ? { ...saved, paused: false } : saved, { previous: saved });
            } catch (error) {
                if (!automatic && !controller.signal.aborted && !session.signal.aborted && error instanceof ModelExecutionError && error.code === "MODEL_CONFIG_MISSING") openConfigDialog(true, "builtin:channels", saved.model);
                throw error;
            } finally {
                if (finishGenerationRequest(node.id, controller)) setRunningNodeId((current) => current === node.id ? null : current);
            }
        },
        [projectId, session, finishGenerationRequest, openConfigDialog, startGenerationRequest, observeWebVideo],
    );

    const stopGenerationByRunningId = useCallback(async (runningId: string, original?: ReadonlySet<AbortController>) => {
        let historyChanged = false;
        const unsubscribe = session.on("document.committed", ({ operation }) => { if (operation === "undo" || operation === "redo") historyChanged = true; });
        const stop = async (nodeId: string, signal: AbortSignal) => {
            const request = generationRequestsRef.current.get(nodeId);
            const binding = request?.webVideoTask;
            if (!binding) {
                if (!request?.webVideoSubmissionId || request.controller.signal !== signal) return task.stop(nodeId, signal);
                const submissionId = request.webVideoSubmissionId;
                releaseWebSubmission(nodeId, submissionId);
                await session.flush();
                return false;
            }
            if (request.controller.signal !== signal) return false;
            await saveWebVideoTask(session, { ...binding, paused: true }, session.signal, binding);
            return true;
        };
        try {
            await stopNodeGenerationRequests(runningId, generationRequestsRef.current, stop, (ids, finished) => {
                if (session.signal.aborted) return;
                setRunningNodeId((current) => current !== null && finished.has(current) ? null : current);
                if (!ids.size || historyChanged) return;
                setGenerationNodes((prev) => prev.map((node) => {
                    if (!ids.has(node.id) || node.metadata?.tasks?.length || node.metadata?.status !== NODE_STATUS_LOADING) return node;
                    return { ...node, metadata: {
                        ...node.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined,
                        images: node.metadata.images?.map((image) => image.status === NODE_STATUS_LOADING ? { ...image, status: NODE_STATUS_ERROR, errorDetails: "请求已取消" } : image),
                        texts: node.metadata.texts?.map((text) => text.status === NODE_STATUS_LOADING ? { ...text, status: NODE_STATUS_ERROR, errorDetails: "请求已取消" } : text),
                    } };
                }));
            }, original);
        } finally {
            unsubscribe();
        }
    }, [session, setGenerationNodes, releaseWebSubmission, task.stop]);


    useEffect(() => {
        const recoverCloud = () => {
            for (const node of session.getSnapshot().nodes) {
                if (hasResumableCloudVideoTask(node)) void pollCloudVideoNodeTask(node, true);
                if (hasResumableImageTask(node)) void pollCloudImageNodeTask(node);
            }
        };
        recoverCloud();
        if (models.tasks) {
            for (const node of nodesRef.current) {
                const bindings = node.metadata?.tasks?.filter((binding) => isCanvasTaskBinding(projectId, node, binding));
                if (!bindings?.length) continue;
                const controller = startGenerationRequest(node.id, bindings[0].sourceId);
                void task.restore({ ...node, metadata: { ...node.metadata, tasks: bindings } }, controller).catch((error) => {
                    if (!controller.signal.aborted) toast.error(generationErrorMessage(error), workbenchMessageOptions.error);
                }).finally(() => finishGenerationRequest(node.id, controller));
            }
            return;
        }
        const recover = () => {
            for (const node of session.getSnapshot().nodes) {
                if (!hasResumableVideoTask(projectId, node, false)) continue;
                const active = generationRequestsRef.current.get(node.id);
                if (active && !active.controller.signal.aborted) continue;
                void handlers.current.pollVideoNodeTask(node, true).catch((error) => {
                    if (!session.signal.aborted && !isGenerationCanceled(error)) toast.error(generationErrorMessage(error), workbenchMessageOptions.error);
                });
            }
        };
        recover();
        return session.on("document.committed", ({ operation }) => {
            if (operation !== "undo" && operation !== "redo") return;
            if (session.getSnapshot().nodes.some((node) => node.metadata?.webVideoSubmissionId)) setGenerationNodes((nodes) => nodes.map(resetWebVideoSubmission));
            recover();
        });
        // 配置和普通编辑更新不会自行恢复或新建任务。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session]);


    const handleGenerateNode = useCallback(
        async (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string, commandContext: CommandContext) => {
            const commitCanvas = (ops: CanvasDocumentOp[], nodeIds?: string[]) => commitHostTransaction(commandContext.canvas!, ops, nodeIds ? { selection: { nodeIds, connectionId: null } } : undefined);
            const sourceNode = nodesRef.current.find((node) => node.id === nodeId);
            if (!sourceNode) throw new PluginError("PLUGIN_NOT_FOUND");
            const definition = getNodeDefinition(sourceNode.type);
            if ((definition?.useBuiltinPanel && definition.useBuiltinPanel.mode !== mode) || sourceNode.type === CanvasNodeType.Group) throw new PluginError("PLUGIN_OPERATION_FAILED");
            const generationConfig = buildGenerationConfig(effectiveConfig, sourceNode, mode);
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true, "builtin:channels", generationConfig.model);
                throw new ModelExecutionError("MODEL_CONFIG_MISSING");
            }

            // useBuiltinPanel.writeBackToSelf reuses built-in generation while writing the result back to the plugin node.
            // Image mode currently supports display-only nodes such as panoramas, with a useBuiltinPanel.promptPrefix.
            const builtinPanel = definition?.useBuiltinPanel;
            if (builtinPanel?.writeBackToSelf && builtinPanel.mode === "image") {
                const panel = capturePanel(nodeId);
                const scene = prompt;
                if (!scene) throw new PluginError("PLUGIN_OPERATION_FAILED");
                const fullPrompt = (builtinPanel.promptPrefix || "") + scene;
                const fixedRatio = builtinPanel.imageAspectRatio;
                const scale = inferMediaScale(generationConfig.size);
                const imageConfig = fixedRatio ? { ...generationConfig, size: computeMediaSize(scale === "auto" ? "2k" : scale, fixedRatio) } : generationConfig;
                const context = buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, fullPrompt, commandContext.scope);
                setRunningNodeId(nodeId);
                const controller = startGenerationRequest(nodeId, nodeId, nodeId, new AbortController(), AbortSignal.any([commandContext.signal, context.signal]));
                generationRequestsRef.current.get(nodeId)!.mediaTarget = { type: sourceNode.type, revision: session.getSnapshot().revision };
                let accepted = false;
                try {
                    await commitCanvas([{ type: "update_node", id: nodeId, metadata: { mediaKind: "image", prompt: scene, status: NODE_STATUS_LOADING, errorDetails: undefined } }]);
                    const refs = context.referenceImages;
                    const options = task.options(nodeId, nodeId, controller.signal);
                    const image = refs.length
                        ? await requestEdit({ ...imageConfig, count: "1" }, context.prompt, refs, options).then((items) => items[0])
                        : await requestGeneration({ ...imageConfig, count: "1" }, context.prompt, options).then((items) => items[0]);
                    const applied = await applyImageResult({ nodeId, signal: controller.signal, taskId: options.taskId }, image.dataUrl, (prev, uploaded) => {
                        if (getNodeDefinition(sourceNode.type) !== definition) throw new PluginError("PLUGIN_INACTIVE");
                        return prev.map((node) => node.id === nodeId && node.type === sourceNode.type ? { ...node, metadata: { ...node.metadata, ...imageMetadata(uploaded), prompt: scene, model: generationConfig.model, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node);
                    }, () => { accepted = true; });
                    if (!applied) throw new PluginError("PLUGIN_INACTIVE");
                    if (panel && getNodeDefinition(sourceNode.type) === definition) panel.close();
                } catch (error) {
                    if (!accepted && !controller.signal.aborted && !isGenerationCanceled(error) && getNodeDefinition(sourceNode.type) === definition) {
                        const errorDetails = generationErrorMessage(error);
                        setGenerationNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node)));
                    }
                    throw error;
                } finally {
                    if (finishGenerationRequest(nodeId, controller)) setRunningNodeId((current) => current === nodeId ? null : current);
                }
                return;
            }

            const sourceTextContent = sourceNode.type === CanvasNodeType.Text ? sourceNode.metadata?.content || "" : "";
            const editingTextNode = mode === "text" && Boolean(sourceTextContent);
            const sourceResource = readNodeResource(sourceNode, "execute", commandContext.scope);
            const generationContext = buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, editingTextNode ? `请根据要求修改以下文本。\n\n原文：\n${sourceTextContent}\n\n修改要求：\n${prompt}` : prompt, commandContext.scope);
            const isBuiltinCloudVideo = mode === "video" && (isDreamMakerVideo(generationConfig.model) || isMiniMaxH3(generationConfig.model));
            const webVideoSubmissionId = mode === "video" && !models.tasks && !isBuiltinCloudVideo ? crypto.randomUUID() : undefined;
            const target = sourceNode.type === mode ? sourceNode : createCanvasNode(mode, {
                x: sourceNode.position.x + sourceNode.width + 96 + getNodeSpec(mode).width / 2,
                y: sourceNode.position.y + sourceNode.height / 2,
            });
            const rootId = target.id;
            const effectivePrompt = generationContext.prompt;
            setRunningNodeId(nodeId);
            const controller = startGenerationRequest(nodeId, nodeId, nodeId, new AbortController(), AbortSignal.any([commandContext.signal, generationContext.signal, ...(sourceResource ? [sourceResource.signal] : [])]));
            const begin = (metadata: CanvasNodeMetadata) => {
                const changes = { status: NODE_STATUS_LOADING, errorDetails: undefined, tasks: undefined, prompt: effectivePrompt, composerContent: prompt, ...metadata };
                if (rootId === nodeId) {
                    commitCanvas([{ type: "update_node", id: nodeId, metadata: changes }]);
                } else {
                    commitCanvas([
                        { type: "add_node", node: { ...target, metadata: { ...target.metadata, ...changes } } },
                        { type: "connect_nodes", connection: { id: nanoid(), fromNodeId: nodeId, toNodeId: rootId } },
                    ]);
                    startGenerationRequest(rootId, nodeId, nodeId, controller);
                }
                controller.signal.throwIfAborted();
            };
            let resultAccepted = false;
            const allowEmptyPrompt = mode === "text" && isFireRedUnderstand(generationConfig.model);
            try {
                if (!effectivePrompt && (mode === "audio" || mode === "text" && !generationContext.referenceImages.length && !allowEmptyPrompt)) throw new PluginError("PLUGIN_OPERATION_FAILED");
                if (mode === "image") {
                    const rawCount = getGenerationCount(generationConfig.count);
                    const isMjBatch = isDreamMakerMj(generationConfig.model);
                    const isArkLayerDecomp = isDreamMakerArk(generationConfig.model) && generationConfig.dmArkLayerDecomposition === "true";
                    const isCloudImage = isDreamMakerImage(generationConfig.model) || isQwenImage21(generationConfig.model);
                    const count = isMjBatch ? Math.max(4, Math.min(12, Math.ceil(rawCount / 4) * 4)) : rawCount;
                    const sourceReference = sourceResource?.kind === "image" && (sourceResource.storageKey || sourceResource.url)
                        ? [{ id: sourceNode.id, name: `${sourceNode.title || sourceNode.id}.png`, type: sourceNode.metadata?.mimeType || "image/png", dataUrl: sourceResource.url, storageKey: sourceResource.storageKey }] : [];
                    const referenceImages = [...new Map([...sourceReference, ...generationContext.referenceImages].map((image) => [image.id, image])).values()];
                    const generationType = referenceImages.length ? ("edit" as const) : ("generation" as const);
                    const generationMetadata = buildImageGenerationMetadata(generationType, generationConfig, count, referenceImages);
                    const imageIds = Array.from({ length: count }, () => nanoid());
                    begin({
                        ...generationMetadata,
                        images: imageIds.map((id) => ({ id, status: NODE_STATUS_LOADING, content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" })),
                        primaryImageId: undefined,
                    });
                    generationRequestsRef.current.get(rootId)!.mediaTarget = { revision: session.getSnapshot().revision, type: CanvasNodeType.Image, originType: sourceNode.type };
                    setDialogNodeId(nodeId);

                    let hasFailure = false;
                    let firstError = "";
                    let completed: Array<PromiseSettledResult<boolean>> = [];
                    if (isMjBatch) {
                        const chunks: string[][] = [];
                        for (let i = 0; i < imageIds.length; i += 4) chunks.push(imageIds.slice(i, i + 4));
                        completed = await Promise.allSettled(
                            chunks.map(async (chunk) => {
                                try {
                                    const items = referenceImages.length
                                        ? await requestEdit({ ...generationConfig, count: "1" }, effectivePrompt, referenceImages, { signal: controller.signal, onImageTaskIds: (ids) => attachImageSlotTask(rootId, chunk, ids) })
                                        : await requestGeneration({ ...generationConfig, count: "1" }, effectivePrompt, { signal: controller.signal, onImageTaskIds: (ids) => attachImageSlotTask(rootId, chunk, ids) });
                                    await Promise.all(
                                        chunk.map(async (slotId, idx) => {
                                            const item = items[idx];
                                            if (!item) return;
                                            await applyImageSlotSuccess(rootId, slotId, item.dataUrl, controller.signal, undefined, () => { resultAccepted = true; });
                                        }),
                                    );
                                    return true;
                                } catch (error) {
                                    if (controller.signal.aborted || isGenerationCanceled(error)) return false;
                                    const errorDetails = generationErrorMessage(error);
                                    if (!firstError) firstError = errorDetails;
                                    hasFailure = true;
                                    setGenerationNodes((prev) => prev.map((node) => (node.id === rootId ? { ...node, metadata: { ...node.metadata, images: node.metadata?.images?.map((image) => (chunk.includes(image.id) ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image)) } } : node)));
                                    return false;
                                }
                            }),
                        );
                    } else if (isArkLayerDecomp && referenceImages.length === 1 && count === 1) {
                        const slotId = imageIds[0];
                        try {
                            const items = await requestEdit({ ...generationConfig, count: "1" }, effectivePrompt, referenceImages, { signal: controller.signal, onImageTaskIds: (ids) => attachImageSlotTask(rootId, [slotId], ids) });
                            const extraSlots = items.slice(1).map(() => nanoid());
                            if (extraSlots.length) {
                                setGenerationNodes((prev) => prev.map((node) => (node.id === rootId ? {
                                    ...node,
                                    metadata: {
                                        ...node.metadata,
                                        count: items.length,
                                        images: [...(node.metadata?.images || []), ...extraSlots.map((id) => ({ id, status: NODE_STATUS_LOADING, content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" }))],
                                    },
                                } : node)));
                            }
                            const allSlots = [slotId, ...extraSlots];
                            await Promise.all(items.map(async (item, idx) => applyImageSlotSuccess(rootId, allSlots[idx], item.dataUrl, controller.signal, undefined, () => { resultAccepted = true; })));
                            completed = [{ status: "fulfilled", value: true }];
                        } catch (error) {
                            if (!controller.signal.aborted && !isGenerationCanceled(error)) {
                                const errorDetails = generationErrorMessage(error);
                                firstError = errorDetails;
                                hasFailure = true;
                                setGenerationNodes((prev) => prev.map((node) => (node.id === rootId ? { ...node, metadata: { ...node.metadata, images: node.metadata?.images?.map((image) => (image.id === slotId ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image)) } } : node)));
                            }
                            completed = [{ status: "fulfilled", value: false }];
                        }
                    } else {
                        completed = await Promise.allSettled(
                            imageIds.map(async (imageId) => {
                                const slot = new AbortController();
                                const options = isCloudImage ? { signal: AbortSignal.any([controller.signal, slot.signal]), onImageTaskIds: (ids: string[]) => attachImageSlotTask(rootId, [imageId], ids) } : task.options(rootId, nodeId, controller.signal, imageId, slot);
                                const signal = options.signal!;
                                const check = () => {
                                    if (!session.getSnapshot().nodes.find((item) => item.id === rootId)?.metadata?.images?.some((image) => image.id === imageId)) slot.abort(new PluginError("PLUGIN_INACTIVE"));
                                };
                                const release = session.subscribe(check);
                                let accepted = false;
                                try {
                                    check();
                                    signal.throwIfAborted();
                                    const image = referenceImages.length
                                        ? await requestEdit({ ...generationConfig, count: "1" }, effectivePrompt, referenceImages, options).then((items) => items[0])
                                        : await requestGeneration({ ...generationConfig, count: "1" }, effectivePrompt, options).then((items) => items[0]);
                                    await applyImageSlotSuccess(rootId, imageId, image.dataUrl, signal, options.taskId, () => { accepted = true; resultAccepted = true; });
                                    signal.throwIfAborted();
                                    return true;
                                } catch (error) {
                                    if (accepted) throw error;
                                    if (signal.aborted || isGenerationCanceled(error)) return false;
                                    const errorDetails = generationErrorMessage(error);
                                    if (!firstError) firstError = errorDetails;
                                    hasFailure = true;
                                    setGenerationNodes((prev) => prev.map((node) => (node.id === rootId ? { ...node, metadata: { ...node.metadata, images: node.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image)) } } : node)));
                                } finally { release(); if (!isCloudImage) task.finish(rootId, signal); }
                                return false;
                            }),
                        );
                    }
                    controller.signal.throwIfAborted();
                    const failedReceipt = completed.find((result) => result.status === "rejected");
                    if (!resultAccepted && !hasFailure) throw failedReceipt?.reason ?? new PluginError("PLUGIN_INACTIVE");
                    setGenerationNodes((prev) =>
                        prev.map((node) =>
                            node.id === rootId
                                ? { ...node, metadata: { ...node.metadata, status: resultAccepted ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: resultAccepted ? undefined : firstError || "全部图片生成失败" } }
                                : node,
                        ),
                    );
                    if (failedReceipt) throw failedReceipt.reason;
                    if (hasFailure) toast.error(resultAccepted ? "部分图片生成失败" : firstError || "生成失败", workbenchMessageOptions.error);
                    if (!resultAccepted) throw new PluginError("PLUGIN_OPERATION_FAILED");
                    return;
                }

                if (mode === "video") {
                    const metadata = {
                        webVideoSubmissionId, webVideoTask: undefined, model: generationConfig.model, size: generationConfig.size,
                        seconds: generationConfig.videoSeconds, vquality: generationConfig.vquality, generateAudio: generationConfig.videoGenerateAudio,
                        watermark: generationConfig.videoWatermark, videoMode: generationConfig.videoMode, references: generationReferences(generationContext),
                    };
                    begin(metadata);
                    await completeVideoNodeTask(rootId, webVideoSubmissionId, generationConfig, effectivePrompt, generationContext.referenceImages, controller.signal, () => { resultAccepted = true; }, metadata, generationContext.referenceVideos, generationContext.referenceAudios);
                    return;
                }
                if (mode === "audio") {
                    begin(isFireRedSpeech(generationConfig.model) ? fireRedSpeechMetadata(fireRedSpeechSettings(sourceNode.metadata || {}), generationConfig.model) : buildAudioGenerationMetadata(generationConfig));
                    await completeAudioNodeTask(rootId, nodeId, generationConfig, effectivePrompt, controller.signal, () => { resultAccepted = true; }, generationContext.referenceAudios);
                    return;
                }

                const textCount = getGenerationCount(String(sourceNode.metadata?.textCount || 1));
                const textIds = Array.from({ length: textCount }, () => nanoid());
                begin({
                    model: generationConfig.model, reasoningEffort: generationConfig.reasoningEffort, textCount,
                    texts: textIds.map((id) => ({ id, status: NODE_STATUS_LOADING, content: "" })), primaryTextId: textIds[0],
                });
                setDialogNodeId(nodeId);
                if (isFireRedUnderstand(generationConfig.model)) {
                    const understood = await runFireRedUnderstandTask(effectivePrompt, generationContext.referenceAudios, generationConfig.reasoningEffort !== "auto", {
                        signal: controller.signal,
                        onTaskId: (fireRedTaskId) => setGenerationNodes((prev) => prev.map((node) => (node.id === rootId ? { ...node, metadata: { ...node.metadata, fireRedTaskId } } : node))),
                    });
                    setGenerationNodes((prev) => prev.map((node) => (node.id === rootId ? {
                        ...node,
                        metadata: {
                            ...node.metadata,
                            content: understood.text,
                            status: NODE_STATUS_SUCCESS,
                            texts: textIds.map((id) => ({ id, status: NODE_STATUS_SUCCESS, content: understood.text })),
                        },
                    } : node)));
                    return;
                }
                const results = await Promise.all(
                    textIds.map(async (textId): Promise<CanvasNodeText | null> => {
                        let streamed = "";
                        try {
                            const options = task.options(rootId, nodeId, controller.signal, textId);
                            const answer = await requestImageQuestion(
                                generationConfig,
                                buildNodeResponseMessages({ ...generationContext, prompt: effectivePrompt }),
                                (text) => {
                                    if (controller.signal.aborted || options.taskId && !task.canApply(options.taskId, rootId, controller.signal)) return;
                                    streamed = text;
                                    setGenerationNodes((prev) =>
                                        prev.map((node) =>
                                            node.id === rootId
                                                ? {
                                                      ...node,
                                                      metadata: {
                                                          ...node.metadata,
                                                          ...(node.metadata?.primaryTextId === textId ? { content: text } : {}),
                                                          texts: node.metadata?.texts?.map((item) => (item.id === textId ? { ...item, content: text } : item)),
                                                      },
                                                  }
                                                : node,
                                        ),
                                    );
                                },
                                options,
                            );
                            const content = answer || streamed;
                            applyResult(rootId, "text", controller.signal, (prev) =>
                                prev.map((node) =>
                                    node.id === rootId && node.metadata?.texts?.some((item) => item.id === textId)
                                        ? {
                                              ...node,
                                              metadata: {
                                                  ...node.metadata,
                                                  ...(node.metadata?.primaryTextId === textId ? { content } : {}),
                                                  texts: node.metadata?.texts?.map((item) => (item.id === textId ? { ...item, content, status: NODE_STATUS_SUCCESS } : item)),
                                              },
                                          }
                                        : node,
                                ),
                                options.taskId,
                            );
                            return { id: textId, status: NODE_STATUS_SUCCESS, content } satisfies CanvasNodeText;
                        } catch (error) {
                            if (controller.signal.aborted || isGenerationCanceled(error)) return null;
                            const errorDetails = generationErrorMessage(error);
                            setGenerationNodes((prev) => prev.map((node) => (node.id === rootId ? { ...node, metadata: { ...node.metadata, texts: node.metadata?.texts?.map((item) => (item.id === textId ? { ...item, status: NODE_STATUS_ERROR, errorDetails } : item)) } } : node)));
                            return { id: textId, status: NODE_STATUS_ERROR, content: "", errorDetails } satisfies CanvasNodeText;
                        }
                    }),
                );
                controller.signal.throwIfAborted();
                const completedTexts = results.flatMap((item) => (item?.status === NODE_STATUS_SUCCESS ? [item] : []));
                const failedTexts = results.filter((item) => item?.status === NODE_STATUS_ERROR);
                const firstText = completedTexts[0];
                if (completedTexts.length <= 1) setExpandedBatchNodeIds((current) => new Set([...current].filter((id) => id !== rootId)));
                if (failedTexts.length) toast.error(firstText ? "部分文本生成失败" : failedTexts[0]?.errorDetails || "生成失败", workbenchMessageOptions.error);
                setGenerationNodes((prev) =>
                    prev.map((node) => {
                        if (node.id === rootId) {
                            const primaryText = completedTexts.find((text) => text.id === node.metadata?.primaryTextId) || firstText;
                            return {
                                ...node,
                                metadata: {
                                    ...node.metadata,
                                    content: primaryText?.content || "",
                                    texts: models.tasks ? node.metadata?.texts : completedTexts,
                                    primaryTextId: primaryText?.id,
                                    status: primaryText ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                    errorDetails: primaryText ? undefined : "生成失败",
                                },
                            };
                        }
                        return node;
                    }),
                );
                if (!firstText) throw new PluginError("PLUGIN_OPERATION_FAILED");
            } catch (error) {
                if (webVideoSubmissionId) {
                    releaseWebSubmission(rootId, webVideoSubmissionId);
                    throw error;
                }
                if (resultAccepted || controller.signal.aborted || isGenerationCanceled(error)) throw error;
                const errorDetails = generationErrorMessage(error);
                setGenerationNodes((prev) => prev.map((node) => node.id === rootId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node));
                throw error;
            } finally {
                if (rootId !== nodeId) finishGenerationRequest(rootId, controller);
                if (finishGenerationRequest(nodeId, controller)) setRunningNodeId((current) => current === nodeId ? null : current);
            }
        },
        [applyImageResult, capturePanel, completeAudioNodeTask, completeVideoNodeTask, effectiveConfig, finishGenerationRequest, isAiConfigReady, openConfigDialog, startGenerationRequest],
    );

    const handleRetryNode = useCallback(
        async (node: CanvasNodeData, commandContext: CommandContext, imageId?: string) => {
            const commitCanvas = (ops: CanvasDocumentOp[]) => commitHostTransaction(commandContext.canvas!, ops);
            const retryTarget = resolveNodeRetryTarget(projectId, node, imageId, Boolean(models.tasks));
            if (retryTarget.kind === "tasks") {
                if (generationRequestsRef.current.has(node.id)) throw new PluginError("PLUGIN_INACTIVE");
                const controller = startGenerationRequest(node.id, retryTarget.bindings[0].sourceId, node.id, new AbortController(), commandContext.signal);
                try {
                    const restored = await task.restore({ ...node, metadata: { ...node.metadata, tasks: retryTarget.bindings } }, controller, true);
                    controller.signal.throwIfAborted();
                    if (!restored) throw new PluginError("PLUGIN_OPERATION_FAILED");
                } finally { finishGenerationRequest(node.id, controller); }
                return;
            }
            if (retryTarget.kind === "video") {
                await pollVideoNodeTask(node, false, commandContext.signal);
                return;
            }
            if (hasResumableCloudVideoTask(node)) {
                await pollCloudVideoNodeTask(node, false, commandContext.signal);
                return;
            }
            if (hasResumableImageTask(node)) {
                await pollCloudImageNodeTask(node);
                return;
            }
            if (node.type === CanvasNodeType.Text && !imageId && (node.metadata?.textCount || 1) > 1) {
                await handleGenerateNode(node.id, "text", node.metadata?.composerContent ?? node.metadata?.prompt ?? "", commandContext);
                return;
            }
            const savedImageMetadata = node.type === CanvasNodeType.Image ? node.metadata : undefined;
            const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
            const generationConfig =
                hasSavedImageMetadata && savedImageMetadata
                    ? {
                          ...buildGenerationConfig(effectiveConfig, node, "image"),
                          model: savedImageMetadata.model || effectiveConfig.imageModel || effectiveConfig.model,
                          quality: savedImageMetadata.quality || effectiveConfig.quality,
                          size: savedImageMetadata.size || effectiveConfig.size,
                          background: savedImageMetadata.background ?? effectiveConfig.background,
                          count: "1",
                      }
                    : { ...buildGenerationConfig(effectiveConfig, node, node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true, "builtin:channels", generationConfig.model);
                throw new ModelExecutionError("MODEL_CONFIG_MISSING");
            }

            const context = hasSavedImageMetadata ? null : buildNodeGenerationContext(node.id, nodesRef.current, connectionsRef.current, node.metadata?.composerContent ?? node.metadata?.prompt ?? "", commandContext.scope);
            const prompt = savedImageMetadata?.prompt || context?.prompt || "";
            const isFireRedText = node.type === CanvasNodeType.Text && isFireRedUnderstand(generationConfig.model);
            if (!prompt && !isFireRedText) {
                toast.warning("找不到提示词，无法重试", workbenchMessageOptions.warning);
                throw new PluginError("PLUGIN_OPERATION_FAILED");
            }
            const generationType = savedImageMetadata?.generationType;
            const useReferenceImages = generationType ? generationType === "edit" : Boolean(context?.referenceImages.length);
            const sourceResource = useReferenceImages && !hasSavedImageMetadata ? readNodeResource(node, "execute", commandContext.scope) : null;
            setRunningNodeId(node.id);
            const isBuiltinCloudVideo = node.type === CanvasNodeType.Video && (isDreamMakerVideo(generationConfig.model) || isMiniMaxH3(generationConfig.model));
            const webVideoSubmissionId = node.type === CanvasNodeType.Video && !models.tasks && !isBuiltinCloudVideo ? crypto.randomUUID() : undefined;
            const controller = startGenerationRequest(node.id, node.id, node.id, new AbortController(), AbortSignal.any([commandContext.signal, ...(context ? [context.signal] : []), ...(sourceResource ? [sourceResource.signal] : [])]));
            if (node.type !== CanvasNodeType.Text && node.type !== CanvasNodeType.Audio && node.type !== CanvasNodeType.Video) {
                generationRequestsRef.current.get(node.id)!.mediaTarget = { revision: session.getSnapshot().revision, type: node.type, originType: node.type, slotId: imageId };
            }

            let resultAccepted = false;
            try {
                commitCanvas([{ type: "update_node", id: node.id, metadata: { status: NODE_STATUS_LOADING, errorDetails: undefined, webVideoSubmissionId, images: node.metadata?.images?.map((image) => image.id === imageId ? { ...image, status: NODE_STATUS_LOADING, errorDetails: undefined } : image) } }]);
                const saved = node.metadata?.references && (hasSavedImageMetadata || node.type === CanvasNodeType.Video) ? resolveMetadataReferences(node.metadata.references) : undefined;
                const retryImages = saved?.images ?? (useReferenceImages ? (context?.referenceImages.length ? context.referenceImages : sourceNodeReferenceImages(node, commandContext.scope)) : []);
                if (hasSavedImageMetadata && useReferenceImages && !saved?.images.length) throw new Error("参考图片已丢失，无法继续重试");
                controller.signal.throwIfAborted();
                if (node.type === CanvasNodeType.Text) {
                    if (!context) throw new PluginError("PLUGIN_OPERATION_FAILED");
                    const resumeTaskId = isFireRedUnderstand(generationConfig.model) && context.referenceAudios.length ? node.metadata?.fireRedTaskId : undefined;
                    if (resumeTaskId) {
                        try {
                            const answer = await resumeFireRedTextResult(resumeTaskId, { signal: controller.signal });
                            setGenerationNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: answer, prompt, status: NODE_STATUS_SUCCESS, texts: item.metadata?.texts?.map((text) => ({ ...text, content: answer, status: NODE_STATUS_SUCCESS, errorDetails: undefined })) } } : item)));
                            return;
                        } catch (error) {
                            const missing = error instanceof FireRedApiError && error.status === 404;
                            if (!missing) throw error;
                            setGenerationNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, fireRedTaskId: undefined } } : item)));
                        }
                    }
                    if (isFireRedUnderstand(generationConfig.model) && context.referenceAudios.length) {
                        const answer = await runFireRedUnderstandTask(prompt, context.referenceAudios, generationConfig.reasoningEffort !== "auto", {
                            signal: controller.signal,
                            onTaskId: (fireRedTaskId) => setGenerationNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, fireRedTaskId } } : item))),
                        });
                        setGenerationNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: answer.text, prompt, status: NODE_STATUS_SUCCESS, texts: item.metadata?.texts?.map((text) => ({ ...text, content: answer.text, status: NODE_STATUS_SUCCESS, errorDetails: undefined })) } } : item)));
                        return;
                    }
                    const options = task.options(node.id, node.id, controller.signal);
                    let streamed = "";
                    const answer = await requestImageQuestion(
                        generationConfig,
                        buildNodeResponseMessages({ ...context, prompt }),
                        (text) => {
                            if (controller.signal.aborted || options.taskId && !task.canApply(options.taskId, node.id, controller.signal)) return;
                            streamed = text;
                            setGenerationNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: text, status: NODE_STATUS_LOADING } } : item)));
                        },
                        options,
                    );
                    applyResult(node.id, "text", controller.signal, (prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: answer || streamed, prompt, status: NODE_STATUS_SUCCESS } } : item)), options.taskId);
                    return;
                }
                if (node.type === CanvasNodeType.Video) {
                    await completeVideoNodeTask(node.id, webVideoSubmissionId, generationConfig, prompt, retryImages, controller.signal, () => { resultAccepted = true; }, {
                        size: generationConfig.size,
                        seconds: generationConfig.videoSeconds,
                        vquality: generationConfig.vquality,
                        generateAudio: generationConfig.videoGenerateAudio,
                        watermark: generationConfig.videoWatermark,
                        videoMode: generationConfig.videoMode,
                    }, saved?.videos ?? context?.referenceVideos ?? [], saved?.audios ?? context?.referenceAudios ?? []);
                    return;
                }
                if (node.type === CanvasNodeType.Audio) {
                    const resumeTaskId = isFireRedSpeech(generationConfig.model) ? node.metadata?.fireRedTaskId : undefined;
                    if (resumeTaskId) {
                        try {
                            const blob = await resumeFireRedAudio(resumeTaskId, { signal: controller.signal });
                            await session.commitMediaResult({ input: blob }, controller.signal, (audio) => applyResult(node.id, "audio", controller.signal, (nodes) =>
                                nodes.map((item) => item.id === node.id && item.type === CanvasNodeType.Audio
                                    ? { ...item, metadata: { ...item.metadata, ...audioMetadata(audio), prompt } } : item)),
                                mediaReceipt(node.id, controller.signal, undefined, () => { resultAccepted = true; }));
                            return;
                        } catch (error) {
                            const missing = error instanceof FireRedApiError && error.status === 404;
                            if (!missing) throw error;
                            setGenerationNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, fireRedTaskId: undefined } } : item)));
                        }
                    }
                    await completeAudioNodeTask(node.id, node.id, generationConfig, prompt, controller.signal, () => { resultAccepted = true; }, context?.referenceAudios || []);
                    return;
                }

                const retrySlotId = imageId || node.metadata?.primaryImageId || nanoid();
                const isCloudImage = isDreamMakerImage(generationConfig.model) || isQwenImage21(generationConfig.model);
                const options = isCloudImage ? { signal: controller.signal, onImageTaskIds: (ids: string[]) => attachImageSlotTask(node.id, [retrySlotId], ids) } : task.options(node.id, node.id, controller.signal, imageId);
                const image = useReferenceImages
                    ? await requestEdit(generationConfig, prompt, retryImages, options).then((items) => items[0])
                    : await requestGeneration(generationConfig, prompt, options).then((items) => items[0]);
                const applied = await applyImageResult({ nodeId: node.id, signal: controller.signal, taskId: isCloudImage ? undefined : (options as { taskId?: string }).taskId }, image.dataUrl, (prev, uploadedImage) => {
                    const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                    const retryImage: CanvasNodeImage = {
                        id: imageId || node.metadata?.primaryImageId || nanoid(),
                        status: NODE_STATUS_SUCCESS,
                        content: uploadedImage.url ?? "",
                        storageKey: uploadedImage.storageKey,
                        naturalWidth: uploadedImage.width,
                        naturalHeight: uploadedImage.height,
                        bytes: uploadedImage.bytes,
                        mimeType: uploadedImage.mimeType,
                    };
                    const generationMetadata = savedImageMetadata?.generationType
                        ? {
                              generationType: savedImageMetadata.generationType,
                              model: generationConfig.model,
                              size: generationConfig.size,
                              quality: generationConfig.quality,
                              ...(generationConfig.background ? { background: generationConfig.background } : {}),
                              count: savedImageMetadata.count || 1,
                              references: savedImageMetadata.references,
                          }
                        : buildImageGenerationMetadata(useReferenceImages ? "edit" : "generation", generationConfig, 1, retryImages);
                    return prev.map((item) => {
                        if (item.id !== node.id || imageId && !item.metadata?.images?.some((image) => image.id === imageId)) return item;
                        const makePrimary = !imageId || item.metadata?.primaryImageId === imageId || !(item.metadata?.storageKey || item.metadata?.content);
                        const edge = imageId ? Math.max(item.width, item.height) : 0;
                        const imageSize = imageId && item.metadata?.freeResize ? { width: item.width, height: item.height } : imageId ? fitNodeSize(uploadedImage.width, uploadedImage.height, edge, edge) : fitNodeSize(uploadedImage.width, uploadedImage.height, imageConfig.width, imageConfig.height);
                        return {
                            ...item,
                            type: CanvasNodeType.Image,
                            ...(makePrimary ? { width: imageSize.width, height: imageSize.height, ...(imageId ? { position: { x: item.position.x + item.width / 2 - imageSize.width / 2, y: item.position.y + item.height / 2 - imageSize.height / 2 } } : {}) } : {}),
                            metadata: {
                                ...item.metadata,
                                ...(makePrimary ? imageMetadata(uploadedImage) : { status: NODE_STATUS_SUCCESS }),
                                images: item.metadata?.images?.map((current) => (current.id === retryImage.id ? retryImage : current)),
                                primaryImageId: makePrimary ? retryImage.id : item.metadata?.primaryImageId,
                                prompt,
                                ...generationMetadata,
                            },
                        };
                    });
                }, () => { resultAccepted = true; });
                if (!applied) throw new PluginError("PLUGIN_INACTIVE");
            } catch (error) {
                if (webVideoSubmissionId) {
                    releaseWebSubmission(node.id, webVideoSubmissionId);
                    throw error;
                }
                if (resultAccepted || controller.signal.aborted || isGenerationCanceled(error)) throw error;
                const errorDetails = generationErrorMessage(error);
                setGenerationNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  metadata: {
                                      ...item.metadata,
                                      status: item.metadata?.storageKey || item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR,
                                      errorDetails: item.metadata?.storageKey || item.metadata?.content ? undefined : errorDetails,
                                      images: item.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image)),
                                  },
                              }
                            : item,
                    ),
                );
                throw error;
            } finally {
                if (finishGenerationRequest(node.id, controller)) setRunningNodeId((current) => current === node.id ? null : current);
            }
        },
        [applyImageResult, completeAudioNodeTask, completeVideoNodeTask, effectiveConfig, finishGenerationRequest, handleGenerateNode, isAiConfigReady, openConfigDialog, pollVideoNodeTask, startGenerationRequest],
    );


    const generateImageFromTextNode = useCallback(
        (node: CanvasNodeData, context: CommandContext) => {
            const prompt = readNodeResource(node, "execute", context.scope)?.text;
            if (!prompt) {
                toast.warning("文本节点为空，无法生图", workbenchMessageOptions.warning);
                throw new PluginError("PLUGIN_OPERATION_FAILED");
            }
            const imageNode = createCanvasNode(CanvasNodeType.Image, {
                x: node.position.x + node.width + 96 + getNodeSpec(CanvasNodeType.Image).width / 2,
                y: node.position.y + node.height / 2,
            });
            const snapshot = commitHostTransaction(context.canvas!, [
                { type: "add_node", node: imageNode },
                { type: "connect_nodes", connection: { id: nanoid(), fromNodeId: node.id, toNodeId: imageNode.id } },
            ], { selection: { nodeIds: [imageNode.id], connectionId: null } });
            setDialogNodeId(imageNode.id);
            return snapshot;
        },
        [setDialogNodeId],
    );

    const saveNodeAsset = useCallback(
        async (node: CanvasNodeData, context: CommandContext) => {
            const resource = readNodeResource(node, "execute", context.scope);
            if (resource?.kind === "text") {
                const content = resource.text;
                if (!content) throw new PluginError("PLUGIN_OPERATION_FAILED");
                addAsset({ kind: "text", title: node.metadata?.prompt?.slice(0, 24) || "画布文本", coverUrl: "", source: "Canvas", data: { content }, metadata: { source: "canvas", nodeId: node.id } });
                toast.success("已加入我的资产", workbenchMessageOptions.success);
                return;
            }
            if (resource?.kind === "video") {
                if (!(resource.storageKey || resource.url)) throw new PluginError("PLUGIN_OPERATION_FAILED");
                addAsset({
                    kind: "video",
                    title: node.metadata?.prompt?.slice(0, 24) || "画布视频",
                    coverUrl: "",
                    source: "Canvas",
                    data: { url: resource.url, storageKey: resource.storageKey, width: node.width, height: node.height, bytes: node.metadata?.bytes || 0, mimeType: node.metadata?.mimeType || "video/mp4" },
                    metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
                });
                toast.success("已加入我的资产", workbenchMessageOptions.success);
                return;
            }
            if (resource?.kind !== "image" || !(resource.storageKey || resource.url)) throw new PluginError("PLUGIN_OPERATION_FAILED");
            addAsset({
                kind: "image",
                title: node.metadata?.prompt?.slice(0, 24) || "画布图片",
                coverUrl: "",
                source: "Canvas",
                data: {
                    dataUrl: resource.url,
                    storageKey: resource.storageKey,
                    width: node.metadata?.naturalWidth || node.width,
                    height: node.metadata?.naturalHeight || node.height,
                    bytes: node.metadata?.bytes || (resource.url ? getDataUrlByteSize(resource.url) : 0),
                    mimeType: node.metadata?.mimeType || "image/png",
                },
                metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
            });
            toast.success("已加入我的资产", workbenchMessageOptions.success);
        },
        [addAsset],
    );

    const submitAcousticEdit = useCallback(async () => {
        const node = nodesRef.current.find((item) => item.id === acousticEditNodeId);
        if (!node || !(node.metadata?.storageKey || node.metadata?.content) || acousticRunning) return;
        const { speed, pitch, volume } = acousticValues;
        if (speed === 1 && pitch === 0 && volume === 1) {
            toast.warning("请先调整至少一项参数", workbenchMessageOptions.warning);
            return;
        }
        const description = [speed !== 1 ? `语速 ${speed}×` : "", pitch !== 0 ? `音调 ${pitch > 0 ? "+" : ""}${pitch}` : "", volume !== 1 ? `音量 ${volume}×` : ""].filter(Boolean).join(" · ");
        setAcousticRunning(true);
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
        const audioId = nanoid();
        const derived: CanvasNodeData = {
            id: audioId,
            type: CanvasNodeType.Audio,
            title: `声学调节 · ${(node.title || "").slice(0, 16)}`,
            position: { x: node.position.x + node.width + 96, y: node.position.y + (node.height - spec.height) / 2 },
            width: spec.width,
            height: spec.height,
            metadata: { prompt: description, status: NODE_STATUS_LOADING, model: FIRERED_SPEECH_OPTION },
        };
        session.transact([
            { type: "add_node", node: derived },
            { type: "connect_nodes", connection: { id: nanoid(), fromNodeId: node.id, toNodeId: audioId } },
        ], { selection: { nodeIds: [audioId], connectionId: null }, source: { kind: "ui" } });
        const controller = startGenerationRequest(audioId, node.id, audioId);
        try {
            const reference: ReferenceAudio = { id: node.id, name: `${node.title || node.id}.wav`, type: node.metadata?.mimeType || "audio/wav", url: node.metadata?.content, storageKey: node.metadata?.storageKey, durationMs: node.metadata?.durationMs };
            const result = await runFireRedAcousticEditTask(reference, { speed, pitch, volume }, {
                signal: controller.signal,
                onTaskId: (fireRedTaskId) => setGenerationNodes((prev) => prev.map((item) => (item.id === audioId ? { ...item, metadata: { ...item.metadata, fireRedTaskId } } : item))),
            });
            await session.commitMediaResult({ input: result.blob }, controller.signal, (audio) => applyResult(audioId, "audio", controller.signal, (nodes) =>
                nodes.map((item) => (item.id === audioId ? { ...item, metadata: { ...item.metadata, ...audioMetadata(audio), prompt: description } } : item))),
                mediaReceipt(audioId, controller.signal, undefined, () => undefined));
            setAcousticEditNodeId(null);
        } catch (error) {
            if (!controller.signal.aborted && !isGenerationCanceled(error)) {
                const errorDetails = generationErrorMessage(error);
                toast.error(errorDetails, workbenchMessageOptions.error);
                setGenerationNodes((prev) => prev.map((item) => (item.id === audioId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            }
        } finally {
            finishGenerationRequest(audioId, controller);
            setAcousticRunning(false);
        }
    }, [acousticEditNodeId, acousticRunning, acousticValues, applyResult, finishGenerationRequest, mediaReceipt, nodesRef, session, setGenerationNodes, startGenerationRequest]);

    const handlers = useRef({ handleGenerateNode, handleRetryNode, generateImageFromTextNode, saveNodeAsset, stopGenerationByRunningId, pollVideoNodeTask, promoteVideoDraftNode, effectiveConfig });
    useLayoutEffect(() => { handlers.current = { handleGenerateNode, handleRetryNode, generateImageFromTextNode, saveNodeAsset, stopGenerationByRunningId, pollVideoNodeTask, promoteVideoDraftNode, effectiveConfig }; });
    useLayoutEffect(() => {
        const getNode = (nodeId: string, context: CommandContext) => {
            context.signal.throwIfAborted();
            if (session.signal.aborted || context.canvas?.projectId !== session.projectId) throw new PluginError("PLUGIN_PROJECT_CHANGED");
            const node = session.getSnapshot().nodes.find((node) => node.id === nodeId);
            if (!node) throw new PluginError("PLUGIN_NOT_FOUND");
            return node;
        };
        const contributions: PluginCommand<any, any>[] = [
            { command: nodeGenerate, title: "生成节点内容", enabled: ({ nodeId }, context) => getNode(nodeId, context).type !== CanvasNodeType.Group, run: async ({ nodeId, mode, prompt }, context) => {
                getNode(nodeId, context);
                await handlers.current.handleGenerateNode(nodeId, mode, prompt, context);
                return context.canvas!.getSnapshot();
            } },
            { command: nodeRetry, title: "重试节点生成", enabled: ({ nodeId, slotId }, context) => {
                const node = getNode(nodeId, context);
                return node.type !== CanvasNodeType.Group && !generationRequestsRef.current.has(nodeId) && (slotId === undefined || Boolean(node.metadata?.images?.some((image) => image.id === slotId)));
            }, run: async ({ nodeId, slotId }, context) => {
                await handlers.current.handleRetryNode(getNode(nodeId, context), context, slotId);
                return context.canvas!.getSnapshot();
            } },
            { command: nodeStop, title: "停止节点生成", enabled: ({ nodeId }) => [...generationRequestsRef.current.values()].some((request) => !request.controller.signal.aborted && [request.targetNodeId, request.originNodeId, request.runningNodeId].includes(nodeId)), run: async ({ nodeId, confirm }, context) => {
                getNode(nodeId, context);
                if (confirm) await confirmNodeStop(presentStop, context.signal, generationRequestsRef.current, nodeId, (original) => handlers.current.stopGenerationByRunningId(nodeId, original));
                else await handlers.current.stopGenerationByRunningId(nodeId);
            } },
            { command: nodeOpenPanel, title: "打开节点面板", run: ({ nodeId }, context) => { getNode(nodeId, context); setDialogNodeId(nodeId); } },
            { command: nodeSetTextContent, title: "编辑文本内容", enabled: ({ nodeId }, context) => getNode(nodeId, context).type === CanvasNodeType.Text, run: ({ nodeId, content }, context) => {
                return setTextNodeContent(getNode(nodeId, context), content, (ops) => commitHostTransaction(context.canvas!, ops), generationRequestsRef.current);
            } },
        ];
        const disposers = contributions.map((value) => builtinPlugin.extensions.contribute(commands, { id: value.command.id, value: {
            ...value, enabled: (input, context) => context.canvas?.projectId === session.projectId && !session.signal.aborted && session.getSnapshot().nodes.some((node) => node.id === input.nodeId) && (value.enabled?.(input, context) ?? true),
        } }));
        disposers.push(bindHostActions(session, {
            ...createImageEditCommands({ session, getConfig: () => handlers.current.effectiveConfig, startGenerationRequest, finishGenerationRequest, task, applyImageResult, setRunningNodeId }),
            nodeCreateImageFromText: ({ nodeId }, context) => handlers.current.generateImageFromTextNode(getNode(nodeId, context), context),
            nodeSaveAsset: ({ nodeId }, context) => handlers.current.saveNodeAsset(getNode(nodeId, context), context),
            nodeSelectReferences: ({ nodeId }, context) => {
                getNode(nodeId, context);
                context.canvas!.setSelection({ nodeIds: [nodeId], connectionId: null });
                setReferencePickerNodeId(nodeId);
                setDialogNodeId(null);
            },
            nodeTogglePanel: ({ nodeId }, context) => { getNode(nodeId, context); setDialogNodeId((current) => current === nodeId ? null : nodeId); },
            nodePromoteVideoDraft: ({ nodeId, resolution }, context) => handlers.current.promoteVideoDraftNode(getNode(nodeId, context), resolution),
            nodeOpenAcousticEdit: ({ nodeId }, context) => {
                getNode(nodeId, context);
                setAcousticValues({ speed: 1, pitch: 0, volume: 1 });
                setAcousticEditNodeId(nodeId);
            },
        }));
        return () => { for (const dispose of disposers) dispose(); };
    }, [session, setDialogNodeId, setReferencePickerNodeId, presentStop]);

    const isGenerating = useCallback((nodeId: string) => runningNodeId === nodeId || Boolean(generationRequestsRef.current.get(nodeId) && !generationRequestsRef.current.get(nodeId)!.controller.signal.aborted), [runningNodeId]);
    return {
        stopConfirmation: stopConfirmations[0],
        runningNodeId,
        setRunningNodeId,
        isGenerating,
        startGenerationRequest,
        finishGenerationRequest,
        generationRequestsRef,
        setGenerationNodes,
        applyImageResult,
        task,
        acousticEdit: {
            open: Boolean(acousticEditNodeId),
            running: acousticRunning,
            values: acousticValues,
            setValues: setAcousticValues,
            close: () => { if (!acousticRunning) setAcousticEditNodeId(null); },
            submit: submitAcousticEdit,
        },
    };
}
