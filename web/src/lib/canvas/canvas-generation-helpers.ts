import { defaultConfig, resolveModelForCapability, type AiConfig } from "@/stores/use-config-store";
import i18n from "@/i18n";
import { DEFAULT_MUSIC_DRAFT, MUSIC_MODEL, type MusicGenerationDraft, type MusicGenerationRequest } from "@/constant/music";
import { ensureImagePreview, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { imageMetadata, referenceUrl } from "@/lib/canvas/canvas-node-factory";
import type { NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import type { CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import type { ReferenceImage } from "@/types/image";
import { CanvasNodeType, type CanvasAssistantSession, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

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

export function generationReferenceUrls(context: { referenceImages: ReferenceImage[]; referenceVideos: Array<{ storageKey?: string; url?: string }>; referenceAudios?: Array<{ storageKey?: string; url?: string }> }) {
    return [
        ...context.referenceImages.map(referenceUrl).filter((url): url is string => Boolean(url)),
        ...context.referenceVideos.map((video) => video.storageKey || video.url).filter((url): url is string => Boolean(url)),
        ...(context.referenceAudios || []).map((audio) => audio.storageKey || audio.url).filter((url): url is string => Boolean(url)),
    ];
}

export async function resolveMetadataReferences(metadata: CanvasNodeMetadata) {
    if (metadata.generationType !== "edit") return [];
    if (!metadata.references?.length) return null;
    const references = await Promise.all(
        metadata.references.map(async (url, index) => {
            const dataUrl = url.startsWith("image:") ? await resolveImageUrl(url, "") : url;
            return dataUrl ? { id: `${index}`, name: `reference-${index}.png`, type: "image/png", dataUrl, storageKey: url.startsWith("image:") ? url : undefined } : null;
        }),
    );
    return references.every(Boolean) ? (references as ReferenceImage[]) : null;
}

export async function hydrateCanvasImages(nodes: CanvasNodeData[]) {
    return Promise.all(
        nodes.map(async (node) => {
            const metadata = node.metadata;
            const content = metadata?.content;
            if ((node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio || node.type === CanvasNodeType.Music) && metadata?.storageKey) return { ...node, metadata: { ...metadata, content: await resolveMediaUrl(metadata.storageKey, node.type === CanvasNodeType.Music ? "" : content) } };
            if (node.type !== CanvasNodeType.Image || !metadata || !content) return node;
            const images = await Promise.all(
                (metadata.images || []).map(async (image) => {
                    if (!image.content) return image;
                    void ensureImagePreview(image.storageKey);
                    return { ...image, content: await resolveImageUrl(image.storageKey, image.content) };
                }),
            );
            if (metadata.storageKey) {
                void ensureImagePreview(metadata.storageKey);
                return { ...node, metadata: { ...metadata, content: await resolveImageUrl(metadata.storageKey, content), images } };
            }
            if (!content.startsWith("data:image/")) return node;
            return { ...node, metadata: { ...metadata, ...imageMetadata(await uploadImage(content)) } };
        }),
    );
}

export async function hydrateAssistantImages(sessions: CanvasAssistantSession[]) {
    const hydrateItem = async <T extends { dataUrl?: string; storageKey?: string }>(item: T) => {
        if (item.storageKey) return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        if (item.dataUrl?.startsWith("data:image/")) {
            const image = await uploadImage(item.dataUrl);
            return { ...item, dataUrl: image.url, storageKey: image.storageKey };
        }
        return item;
    };
    return Promise.all(
        sessions.map(async (session) => ({
            ...session,
            messages: await Promise.all(
                session.messages.map(async (message) => ({
                    ...message,
                    references: await Promise.all((message.references || []).map(hydrateItem)),
                })),
            ),
        })),
    );
}

export function getGenerationCount(count: string) {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(count)) || 1)));
}

export function getInputSummary(inputs: NodeGenerationInput[]) {
    const resources = [...new Map(inputs.flatMap((input) => (input.type === "group" ? input.children : [input])).map((input) => [input.nodeId, input])).values()];
    return {
        textCount: resources.filter((input) => input.type === "text").length,
        imageCount: resources.filter((input) => input.type === "image").length,
        videoCount: resources.filter((input) => input.type === "video").length,
        audioCount: resources.filter((input) => input.type === "audio").length,
    };
}

export function buildGenerationConfig(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasNodeGenerationMode): AiConfig {
    return {
        ...config,
        model: resolveModelForCapability(config, node?.metadata?.model, mode),
        reasoningEffort: node?.metadata?.reasoningEffort || config.reasoningEffort || defaultConfig.reasoningEffort,
        quality: node?.metadata?.quality || config.quality || defaultConfig.quality,
        size: node?.metadata?.size || config.size || defaultConfig.size,
        background: node?.metadata?.background ?? config.background ?? defaultConfig.background,
        imageSteps: node?.metadata?.imageSteps ?? config.imageSteps ?? defaultConfig.imageSteps,
        imageCfg: node?.metadata?.imageCfg ?? config.imageCfg ?? defaultConfig.imageCfg,
        imageSeed: node?.metadata?.imageSeed ?? config.imageSeed ?? defaultConfig.imageSeed,
        imageNegative: node?.metadata?.imageNegative ?? config.imageNegative ?? defaultConfig.imageNegative,
        imageResolution: node?.metadata?.imageResolution ?? config.imageResolution ?? defaultConfig.imageResolution,
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

export function musicDraftFromRequest(request: MusicGenerationRequest): MusicGenerationDraft {
    return { style: request.style, lyrics: request.lyrics, cot: request.cot, outputType: request.output_type || "song", seed: request.seed === null ? "" : String(request.seed), cfgScale: request.cfg_scale === null ? "" : String(request.cfg_scale), steps: String(request.steps), temperature: String(request.temperature), abc: request.abc || "", format: request.format, creationMode: request.reference?.mode || "original", abcSampling: { temperature: String(request.abc_temperature ?? 0.7), topP: String(request.abc_top_p ?? 0.9), topK: String(request.abc_top_k ?? 30), repetitionPenalty: String(request.abc_repetition_penalty ?? 1.005) }, semanticSampling: { topP: String(request.top_p ?? 0.95), topK: String(request.top_k ?? 100), repetitionPenalty: String(request.repetition_penalty ?? 1.2) } };
}

export function readMusicDraft(metadata?: CanvasNodeMetadata): MusicGenerationDraft {
    return metadata?.musicDraft || (metadata?.musicRequest ? musicDraftFromRequest(metadata.musicRequest) : DEFAULT_MUSIC_DRAFT);
}

export function selectMusicReference(node: CanvasNodeData, references: CanvasNodeData[]) {
    return references.find((reference) => reference.id === readMusicDraft(node.metadata).referenceNodeId) || (references.length === 1 ? references[0] : undefined);
}

export function readMusicReferenceAnalysis(node: CanvasNodeData, reference?: CanvasNodeData) {
    const metadata = node.metadata;
    return reference && metadata?.musicAnalysisId && metadata.musicAnalysisStatus === "completed" && metadata.musicAnalysisNodeId === reference.id && metadata.musicAnalysisStorageKey === (reference.metadata?.storageKey || reference.metadata?.content) ? metadata.musicAnalysis : undefined;
}

export function buildMusicGenerationRequest(id: string, draft: MusicGenerationDraft, connectedLyrics = ""): MusicGenerationRequest {
    const seed = draft.seed.trim() ? Number(draft.seed) : null;
    const cfgScale = draft.cfgScale.trim() ? Number(draft.cfgScale) : null;
    const steps = Number(draft.steps);
    const temperature = Number(draft.temperature);
    const outputType = draft.outputType || "song";
    const cot = outputType === "instrumental" && draft.cot === "off" ? "full" : draft.cot;
    if (!draft.style.trim()) throw new Error(i18n.t("canvas.music.styleRequired"));
    if (seed !== null && (!Number.isSafeInteger(seed) || seed < 0)) throw new Error(i18n.t("canvas.music.invalidSeed"));
    if (!Number.isInteger(steps) || steps <= 0) throw new Error(i18n.t("canvas.music.invalidSteps"));
    if (cfgScale !== null && (!Number.isFinite(cfgScale) || cfgScale < 0 || cfgScale > 20)) throw new Error(i18n.t("canvas.music.invalidCfg"));
    if (!draft.temperature.trim() || !Number.isFinite(temperature) || temperature < 0 || temperature > 5) throw new Error(i18n.t("canvas.music.invalidTemperature"));
    const abc = draft.abcSampling;
    const semantic = draft.semanticSampling;
    const sampling = { abc_temperature: Number(abc?.temperature ?? 0.7), abc_top_p: Number(abc?.topP ?? 0.9), abc_top_k: Number(abc?.topK ?? 30), abc_repetition_penalty: Number(abc?.repetitionPenalty ?? 1.005), top_p: Number(semantic?.topP ?? 0.95), top_k: Number(semantic?.topK ?? 100), repetition_penalty: Number(semantic?.repetitionPenalty ?? 1.2) };
    if (!Object.values(sampling).every(Number.isFinite) || sampling.abc_temperature < 0 || sampling.abc_temperature > 5 || sampling.abc_top_p <= 0 || sampling.abc_top_p > 1 || sampling.top_p <= 0 || sampling.top_p > 1 || !Number.isInteger(sampling.abc_top_k) || sampling.abc_top_k < 1 || !Number.isInteger(sampling.top_k) || sampling.top_k < 1 || sampling.abc_repetition_penalty <= 0 || sampling.repetition_penalty <= 0) throw new Error(i18n.t("canvas.music.invalidSampling"));
    return Object.freeze({ id, model: MUSIC_MODEL, style: draft.style.trim(), lyrics: outputType === "instrumental" ? "" : draft.lyrics.trim() ? draft.lyrics : connectedLyrics, cot, output_type: outputType, seed, cfg_scale: cfgScale, steps, temperature, abc: cot !== "off" && draft.abc.trim() ? draft.abc : null, format: draft.format, ...sampling });
}

export function hasResumableMusicTask(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Music && Boolean(node.metadata?.musicTaskId) && !node.metadata?.content && node.metadata?.musicTaskStatus !== "failed" && !node.metadata?.musicContentUnavailable;
}

export function hasResumableVideoTask(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Video && Boolean(node.metadata?.videoTaskId) && !node.metadata?.content;
}

/** 图片节点上还有挂了云端任务编号的生成中分片；刷新后可自动恢复查询。 */
export function hasResumableImageTask(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Image && Boolean(node.metadata?.images?.some((image) => image.status === "loading" && image.taskId));
}

export function resetInterruptedGeneration(nodes: CanvasNodeData[]) {
    return nodes.map((node) =>
        node.metadata?.status === "loading"
            ? hasResumableVideoTask(node) || hasResumableMusicTask(node) || hasResumableImageTask(node) || node.type === CanvasNodeType.Music && Boolean(node.metadata.musicAnalysisId) && (node.metadata.musicAnalysisStatus === "queued" || node.metadata.musicAnalysisStatus === "running")
                ? node
                : {
                      ...node,
                      metadata: {
                          ...node.metadata,
                          status: "error" as const,
                          errorDetails: i18n.t("canvas.generation.interrupted"),
                          images: node.metadata.images?.map((image) => (image.status === "loading" ? { ...image, status: "error" as const, errorDetails: i18n.t("canvas.generation.interrupted") } : image)),
                          texts: node.metadata.texts?.map((text) => (text.status === "loading" ? { ...text, status: "error" as const, errorDetails: i18n.t("canvas.generation.interrupted") } : text)),
                      },
                  }
            : node,
    );
}

export function isGenerationCanceled(error: unknown) {
    return error instanceof Error && (error.message === i18n.t("common.requestCanceled") || error.name === "AbortError");
}

export function findRetrySourceNode(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const queue = connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId);
    const visited = new Set<string>();
    while (queue.length) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const node = nodes.find((item) => item.id === id);
        if (node?.type === CanvasNodeType.Config) return node;
        connections.filter((connection) => connection.toNodeId === id).forEach((connection) => queue.push(connection.fromNodeId));
    }
    return null;
}

export function sourceNodeReferenceImages(node: CanvasNodeData | null) {
    if (!node || node.type !== CanvasNodeType.Image || !node.metadata?.content) return [];
    return [
        {
            id: node.id,
            name: `${node.title || node.id}.png`,
            type: node.metadata.mimeType || "image/png",
            dataUrl: node.metadata.content,
            storageKey: node.metadata.storageKey,
        },
    ];
}

export function isAudioFile(file: File) {
    return file.type.startsWith("audio/") || /\.(mp3|wav|flac)$/i.test(file.name);
}

export function buildAngleLabel(params: CanvasImageAngleParams) {
    const horizontal = params.horizontalAngle === 0 ? i18n.t("canvas.generation.front") : params.horizontalAngle > 0 ? i18n.t("canvas.generation.rotateRight", { angle: params.horizontalAngle }) : i18n.t("canvas.generation.rotateLeft", { angle: Math.abs(params.horizontalAngle) });
    const pitch = params.pitchAngle === 0 ? i18n.t("canvas.generation.level") : params.pitchAngle > 0 ? i18n.t("canvas.generation.topDown", { angle: params.pitchAngle }) : i18n.t("canvas.generation.lowAngle", { angle: Math.abs(params.pitchAngle) });
    return i18n.t("canvas.generation.angleLabel", { horizontal, pitch, distance: params.cameraDistance.toFixed(1), lens: i18n.t(params.wideAngle ? "canvas.editors.wide" : "canvas.editors.standard") });
}

export function buildAnglePrompt(params: CanvasImageAngleParams) {
    return i18n.t("canvas.generation.anglePrompt", { angle: buildAngleLabel(params) });
}
