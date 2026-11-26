import { nanoid } from "nanoid";
import { modelAssetUrl, type ModelAsset, ModelExecutionError } from "@infinite-canvas/shared/model-http";
import { modelConnectionFingerprint } from "@infinite-canvas/shared/channels";

import { H3_DEFAULT_STEPS, isMiniMaxH3, isMiniMaxH3Fast } from "@workbench/constant/comfyui";
import { isDreamMakerVideo } from "@workbench/constant/dreammaker";
import { dataUrlToFile } from "@workbench/lib/image-utils";
import { clampVideoSeconds, computeVideoSize, inferVideoRatio } from "@workbench/lib/media-size";
import { readMediaBlob, uploadMediaFile, type UploadedFile } from "@workbench/services/file-storage";
import { imageToDataUrl } from "@workbench/services/image-storage";
import { boolConfig, channelWrites, encodeGroupModel, findGroupModel, isBuiltinCloudModel, resolveModelRequestConfig, type AiConfig } from "@workbench/stores/use-config-store";
import { callScriptsReady } from "@workbench/stores/use-call-script-store";
import { createH3VideoTask, pollH3VideoTask } from "./comfyui-h3";
import { createDreamMakerVideoTask, pollDreamMakerVideoTask } from "./dreammaker";
import { models } from "./models/runtime";
import type { ModelRequestOptions, VideoGenerationResult, VideoGenerationTask, VideoGenerationTaskState } from "./models/types";
import type { ReferenceImage } from "@workbench/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@workbench/types/media";

type VideoMediaOptions = ModelRequestOptions & { videos?: ReferenceVideo[]; audios?: ReferenceAudio[] };

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: VideoMediaOptions): Promise<VideoGenerationResult> {
    return waitForVideoGenerationTask(config, await createVideoGenerationTask(config, prompt, references, options), options);
}

// 每笔任务的随机标识参与摘要，待查记录不保存渠道凭据。
export function videoChannelFingerprint(config: AiConfig, model: string, token: string) {
    if (isBuiltinCloudModel(model)) return `cloud:${model}`;
    const target = findGroupModel(config, model);
    if (!target?.model) throw new ModelExecutionError("MODEL_VIDEO_CONNECTION_CHANGED");
    return modelConnectionFingerprint(token, target.channel, target.group);
}

export async function waitForVideoGenerationTask(config: AiConfig | (() => Promise<AiConfig>), task: VideoGenerationTask, options?: ModelRequestOptions): Promise<VideoGenerationResult> {
    const isLongCloudTask = task.provider === "comfyui" || task.provider === "dreammaker";
    const maxAttempts = isLongCloudTask ? 360 : 120;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const current = typeof config === "function" ? await config() : config;
        options?.signal?.throwIfAborted();
        const state = await pollVideoGenerationTask(current, task, options);
        if (state.status === "completed") return { ...state.result, ...(state.upstreamTaskId ? { upstreamTaskId: state.upstreamTaskId } : {}) };
        if (state.status === "failed") {
            const error = new Error(state.error);
            error.name = "VideoTaskFailed";
            throw error;
        }
        if (attempt === maxAttempts - 1) break;
        await delay(2500, options?.signal);
    }
    throw new Error(isLongCloudTask ? "本轮查询已结束，云端任务可能仍在生成。任务编号已保留，请继续查询；不会重复生成。" : "视频生成超时，请稍后重试");
}

export function isVideoTaskFailed(error: unknown) {
    return error instanceof Error && error.name === "VideoTaskFailed";
}

export function isLocalVideoPending(error: unknown) {
    return error instanceof ModelExecutionError && ["MODEL_UNAVAILABLE", "MODEL_TASK_PAUSED", "MODEL_VIDEO_CONNECTION_CHANGED", "MODEL_LOCAL_VIDEO_CONNECTION_UNVERIFIED"].includes(error.code);
}

async function referenceMediaToFile(media: { url?: string; storageKey?: string; name?: string; type?: string }, fallbackName: string, signal?: AbortSignal): Promise<File> {
    const blob = await readMediaBlob(media.storageKey, media.url, { signal });
    if (!blob.size) throw new Error("参考媒体文件无效或已丢失");
    return new File([blob], media.name || fallbackName, { type: media.type || blob.type || "application/octet-stream" });
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], options?: VideoMediaOptions): Promise<VideoGenerationTask> {
    await Promise.all([callScriptsReady, channelWrites.flush()]);
    const selectedModel = (config.model || config.videoModel).trim();
    if (isDreamMakerVideo(selectedModel)) {
        const images = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image, { signal: options?.signal }) })));
        const videos = await Promise.all((options?.videos || []).map((video) => referenceMediaToFile(video, "ref.mp4", options?.signal)));
        const audios = await Promise.all((options?.audios || []).map((audio) => referenceMediaToFile(audio, "ref.mp3", options?.signal)));
        const task = await createDreamMakerVideoTask({ modelOption: selectedModel, prompt, config, images, videos, audios, signal: options?.signal });
        return { id: task.id, model: selectedModel, scriptId: "builtin:dreammaker", script: "", provider: "dreammaker", subApp: task.subApp };
    }
    if (isMiniMaxH3(selectedModel)) {
        const images = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image, { signal: options?.signal }) })));
        const videos = await Promise.all((options?.videos || []).map((video) => referenceMediaToFile(video, "ref.mp4", options?.signal)));
        const audios = await Promise.all((options?.audios || []).map((audio) => referenceMediaToFile(audio, "ref.mp3", options?.signal)));
        const fast = isMiniMaxH3Fast(selectedModel);
        const rawMode = config.videoMode;
        const mode = rawMode === "text" ? "text" : rawMode === "reference" || images.length > 2 || videos.length || audios.length ? "reference" : images.length ? "frames" : "text";
        const seconds = Number(clampVideoSeconds(config.videoSeconds || "6"));
        const targetSize = computeVideoSize(config.vquality || "720", inferVideoRatio(config.videoSize || config.size || "auto") === "auto" ? "16:9" : inferVideoRatio(config.videoSize || config.size || "auto"));
        const [w, h] = targetSize.split("x").map(Number);
        const resolutionNum = Math.max(w || 1280, h || 720);
        const upscale = resolutionNum > 1440 ? 2 : 0;
        const sampleWidth = upscale ? Math.round((w || 1280) / 2) : w || 1280;
        const sampleHeight = upscale ? Math.round((h || 720) / 2) : h || 720;
        const seedText = (config.videoSeed || "").trim();
        const seed = seedText ? Math.max(0, Math.floor(Number(seedText) || 0)) : crypto.getRandomValues(new Uint32Array(1))[0];
        const steps = Math.max(1, Math.round(Number(config.videoSteps) || H3_DEFAULT_STEPS));
        const taskId = await createH3VideoTask(
            {
                prompt,
                mode,
                width: sampleWidth,
                height: sampleHeight,
                seconds,
                seed,
                steps,
                fast,
                hd: boolConfig(config.videoHd, false),
                upscale,
                refImageSize: config.videoRefImageSize === "max" ? "max" : "match",
                generateAudio: boolConfig(config.videoGenerateAudio, true),
                images,
                videos,
                audios,
            },
            options?.signal,
        );
        return { id: taskId, model: selectedModel, scriptId: "builtin:comfyui-h3", script: "", provider: "comfyui" };
    }
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const ratio = inferVideoRatio(config.videoSize || config.size);
    const result = await models.createVideoTask({
        call: requestConfig, prompt,
        images: references.map((image) => ({ url: image.url || image.dataUrl, storageKey: image.storageKey })),
        videos: options?.videos?.map((video) => ({ url: video.url, storageKey: video.storageKey })),
        audios: options?.audios?.map((audio) => ({ url: audio.url, storageKey: audio.storageKey })),
        options: { seconds: clampVideoSeconds(config.videoSeconds), size: normalizeVideoSize(config.videoSize || config.size, config.vquality), resolution: normalizeVideoResolution(config.vquality), ratio: ratio === "auto" ? "16:9" : ratio, generateAudio: boolConfig(config.videoGenerateAudio, true), watermark: boolConfig(config.videoWatermark, false), mode: resolveVideoMode(config.videoMode, references.length) },
    }, options);
    const identity = { model: encodeGroupModel(requestConfig.groupId, requestConfig.model), scriptId: requestConfig.scriptId, script: requestConfig.script };
    return "id" in result ? { ...identity, id: result.id } : { ...identity, id: nanoid(), result: result.result };
}

export async function waitForLocalVideo(taskId: string, options?: ModelRequestOptions & { resume?: boolean }): Promise<VideoGenerationResult> {
    const snapshot = await models.tasks!.wait(taskId, { signal: options?.signal, target: options?.target, resume: options?.resume, onTerminalFailure: options?.onTerminal });
    const asset = snapshot.result as ModelAsset;
    return { url: modelAssetUrl(asset), mimeType: asset.mimeType };
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: ModelRequestOptions): Promise<VideoGenerationTaskState> {
    if (task.provider === "dreammaker") return pollDreamMakerVideoTask(task.model, task.id, task.subApp, options?.signal);
    if (task.provider === "comfyui") return pollH3VideoTask(task.id, options?.signal);
    if (models.tasks && !task.result) return { status: "completed", result: await waitForLocalVideo(task.id, options) };
    await Promise.all([callScriptsReady, channelWrites.flush()]);
    if (!task.scriptId) throw new ModelExecutionError("MODEL_CONFIG_MISSING");
    const requestConfig = resolveModelRequestConfig(config, task.model, task.scriptId);
    if (task.result) return { status: "completed", result: task.result };
    return models.queryVideoTask({ call: { ...requestConfig, script: task.script }, taskId: task.id }, options);
}

export async function storeGeneratedVideo(result: VideoGenerationResult, signal?: AbortSignal): Promise<UploadedFile> {
    const source = await resolveGeneratedVideo(result, signal);
    return "external" in source ? source.external : uploadMediaFile(source.input, "video", signal);
}

export async function resolveGeneratedVideo(result: VideoGenerationResult, signal?: AbortSignal): Promise<{ input: string | Blob } | { external: UploadedFile & { url: string } }> {
    signal?.throwIfAborted();
    if (result.blob) return { input: result.blob };
    if (result.url) {
        if (!/^https?:\/\//i.test(result.url) || !URL.canParse(result.url)) return { input: result.url };
        try {
            return { input: await readMediaBlob(undefined, result.url, { signal }) };
        } catch (error) {
            signal?.throwIfAborted();
            if (!(error instanceof TypeError)) throw new ModelExecutionError("MODEL_RESULT_MISSING");
            return { external: { url: result.url, bytes: 0, mimeType: result.mimeType || "video/mp4" } };
        }
    }
    throw new Error("视频接口没有返回可播放的视频");
}

function resolveVideoMode(mode: string | undefined, imageCount: number): "frames" | "reference" {
    if (mode === "reference" || imageCount > 2) return "reference";
    return "frames";
}

function normalizeVideoSize(value: string, resolution?: string) {
    if (value === "auto") return null;
    if (/^\d+x\d+$/.test(value || "")) return value;
    const ratio = inferVideoRatio(value || "16:9");
    if (ratio === "auto") return null;
    return computeVideoSize(resolution || "720", ratio);
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}
