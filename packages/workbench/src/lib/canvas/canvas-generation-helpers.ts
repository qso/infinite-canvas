import { defaultConfig, resolveModelForCapability, type AiConfig } from "@workbench/stores/use-config-store";
import { PluginError } from "@infinite-canvas/shared/plugins";
import { ModelExecutionError } from "@infinite-canvas/shared/model-http";
import { DEFAULT_MUSIC_DRAFT, MUSIC_MODEL, type MusicAnalysisResult, type MusicGenerationDraft, type MusicGenerationRequest } from "@workbench/constant/music";

import { canvasMediaReferences } from "@workbench/lib/canvas/canvas-node-factory";
import { hasNodeMedia } from "@workbench/lib/media-source";
import type { CanvasNodeGenerationMode } from "@workbench/components/canvas/canvas-node-prompt-panel";
import type { ImageAngleParams, ReadonlyCanvasNode } from "@infinite-canvas/plugin-sdk";
import type { ReferenceImage } from "@workbench/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@workbench/types/media";
import { CanvasNodeType, isCanvasTaskBinding, isWebVideoTaskOwner, type CanvasMediaReference, type CanvasNodeData, type CanvasNodeMetadata } from "@infinite-canvas/shared/canvas/schema/canvas";
import { readNodeResource } from "@workbench/lib/canvas/node-registry";
import type { ScopeBinding } from "@infinite-canvas/plugin-sdk/runtime";

export function imageExtension(dataUrl: string) {
    return dataUrl.match(/^data:image[/]([^;]+)/)?.[1] || dataUrl.match(/image[/]([^;]+)/)?.[1] || "png";
}

export function audioExtension(mimeType?: string) {
    if (mimeType?.includes("wav")) return "wav";
    if (mimeType?.includes("opus")) return "opus";
    if (mimeType?.includes("aac")) return "aac";
    if (mimeType?.includes("flac")) return "flac";
    if (mimeType?.includes("pcm")) return "pcm";
    return "mp3";
}

export function generationReferences(context: { referenceImages: ReferenceImage[]; referenceVideos: ReferenceVideo[]; referenceAudios: ReferenceAudio[] }) {
    return [
        ...canvasMediaReferences("image", context.referenceImages),
        ...canvasMediaReferences("video", context.referenceVideos),
        ...canvasMediaReferences("audio", context.referenceAudios),
    ];
}

export function resolveMetadataReferences(references: readonly CanvasMediaReference[]) {
    const images: ReferenceImage[] = [], videos: ReferenceVideo[] = [], audios: ReferenceAudio[] = [];
    for (const [index, reference] of references.entries()) {
        const id = String(index);
        const source = "storageKey" in reference ? { storageKey: reference.storageKey } : { url: reference.url };
        if (reference.kind === "image") images.push({ id, name: `reference-${id}.png`, type: "image/png", ...source });
        else if (reference.kind === "video") videos.push({ id, name: `reference-${id}.mp4`, type: "video/mp4", ...source });
        else audios.push({ id, name: `reference-${id}.mp3`, type: "audio/mpeg", ...source });
    }
    return { images, videos, audios };
}

export function getGenerationCount(count: string) {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(count)) || 1)));
}

export function buildGenerationConfig(config: AiConfig, node: ReadonlyCanvasNode | undefined, mode: CanvasNodeGenerationMode): AiConfig {
    return {
        ...config,
        model: resolveModelForCapability(config, node?.metadata?.model, mode),
        reasoningEffort: node?.metadata?.reasoningEffort || config.reasoningEffort || defaultConfig.reasoningEffort,
        quality: node?.metadata?.quality || config.quality || defaultConfig.quality,
        size: node?.metadata?.size || (mode === "video" ? config.videoSize : config.size) || defaultConfig.size,
        background: node?.metadata?.background ?? config.background ?? defaultConfig.background,
        imageSteps: node?.metadata?.imageSteps ?? config.imageSteps ?? defaultConfig.imageSteps,
        imageCfg: node?.metadata?.imageCfg ?? config.imageCfg ?? defaultConfig.imageCfg,
        imageSeed: node?.metadata?.imageSeed ?? config.imageSeed ?? defaultConfig.imageSeed,
        imageNegative: node?.metadata?.imageNegative ?? config.imageNegative ?? defaultConfig.imageNegative,
        imageResolution: node?.metadata?.imageResolution ?? config.imageResolution ?? defaultConfig.imageResolution,
        dmMjQuality: node?.metadata?.dmMjQuality ?? config.dmMjQuality ?? defaultConfig.dmMjQuality,
        dmMjHd: node?.metadata?.dmMjHd ?? config.dmMjHd ?? defaultConfig.dmMjHd,
        dmMjRaw: node?.metadata?.dmMjRaw ?? config.dmMjRaw ?? defaultConfig.dmMjRaw,
        dmMjStylize: node?.metadata?.dmMjStylize ?? config.dmMjStylize ?? defaultConfig.dmMjStylize,
        dmMjChaos: node?.metadata?.dmMjChaos ?? config.dmMjChaos ?? defaultConfig.dmMjChaos,
        dmMjWeird: node?.metadata?.dmMjWeird ?? config.dmMjWeird ?? defaultConfig.dmMjWeird,
        dmMjExp: node?.metadata?.dmMjExp ?? config.dmMjExp ?? defaultConfig.dmMjExp,
        dmMjTile: node?.metadata?.dmMjTile ?? config.dmMjTile ?? defaultConfig.dmMjTile,
        dmMjIw: node?.metadata?.dmMjIw ?? config.dmMjIw ?? defaultConfig.dmMjIw,
        dmMjMode: node?.metadata?.dmMjMode ?? config.dmMjMode ?? defaultConfig.dmMjMode,
        dmGptFormat: node?.metadata?.dmGptFormat ?? config.dmGptFormat ?? defaultConfig.dmGptFormat,
        dmGptModeration: node?.metadata?.dmGptModeration ?? config.dmGptModeration ?? defaultConfig.dmGptModeration,
        dmArkSizeTier: node?.metadata?.dmArkSizeTier ?? config.dmArkSizeTier ?? defaultConfig.dmArkSizeTier,
        dmArkOptimizePrompt: node?.metadata?.dmArkOptimizePrompt ?? config.dmArkOptimizePrompt ?? defaultConfig.dmArkOptimizePrompt,
        dmArkWebSearch: node?.metadata?.dmArkWebSearch ?? config.dmArkWebSearch ?? defaultConfig.dmArkWebSearch,
        dmArkLayerDecomposition: node?.metadata?.dmArkLayerDecomposition ?? config.dmArkLayerDecomposition ?? defaultConfig.dmArkLayerDecomposition,
        videoSeconds: node?.metadata?.seconds || config.videoSeconds || defaultConfig.videoSeconds,
        vquality: node?.metadata?.vquality || config.vquality || defaultConfig.vquality,
        videoGenerateAudio: node?.metadata?.generateAudio || config.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node?.metadata?.watermark || config.videoWatermark || defaultConfig.videoWatermark,
        videoMode: node?.metadata?.videoMode || config.videoMode || defaultConfig.videoMode,
        videoSteps: node?.metadata?.videoSteps ?? config.videoSteps ?? defaultConfig.videoSteps,
        videoSeed: node?.metadata?.videoSeed ?? config.videoSeed ?? defaultConfig.videoSeed,
        videoRefImageSize: node?.metadata?.videoRefImageSize ?? config.videoRefImageSize ?? defaultConfig.videoRefImageSize,
        videoHd: node?.metadata?.videoHd ?? config.videoHd ?? defaultConfig.videoHd,
        audioVoice: node?.metadata?.audioVoice || config.audioVoice || defaultConfig.audioVoice,
        audioFormat: node?.metadata?.audioFormat || config.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node?.metadata?.audioSpeed || config.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node?.metadata?.audioInstructions || config.audioInstructions || defaultConfig.audioInstructions,
        count: String(node?.metadata?.count || (mode === "image" ? config.canvasImageCount || config.count : config.count) || defaultConfig.count),
    };
}

export function hasResumableCloudVideoTask(node: ReadonlyCanvasNode) {
    return node.type === CanvasNodeType.Video && Boolean(node.metadata?.videoTaskId) && !(node.metadata?.storageKey || node.metadata?.content);
}

export function hasResumableImageTask(node: ReadonlyCanvasNode) {
    return node.type === CanvasNodeType.Image && Boolean(node.metadata?.images?.some((image) => image.status === "loading" && image.taskId));
}

export function hasResumableMusicTask(node: ReadonlyCanvasNode) {
    return node.type === CanvasNodeType.Music && Boolean(node.metadata?.musicTaskId) && !(node.metadata?.storageKey || node.metadata?.content) && node.metadata?.musicTaskStatus !== "failed" && !node.metadata?.musicContentUnavailable;
}

export function musicDraftFromRequest(request: MusicGenerationRequest): MusicGenerationDraft {
    return { style: request.style, lyrics: request.lyrics, cot: request.cot, outputType: request.output_type || "song", seed: request.seed === null ? "" : String(request.seed), cfgScale: request.cfg_scale === null ? "" : String(request.cfg_scale), steps: String(request.steps), temperature: String(request.temperature), abc: request.abc || "", format: request.format, creationMode: request.reference?.mode || "original", abcSampling: { temperature: String(request.abc_temperature ?? 0.7), topP: String(request.abc_top_p ?? 0.9), topK: String(request.abc_top_k ?? 30), repetitionPenalty: String(request.abc_repetition_penalty ?? 1.005) }, semanticSampling: { topP: String(request.top_p ?? 0.95), topK: String(request.top_k ?? 100), repetitionPenalty: String(request.repetition_penalty ?? 1.2) } };
}

export function readMusicDraft(metadata?: CanvasNodeMetadata): MusicGenerationDraft {
    const rawDraft = metadata?.musicDraft as MusicGenerationDraft | undefined;
    const rawReq = metadata?.musicRequest as MusicGenerationRequest | undefined;
    return rawDraft || (rawReq ? musicDraftFromRequest(rawReq) : DEFAULT_MUSIC_DRAFT);
}

export function selectMusicReference(node: ReadonlyCanvasNode, references: ReadonlyCanvasNode[]) {
    return references.find((reference) => reference.id === readMusicDraft(node.metadata).referenceNodeId) || (references.length === 1 ? references[0] : undefined);
}

export function readMusicReferenceAnalysis(node: ReadonlyCanvasNode, reference?: ReadonlyCanvasNode): MusicAnalysisResult | undefined {
    const metadata = node.metadata;
    return reference && metadata?.musicAnalysisId && metadata.musicAnalysisStatus === "completed" && metadata.musicAnalysisNodeId === reference.id && metadata.musicAnalysisStorageKey === (reference.metadata?.storageKey || reference.metadata?.content) ? (metadata.musicAnalysis as unknown as MusicAnalysisResult) : undefined;
}

export function buildMusicGenerationRequest(id: string, draft: MusicGenerationDraft, connectedLyrics = ""): MusicGenerationRequest {
    const seed = draft.seed.trim() ? Number(draft.seed) : null;
    const cfgScale = draft.cfgScale.trim() ? Number(draft.cfgScale) : null;
    const steps = Number(draft.steps);
    const temperature = Number(draft.temperature);
    const outputType = draft.outputType || "song";
    const cot = outputType === "instrumental" && draft.cot === "off" ? "full" : draft.cot;
    if (!draft.style.trim()) throw new Error("请填写音乐风格描述。");
    if (seed !== null && (!Number.isSafeInteger(seed) || seed < 0)) throw new Error("随机种子需要是非负整数，请留空或改小数值。");
    if (!Number.isInteger(steps) || steps <= 0) throw new Error("采样步数需要是正整数。");
    if (cfgScale !== null && (!Number.isFinite(cfgScale) || cfgScale < 0 || cfgScale > 20)) throw new Error("引导强度需要在 0–20 之间。");
    if (!draft.temperature.trim() || !Number.isFinite(temperature) || temperature < 0 || temperature > 5) throw new Error("采样温度需要在 0–5 之间。");
    const abc = draft.abcSampling;
    const semantic = draft.semanticSampling;
    const sampling = { abc_temperature: Number(abc?.temperature ?? 0.7), abc_top_p: Number(abc?.topP ?? 0.9), abc_top_k: Number(abc?.topK ?? 30), abc_repetition_penalty: Number(abc?.repetitionPenalty ?? 1.005), top_p: Number(semantic?.topP ?? 0.95), top_k: Number(semantic?.topK ?? 100), repetition_penalty: Number(semantic?.repetitionPenalty ?? 1.2) };
    if (!Object.values(sampling).every(Number.isFinite) || sampling.abc_temperature < 0 || sampling.abc_temperature > 5 || sampling.abc_top_p <= 0 || sampling.abc_top_p > 1 || sampling.top_p <= 0 || sampling.top_p > 1 || !Number.isInteger(sampling.abc_top_k) || sampling.abc_top_k < 1 || !Number.isInteger(sampling.top_k) || sampling.top_k < 1 || sampling.abc_repetition_penalty <= 0 || sampling.repetition_penalty <= 0) throw new Error("高级采样参数无效。");
    return Object.freeze({ id, model: MUSIC_MODEL, style: draft.style.trim(), lyrics: outputType === "instrumental" ? "" : draft.lyrics.trim() ? draft.lyrics : connectedLyrics, cot, output_type: outputType, seed, cfg_scale: cfgScale, steps, temperature, abc: cot !== "off" && draft.abc.trim() ? draft.abc : null, format: draft.format, ...sampling });
}

export function hasResumableVideoTask(projectId: string, node: ReadonlyCanvasNode, localMode: boolean) {
    const task = node.metadata?.webVideoTask;
    return !localMode && !!task && !task.paused && isWebVideoTaskOwner(projectId, node, task);
}

export function resetWebVideoSubmission(node: CanvasNodeData): CanvasNodeData {
    if (!node.metadata?.webVideoSubmissionId) return node;
    const metadata = { ...node.metadata };
    delete metadata.webVideoSubmissionId;
    if (node.type === CanvasNodeType.Video && !metadata.webVideoTask) {
        metadata.status = "error";
        metadata.errorDetails = "未取得视频任务编号，请先核对已提交的生成，再决定是否重新生成。";
    }
    return { ...node, metadata };
}

export function resetInterruptedGeneration(nodes: CanvasNodeData[], projectId: string, localMode: boolean) {
    const current = nodes.map((original) => {
        const node = resetWebVideoSubmission(original);
        const tasks = node.metadata?.tasks;
        if (!tasks?.length) return node;
        const owned = tasks.filter((task) => localMode && isCanvasTaskBinding(projectId, node, task));
        return owned.length === tasks.length ? node : { ...node, metadata: { ...node.metadata, tasks: owned } };
    });
    const activeNodes = new Set<string>();
    for (const node of current) {
        for (const binding of node.metadata?.tasks ?? []) {
            activeNodes.add(node.id);
            activeNodes.add(binding.sourceId);
        }
        const task = node.metadata?.webVideoTask;
        if (task && hasResumableVideoTask(projectId, node, localMode)) {
            activeNodes.add(node.id);
            activeNodes.add(task.sourceId);
        }
        if (
            hasResumableCloudVideoTask(node)
            || hasResumableImageTask(node)
            || hasResumableMusicTask(node)
            || (node.type === CanvasNodeType.Music && Boolean(node.metadata?.musicAnalysisId) && (node.metadata?.musicAnalysisStatus === "queued" || node.metadata?.musicAnalysisStatus === "running"))
            || Boolean(node.metadata?.fireRedTaskId)
        ) {
            activeNodes.add(node.id);
        }
    }
    return current.map<CanvasNodeData>((node) => {
        if (node.metadata?.status !== "loading" || activeNodes.has(node.id)) return node;
        const hasResult = (node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio || node.type === CanvasNodeType.Music) && hasNodeMedia(node);
        return {
            ...node, metadata: {
                ...node.metadata,
                status: hasResult ? "success" : "error",
                errorDetails: hasResult ? undefined : "页面刷新后生成已中断，请重新生成。",
                images: node.metadata.images?.map((image) => (image.status === "loading" && !image.taskId ? { ...image, status: "error" as const, errorDetails: "页面刷新后生成已中断，请重新生成。" } : image)),
                texts: node.metadata.texts?.map((text) => (text.status === "loading" ? { ...text, status: "error" as const, errorDetails: "页面刷新后生成已中断，请重新生成。" } : text)),
            },
        };
    });
}

export function isGenerationCanceled(error: unknown) {
    if (error instanceof ModelExecutionError && error.code === "MODEL_TASK_CANCELLED") return true;
    if (error instanceof PluginError && ["PLUGIN_PROJECT_CHANGED", "PLUGIN_SCOPE_CLOSED", "PLUGIN_INACTIVE"].includes(error.code)) return true;
    return error instanceof Error && (error.message === "请求已取消" || error.name === "AbortError" || error.name === "CanceledError");
}

export function sourceNodeReferenceImages(node: CanvasNodeData | null, binding?: ScopeBinding) {
    if (!node) return [];
    const resource = readNodeResource(node, "execute", binding);
    if (resource?.kind !== "image" || !(resource.storageKey || resource.url)) return [];
    return [
        {
            id: node.id,
            name: `${node.title || node.id}.png`,
            type: node.metadata?.mimeType || "image/png",
            dataUrl: resource.url,
            storageKey: resource.storageKey,
        },
    ];
}

export function isAudioFile(file: File) {
    return file.type.startsWith("audio/") || /\.(mp3|wav)$/i.test(file.name);
}

export function buildAngleLabel(params: ImageAngleParams) {
    const horizontal = params.horizontalAngle === 0 ? "正面视角" : params.horizontalAngle > 0 ? `向右旋转 ${params.horizontalAngle} 度` : `向左旋转 ${Math.abs(params.horizontalAngle)} 度`;
    const pitch = params.pitchAngle === 0 ? "水平视角" : params.pitchAngle > 0 ? `俯视 ${params.pitchAngle} 度` : `仰视 ${Math.abs(params.pitchAngle)} 度`;
    return `AI 多角度：${horizontal}，${pitch}，镜头距离 ${params.cameraDistance.toFixed(1)}，${(params.wideAngle ? "广角" : "标准")}镜头`;
}

export function buildAnglePrompt(params: ImageAngleParams) {
    return `基于参考图重新生成同一主体的新视角，保持主体、颜色、材质和画面风格一致，不要只做透视变形。${buildAngleLabel(params)}。`;
}
