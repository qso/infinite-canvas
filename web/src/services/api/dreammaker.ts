import axios from "axios";
import { nanoid } from "nanoid";

import {
    DREAMMAKER_API_PATH,
    DREAMMAKER_DOWNLOAD_PATH,
    DREAMMAKER_STATIC_ORIGIN,
    DREAMMAKER_STATIC_PATH,
    getDreamMakerImageSpec,
    getDreamMakerVideoSpec,
    type DreamMakerImageSpec,
    type DreamMakerVideoSpec,
} from "@/constant/dreammaker";
import { dataUrlToFile } from "@/lib/image-utils";
import { imageSizePresets, inferMediaRatio, inferVideoRatio, parseAspectRatio, parsePixelSize, parseVideoResolution } from "@/lib/media-size";
import { imageToDataUrl } from "@/services/image-storage";
import { boolConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { VideoGenerationResult, VideoGenerationTaskState } from "./video";

const IMAGE_POLL_INTERVAL_MS = 2500;
const IMAGE_POLL_TIMEOUT_MS = 10 * 60_000;

type GatewayResponse<T = Record<string, unknown>> = {
    code?: number;
    message?: string;
    msg?: string;
    data?: T;
    request_id?: string;
};

type TaskStatusData = {
    task_id?: string;
    upstream_task_id?: string;
    status?: string;
    progress?: number;
    output?: unknown;
    error?: unknown;
    message?: string;
};

export type DreamMakerImageOptions = {
    signal?: AbortSignal;
    onImageTaskIds?: (ids: string[]) => void;
    maskDataUrl?: string;
    bwMaskDataUrl?: string;
};

export type DreamMakerVideoInput = {
    modelOption: string;
    prompt: string;
    config: AiConfig;
    images: File[];
    videos: File[];
    audios: File[];
    signal?: AbortSignal;
};

export type DreamMakerVideoPollResult = VideoGenerationTaskState & {
    upstreamTaskId?: string;
};

function readGatewayError(payload: unknown, fallback: string): string {
    if (!payload) return fallback;
    if (typeof payload === "string") {
        try {
            return readGatewayError(JSON.parse(payload), payload);
        } catch {
            return payload.trim() || fallback;
        }
    }
    if (typeof payload !== "object") return fallback;
    const obj = payload as Record<string, unknown>;
    const nested = readGatewayError(obj.error, "");
    const message = [obj.message, obj.msg, nested].find((item) => typeof item === "string" && item.trim()) as string | undefined;
    return message || fallback;
}

function unwrapGatewayError(error: unknown, fallback: string): string {
    if (axios.isCancel(error)) return "请求已取消";
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    if (axios.isAxiosError(error)) {
        const data = error.response?.data;
        const msg = readGatewayError(data, "");
        if (msg) return msg;
        if (error.response?.status === 403) return "DreamMaker 模型未授权或无权限访问（403）";
        if (error.response?.status === 503) return "DreamMaker 凭据未配置或网关暂不可用（503）";
        return error.message || fallback;
    }
    return error instanceof Error ? error.message : fallback;
}

function toFullAssetUrl(value: string) {
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `${DREAMMAKER_STATIC_ORIGIN}/${trimmed.replace(/^\/+/, "")}`;
}

export async function uploadDreamMakerFile(file: File, signal?: AbortSignal): Promise<string> {
    const form = new FormData();
    form.append("file", file, file.name || `upload-${Date.now()}`);
    try {
        const { data } = await axios.post<GatewayResponse<{ url?: string }>>(`${DREAMMAKER_API_PATH}/v1/files`, form, {
            signal,
            timeout: 180_000,
        });
        if (data.code && data.code !== 0) throw new Error(readGatewayError(data, "DreamMaker 文件上传失败"));
        const url = data.data?.url;
        if (!url) throw new Error("DreamMaker 上传响应缺少文件地址");
        return String(url);
    } catch (error) {
        if (axios.isCancel(error) || signal?.aborted) throw error;
        throw new Error(unwrapGatewayError(error, "DreamMaker 文件上传失败"));
    }
}

async function submitDreamMakerTask(app: string, subApp: string, params: Record<string, unknown>, signal?: AbortSignal) {
    try {
        const query = new URLSearchParams({ sub_app_name: subApp });
        const { data } = await axios.post<GatewayResponse<{ task_id?: string }>>(
            `${DREAMMAKER_API_PATH}/v1/apps/${encodeURIComponent(app)}/run?${query.toString()}`,
            { batch_count: 1, params },
            { signal, timeout: 60_000 },
        );
        if (data.code && data.code !== 0) throw new Error(readGatewayError(data, "提交 DreamMaker 任务失败"));
        const taskId = String(data.data?.task_id || "");
        if (!taskId) throw new Error("DreamMaker 响应缺少任务编号 task_id");
        return taskId;
    } catch (error) {
        if (axios.isCancel(error) || signal?.aborted) throw error;
        throw new Error(unwrapGatewayError(error, "提交 DreamMaker 任务失败"));
    }
}

async function queryDreamMakerStatus(app: string, subApp: string, taskId: string, signal?: AbortSignal): Promise<TaskStatusData> {
    const query = new URLSearchParams({ sub_app_name: subApp, task_id: taskId });
    const { data } = await axios.get<GatewayResponse<TaskStatusData>>(
        `${DREAMMAKER_API_PATH}/v1/apps/${encodeURIComponent(app)}/status?${query.toString()}`,
        { signal, timeout: 30_000 },
    );
    if (data.code && data.code !== 0) throw new Error(readGatewayError(data, "查询 DreamMaker 任务状态失败"));
    return data.data || {};
}

function isJunkUrl(url: string) {
    const trimmed = url.trim();
    return !trimmed || trimmed === "【悠船】" || trimmed.endsWith("%E3%80%90%E6%82%A0%E8%88%B9%E3%80%91") || trimmed.endsWith("【悠船】");
}

function extractImageUrls(output: unknown): string[] {
    const urls: string[] = [];
    const walk = (node: unknown, parentKey = "") => {
        if (parentKey === "audits") return;
        if (Array.isArray(node)) {
            node.forEach((item) => walk(item, parentKey));
            return;
        }
        if (node && typeof node === "object") {
            for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, k);
            return;
        }
        if (typeof node === "string") {
            const s = node.trim();
            if (isJunkUrl(s)) return;
            if (/^(https?:\/\/|static\/)/i.test(s)) {
                const full = toFullAssetUrl(s);
                if (!urls.includes(full)) urls.push(full);
            }
        }
    };
    walk(output);
    return urls;
}

async function fetchAssetBlob(rawUrl: string, signal?: AbortSignal): Promise<Blob> {
    const full = toFullAssetUrl(rawUrl);
    const parsed = new URL(full);
    const candidates: string[] = [];
    if (parsed.pathname.startsWith("/static/")) {
        candidates.push(`${DREAMMAKER_STATIC_PATH}${parsed.pathname.slice("/static".length)}${parsed.search}`);
    }
    candidates.push(`${DREAMMAKER_DOWNLOAD_PATH}?url=${encodeURIComponent(full)}`);

    let lastError: unknown = null;
    for (const url of candidates) {
        try {
            const { data } = await axios.get<Blob>(url, { responseType: "blob", signal, timeout: 180_000 });
            if (!data.size) throw new Error("下载文件为空");
            if (/json|html/i.test(data.type)) throw new Error("返回内容不是有效媒体文件");
            // Check header bytes in case MIME type is generic octet-stream for an HTML 404 page
            const head = await data.slice(0, 64).text();
            if (/^\s*<(?:!doctype|html)/i.test(head)) throw new Error("下载返回了 HTML 页面");
            return data;
        } catch (error) {
            if (axios.isCancel(error) || signal?.aborted) throw error;
            lastError = error;
        }
    }
    throw new Error(unwrapGatewayError(lastError, "下载 DreamMaker 产物失败"));
}

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取图片数据失败"));
        reader.readAsDataURL(blob);
    });
}

function resolveGptImageSize(size: string): string {
    const trimmed = (size || "").trim();
    if (!trimmed || trimmed.toLowerCase() === "auto") return "auto";
    if (parsePixelSize(trimmed)) return trimmed;
    const ratio = parseAspectRatio(trimmed);
    if (ratio) {
        const preset = imageSizePresets["1k"][trimmed];
        if (preset) return preset;
        const landscape = ratio.width >= ratio.height;
        const longRatio = landscape ? ratio.width / ratio.height : ratio.height / ratio.width;
        const shortSide = 1024;
        const longSide = Math.round((shortSide * longRatio) / 16) * 16;
        return landscape ? `${longSide}x${shortSide}` : `${shortSide}x${longSide}`;
    }
    return "auto";
}

function normalizeArkTier(spec: DreamMakerImageSpec, rawTier: string | undefined) {
    const tiers = spec.arkTiers || ["1K", "2K"];
    const upper = (rawTier || "").trim().toUpperCase();
    if (tiers.includes(upper)) return upper;
    return tiers.includes("2K") ? "2K" : tiers[0];
}

function parseIntInRange(raw: string | undefined, min: number, max: number): number | undefined {
    const text = (raw || "").trim();
    if (!text) return undefined;
    const n = Number(text);
    if (!Number.isFinite(n)) return undefined;
    return Math.max(min, Math.min(max, Math.round(n)));
}

function parseFloatInRange(raw: string | undefined, min: number, max: number): number | undefined {
    const text = (raw || "").trim();
    if (!text) return undefined;
    const n = Number(text);
    if (!Number.isFinite(n)) return undefined;
    return Math.max(min, Math.min(max, n));
}

async function dataUrlToPngFile(dataUrl: string, name: string): Promise<File> {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    return new File([blob], name, { type: blob.type || "image/png" });
}

async function buildImageParams(
    spec: DreamMakerImageSpec,
    config: AiConfig,
    prompt: string,
    references: ReferenceImage[],
    count: number,
    options?: DreamMakerImageOptions,
): Promise<{ app: string; subApp: string; params: Record<string, unknown> }> {
    const signal = options?.signal;
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) throw new Error("请输入提示词");

    const uploadRefFiles = async (refs: ReferenceImage[]) => {
        const files = await Promise.all(refs.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
        return Promise.all(files.map((file) => uploadDreamMakerFile(file, signal)));
    };

    if (spec.family === "gpt") {
        const background = config.background === "transparent" ? "transparent" : "opaque";
        const outputFormat = background === "transparent" ? "png" : config.dmGptFormat || "png";
        const quality = ["low", "medium", "high", "xhigh", "max", "auto"].includes(config.quality) ? config.quality : "auto";
        const params: Record<string, unknown> = {
            model: spec.apiModel || spec.subApp,
            prompt: trimmedPrompt,
            n: Math.max(1, Math.min(15, count)),
            size: resolveGptImageSize(config.size),
            quality,
            output_format: outputFormat,
            background,
            moderation: config.dmGptModeration === "low" ? "low" : "auto",
        };
        if (options?.maskDataUrl && references.length >= 1) {
            const [uploadedImage] = await uploadRefFiles([references[0]]);
            const maskFile = await dataUrlToPngFile(options.maskDataUrl, "mask.png");
            const uploadedMask = await uploadDreamMakerFile(maskFile, signal);
            params.image = uploadedImage;
            params.mask = uploadedMask;
        } else if (references.length) {
            params.images = await uploadRefFiles(references);
        }
        return { app: spec.app, subApp: spec.subApp, params };
    }

    if (spec.family === "mj") {
        if (spec.supportsMaskPaint && options?.bwMaskDataUrl && references.length >= 1) {
            const [uploadedImage] = await uploadRefFiles([references[0]]);
            const maskFile = await dataUrlToPngFile(options.bwMaskDataUrl, "area_mask.png");
            const uploadedMask = await uploadDreamMakerFile(maskFile, signal);
            return {
                app: "mj",
                subApp: "upload_paint",
                params: {
                    image: uploadedImage,
                    area_mask: uploadedMask,
                    prompt: trimmedPrompt,
                    version: "8.1",
                    mode: "fast",
                },
            };
        }

        let mjPrompt = trimmedPrompt;
        const params: Record<string, unknown> = {};
        if (spec.niji) {
            params.niji = spec.niji;
            params.mode = config.dmMjMode === "turbo" ? "turbo" : "fast";
        } else if (spec.mjVersion === "8.2") {
            // dm CLI/网关兼容约定：8.2 不传 version 字段，通过 prompt 追加 --v 8.2
            if (!/--v(?:ersion)?\s+8\.2\b/i.test(mjPrompt)) mjPrompt = `${mjPrompt} --v 8.2`;
            params.mode = "fast";
        } else {
            params.version = "8.1";
            params.mode = "fast";
        }
        params.prompt = mjPrompt;

        const ratio = config.size && config.size !== "auto" ? inferMediaRatio(config.size, "") : "";
        if (ratio && ratio !== "auto") params.ar = ratio;

        const stylize = parseIntInRange(config.dmMjStylize, 0, 1000);
        if (stylize !== undefined) params.stylize = stylize;
        const chaos = parseIntInRange(config.dmMjChaos, 0, 100);
        if (chaos && chaos > 0) params.chaos = chaos;
        const weird = parseIntInRange(config.dmMjWeird, 0, 3000);
        if (weird && weird > 0) params.weird = weird;
        const seed = parseIntInRange(config.imageSeed, 0, 4294967295);
        if (seed !== undefined) params.seed = seed;
        if (config.imageNegative?.trim()) params.no = config.imageNegative.trim();

        if (!spec.niji) {
            const q = config.dmMjQuality === "1" || config.dmMjQuality === "4" ? Number(config.dmMjQuality) : 4;
            params.quality = q;
            const exp = parseIntInRange(config.dmMjExp, 0, 100);
            if (exp && exp > 0) params.exp = exp;
            if (config.dmMjRaw === "true") params.style = "raw";
            if (config.dmMjTile === "true") params.tile = true;
            if (config.dmMjHd === "true") params.img_quality = "2K";
        }

        if (references.length) {
            params.irefs = await uploadRefFiles(references);
            const iw = parseFloatInRange(config.dmMjIw, 0, spec.niji ? 2 : 3);
            if (iw !== undefined && iw !== 1) params.iw = iw;
        }
        return { app: spec.app, subApp: spec.subApp, params };
    }

    // Seedream (ark)
    const explicitPixels = parsePixelSize(config.size);
    const ratio = config.size && config.size !== "auto" ? inferMediaRatio(config.size, "smart") : "smart";
    const params: Record<string, unknown> = {
        model: spec.apiModel,
        prompt: trimmedPrompt,
        size: explicitPixels ? `${explicitPixels.width}x${explicitPixels.height}` : normalizeArkTier(spec, config.dmArkSizeTier),
        ar: explicitPixels ? ratio : config.size === "auto" ? "smart" : ratio,
    };
    const seed = parseIntInRange(config.imageSeed, 0, Number.MAX_SAFE_INTEGER);
    params.original_seed = seed !== undefined ? seed : -1;

    if (references.length) {
        params.image_list = await uploadRefFiles(references);
    }
    if (spec.supportsLayerDecomp && config.dmArkLayerDecomposition === "true" && references.length === 1) {
        params.layer_decomposition = true;
    }
    if (spec.supportsWebSearch && config.dmArkWebSearch === "true") {
        params.tools = JSON.stringify([{ type: "web_search" }]);
    }
    if (spec.supportsOptimizePrompt && (config.dmArkOptimizePrompt === "fast" || config.dmArkOptimizePrompt === "standard")) {
        params.optimize_prompt_options = { mode: config.dmArkOptimizePrompt };
    }

    return { app: spec.app, subApp: spec.subApp, params };
}

export async function runDreamMakerImageGeneration(
    config: AiConfig,
    prompt: string,
    references: ReferenceImage[],
    count: number,
    options?: DreamMakerImageOptions,
): Promise<Array<{ id: string; dataUrl: string }>> {
    const spec = getDreamMakerImageSpec(config.model || config.imageModel);
    if (!spec) throw new Error("未知的 DreamMaker 生图模型");

    const { app, subApp, params } = await buildImageParams(spec, config, prompt, references, count, options);
    const taskId = await submitDreamMakerTask(app, subApp, params, options?.signal);
    // Persist app/subApp alongside taskId so refresh recovery knows which endpoint to poll.
    const compositeTaskId = `${app}::${subApp}::${taskId}`;
    options?.onImageTaskIds?.([compositeTaskId]);
    return waitForDreamMakerImageTask(compositeTaskId, options?.signal);
}

export async function waitForDreamMakerImageTask(compositeOrRawTaskId: string, signal?: AbortSignal, fallbackModelOption?: string): Promise<Array<{ id: string; dataUrl: string }>> {
    let app = "";
    let subApp = "";
    let taskId = compositeOrRawTaskId;
    const parts = compositeOrRawTaskId.split("::");
    if (parts.length === 3) {
        [app, subApp, taskId] = parts;
    } else if (fallbackModelOption) {
        const spec = getDreamMakerImageSpec(fallbackModelOption);
        if (spec) {
            app = spec.app;
            subApp = spec.subApp;
        }
    }
    if (!app || !subApp || !taskId) throw new Error("缺少 DreamMaker 生图任务路由信息");

    const deadline = Date.now() + IMAGE_POLL_TIMEOUT_MS;
    while (true) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const data = await queryDreamMakerStatus(app, subApp, taskId, signal);
        const status = String(data.status || "").toLowerCase();
        if (status === "success" || status === "succeeded" || status === "completed") {
            const urls = extractImageUrls(data.output);
            if (!urls.length) throw new Error("DreamMaker 生图已完成，但未返回有效图片地址");
            const dataUrls = await Promise.all(urls.map(async (url) => blobToDataUrl(await fetchAssetBlob(url, signal))));
            return dataUrls.map((dataUrl) => ({ id: nanoid(), dataUrl }));
        }
        if (status === "failed" || status === "error" || status === "stopped" || status === "cancelled" || status === "canceled") {
            throw new Error(readGatewayError(data, `DreamMaker 生图失败（${status}）`));
        }
        if (Date.now() >= deadline) {
            throw new Error("DreamMaker 生图查询超时，云端可能仍在生成，任务编号已保留。");
        }
        await delay(IMAGE_POLL_INTERVAL_MS, signal);
    }
}

function normalizeSeedanceResolution(spec: DreamMakerVideoSpec, raw: string | undefined) {
    const value = (raw || "").trim().toLowerCase();
    if (value === "480_draft" || value === "480p_draft") {
        return spec.resolutions.includes("480_draft") ? "480p_draft" : `${spec.defaultResolution}p`;
    }
    if (value === "2160" || value === "2160p" || value === "4k") {
        return spec.resolutions.includes("2160") ? "4k" : `${spec.defaultResolution}p`;
    }
    const clean = parseVideoResolution(value);
    if (spec.resolutions.includes(clean)) return `${clean}p`;
    return `${spec.defaultResolution}p`;
}

function normalizeSeedanceSeconds(spec: DreamMakerVideoSpec, raw: string | undefined, subApp: string) {
    if (subApp === "edit") return -1;
    const trimmed = String(raw || "").trim();
    if (trimmed === "-1") return -1;
    const parsed = Math.ceil(Number(trimmed) || 5);
    if (parsed < 4 || parsed > spec.maxSeconds) {
        throw new Error(`${spec.displayModel} 视频时长需在 4~${spec.maxSeconds} 秒之间（或选择智能 -1）`);
    }
    return parsed;
}

function resolveSeedanceSubApp(spec: DreamMakerVideoSpec, config: AiConfig, imagesCount: number, videosCount: number, audiosCount: number) {
    const mode = (config.videoMode || "").trim();
    if (mode === "edit") {
        if (!spec.supportsEditExtend) throw new Error(`视频编辑模式仅支持 Seedance 2.5 / 2.5 Flash`);
        if (!videosCount) throw new Error("视频编辑模式至少需要连接 1 个参考视频");
        return "edit";
    }
    if (mode === "extend") {
        if (!spec.supportsEditExtend) throw new Error(`视频延长模式仅支持 Seedance 2.5 / 2.5 Flash`);
        if (!videosCount) throw new Error("视频延长模式至少需要连接 1 个参考视频");
        return "extend";
    }
    if (mode === "text") return "text_to_video";
    if (mode === "reference" || imagesCount > 2 || videosCount > 0 || audiosCount > 0) return "reference";
    if (mode === "frames") {
        if (!imagesCount) throw new Error("图生视频（首尾帧）模式至少需要连接 1 张首帧图片");
        return "image_to_video";
    }
    if (imagesCount) return "image_to_video";
    return "text_to_video";
}

export async function createDreamMakerVideoTask(input: DreamMakerVideoInput): Promise<{ id: string; subApp: string }> {
    const spec = getDreamMakerVideoSpec(input.modelOption);
    if (!spec) throw new Error("未知的 DreamMaker 视频模型");

    const { prompt, config, images, videos, audios, signal } = input;
    const trimmedPrompt = prompt.trim();

    if (spec.family === "h3") {
        if (!trimmedPrompt) throw new Error("MiniMax H3（DreamMaker）需要填写视频提示词");
        const mode = config.videoMode === "text" ? "text" : config.videoMode === "reference" || images.length > 2 || videos.length || audios.length ? "reference" : images.length ? "frames" : "text";
        if (mode === "frames" && !images.length) throw new Error("图生视频模式至少需要连接 1 张首帧图片");
        const ratio = inferVideoRatio(config.size || "auto");
        if (mode === "text" && ratio === "auto") {
            // 纯文生视频必须显式指定非 adaptive 比例
        }
        const duration = Math.max(4, Math.min(15, Math.ceil(Number(config.videoSeconds) || 5)));
        const resolution = parseVideoResolution(config.vquality) === "768" ? "768P" : "2K";

        const media: Array<{ type: string; url: string; id?: string; name?: string }> = [];
        if (mode === "frames") {
            const uploaded = await Promise.all(images.slice(0, 2).map((file) => uploadDreamMakerFile(file, signal)));
            if (uploaded[0]) media.push({ type: "first_frame", url: toFullAssetUrl(uploaded[0]) });
            if (uploaded[1]) media.push({ type: "last_frame", url: toFullAssetUrl(uploaded[1]) });
        } else if (mode === "reference") {
            const [upImgs, upVids, upAuds] = await Promise.all([
                Promise.all(images.map((file) => uploadDreamMakerFile(file, signal))),
                Promise.all(videos.map((file) => uploadDreamMakerFile(file, signal))),
                Promise.all(audios.map((file) => uploadDreamMakerFile(file, signal))),
            ]);
            upImgs.forEach((u, i) => media.push({ type: "reference_image", url: toFullAssetUrl(u), id: `Picture ${i + 1}`, name: images[i]?.name }));
            upVids.forEach((u, i) => media.push({ type: "reference_video", url: toFullAssetUrl(u), id: `Video ${i + 1}`, name: videos[i]?.name }));
            upAuds.forEach((u, i) => media.push({ type: "reference_audio", url: toFullAssetUrl(u), id: `Audio ${i + 1}`, name: audios[i]?.name }));
        }

        const params: Record<string, unknown> = {
            prompt: trimmedPrompt,
            resolution,
            ratio: ratio === "auto" ? (mode === "text" ? "16:9" : "adaptive") : ratio,
            duration,
            watermark: boolConfig(config.videoWatermark, false),
        };
        if (media.length) params.media = media;

        const subApp = spec.subApp || "minimax-h3-video";
        const taskId = await submitDreamMakerTask(spec.app, subApp, params, signal);
        return { id: taskId, subApp };
    }

    // Seedance (jimeng-video)
    const subApp = resolveSeedanceSubApp(spec, config, images.length, videos.length, audios.length);
    if (subApp === "text_to_video" && !trimmedPrompt) throw new Error("文生视频需要填写提示词");
    if (subApp === "edit" && !trimmedPrompt) throw new Error("视频编辑需要填写编辑指令提示词");
    const totalRefs = images.length + videos.length + audios.length;
    if (spec.modelName === "doubao-seedance-2-5" && totalRefs > 50) throw new Error("Seedance 2.5 参考素材总数不能超过 50 个");
    if (spec.modelName === "doubao-seedance-2-5-flash" && totalRefs > 20) throw new Error("Seedance 2.5 Flash 参考素材总数不能超过 20 个");

    const resolution = normalizeSeedanceResolution(spec, config.vquality);
    const duration = normalizeSeedanceSeconds(spec, config.videoSeconds, subApp);
    const seed = parseIntInRange(config.videoSeed, 0, Number.MAX_SAFE_INTEGER) ?? -1;

    const params: Record<string, unknown> = {
        task_mode: spec.modelName,
        model_name: spec.modelName,
        display_model: spec.displayModel,
        resolution,
        duration,
        seed,
        watermark: boolConfig(config.videoWatermark, false),
        generate_audio: boolConfig(config.videoGenerateAudio, true),
    };
    // 重要：首帧/首尾帧模式下禁止传 ratio（否则网关报 30107）；Seedance 系列也禁止传 camera_fixed（否则报 400）。
    if (subApp === "edit" || subApp === "extend") {
        params.ratio = "adaptive";
        params.aspect_ratio = "adaptive";
    } else if (subApp === "text_to_video" || subApp === "reference") {
        const ratio = inferVideoRatio(config.size || "auto");
        const resolvedRatio = ratio === "auto" ? (subApp === "text_to_video" ? "16:9" : "adaptive") : ratio;
        params.ratio = resolvedRatio;
        params.aspect_ratio = resolvedRatio;
    }
    if (trimmedPrompt) params.prompt = trimmedPrompt;

    if (subApp === "image_to_video") {
        const uploaded = await Promise.all(images.slice(0, 2).map((file) => uploadDreamMakerFile(file, signal)));
        params.image = uploaded[0];
        if (uploaded[1]) params.image_tail = uploaded[1];
    } else if (subApp === "reference" || subApp === "edit" || subApp === "extend") {
        const [upImgs, upVids, upAuds] = await Promise.all([
            Promise.all(images.map((file) => uploadDreamMakerFile(file, signal))),
            Promise.all(videos.map((file) => uploadDreamMakerFile(file, signal))),
            Promise.all(audios.map((file) => uploadDreamMakerFile(file, signal))),
        ]);
        if (upImgs.length) params.reference_image = upImgs.map(toFullAssetUrl);
        if (upVids.length) params.reference_video = upVids.map(toFullAssetUrl);
        if (upAuds.length) params.reference_audio = upAuds.map(toFullAssetUrl);
    }

    const taskId = await submitDreamMakerTask(spec.app, subApp, params, signal);
    return { id: taskId, subApp };
}

export async function promoteDreamMakerDraft(draftTaskId: string, resolution: "1080p" | "4k", signal?: AbortSignal): Promise<{ id: string; subApp: string }> {
    const params = {
        task_mode: "doubao-seedance-2-5",
        model_name: "doubao-seedance-2-5",
        display_model: "Seedance 2.5",
        resolution,
        draft_task_id: draftTaskId,
    };
    const taskId = await submitDreamMakerTask("jimeng-video", "draft", params, signal);
    return { id: taskId, subApp: "draft" };
}

function extractVideoItems(data: TaskStatusData): Array<{ origin_url?: string; url?: string }> {
    const out = data.output;
    if (out && typeof out === "object" && !Array.isArray(out) && Array.isArray((out as { output?: unknown }).output)) {
        return (out as { output: Array<{ origin_url?: string; url?: string }> }).output.filter((item) => item && typeof item === "object");
    }
    if (Array.isArray(out)) {
        return out.filter((item): item is { origin_url?: string; url?: string } => Boolean(item && typeof item === "object"));
    }
    return [];
}

async function downloadDreamMakerVideo(items: Array<{ origin_url?: string; url?: string }>, signal?: AbortSignal): Promise<VideoGenerationResult> {
    const candidates: string[] = [];
    for (const item of items) {
        // 优先签名直链 origin_url，避免 static/video/... 固定 403
        if (typeof item.origin_url === "string" && item.origin_url.trim()) candidates.push(item.origin_url.trim());
        if (typeof item.url === "string" && item.url.trim()) candidates.push(item.url.trim());
    }
    if (!candidates.length) throw new Error("DreamMaker 视频任务已完成，但未返回视频地址");

    let lastError: unknown = null;
    for (const rawUrl of candidates) {
        try {
            const blob = await fetchAssetBlob(rawUrl, signal);
            return { blob, mimeType: blob.type || "video/mp4" };
        } catch (error) {
            if (axios.isCancel(error) || signal?.aborted) throw error;
            lastError = error;
        }
    }
    throw new Error(unwrapGatewayError(lastError, "下载 DreamMaker 视频失败"));
}

export async function pollDreamMakerVideoTask(modelOption: string, taskId: string, subApp?: string, signal?: AbortSignal): Promise<DreamMakerVideoPollResult> {
    const spec = getDreamMakerVideoSpec(modelOption);
    if (!spec) return { status: "failed", error: "未知的 DreamMaker 视频模型" };
    const resolvedSubApp = subApp || spec.subApp || "image_to_video";

    try {
        const data = await queryDreamMakerStatus(spec.app, resolvedSubApp, taskId, signal);
        const status = String(data.status || "").toLowerCase();
        if (status === "success" || status === "succeeded" || status === "completed") {
            const items = extractVideoItems(data);
            const result = await downloadDreamMakerVideo(items, signal);
            return {
                status: "completed",
                result,
                upstreamTaskId: typeof data.upstream_task_id === "string" ? data.upstream_task_id : undefined,
            };
        }
        if (status === "failed" || status === "error" || status === "stopped" || status === "cancelled" || status === "canceled") {
            return { status: "failed", error: readGatewayError(data, `DreamMaker 视频生成失败（${status}）`) };
        }
        return { status: "pending" };
    } catch (error) {
        if (axios.isCancel(error) || signal?.aborted) throw error;
        throw new Error(unwrapGatewayError(error, "查询 DreamMaker 视频任务失败"));
    }
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
