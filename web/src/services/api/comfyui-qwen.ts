import axios from "axios";
import { nanoid } from "nanoid";

import { COMFYUI_PROXY_PATH, QWEN_IMAGE_21_DEFAULT_STEPS } from "@/constant/comfyui";
import { dataUrlToFile } from "@/lib/image-utils";
import { parseAspectRatio, parsePixelSize } from "@/lib/media-size";
import { imageToDataUrl } from "@/services/image-storage";
import { buildQwenImageWorkflow, type QwenImageWorkflowInput } from "./comfyui-qwen-workflow";
import type { ReferenceImage } from "@/types/image";
import type { AiConfig } from "@/stores/use-config-store";

type OutputFile = { filename: string; subfolder: string; type: string };
type HistoryEntry = {
    outputs?: Record<string, Record<string, unknown>>;
    status?: { completed: boolean; status_str: string; messages?: Array<[string, { exception_message?: string; node_type?: string }]> };
};
type ComfyError = { error?: { message?: string }; node_errors?: Record<string, { errors?: Array<{ details?: string; message?: string }> }> };
const api = axios.create({ baseURL: COMFYUI_PROXY_PATH });
const POLL_INTERVAL_MS = 2500;
const QWEN_IMAGE_TIMEOUT_MS = 10 * 60_000;

export type QwenGeneratedImage = { id: string; dataUrl: string };

/** 提交任务并等全部完成；onTaskIds 在云端受理后立刻回调，调用方可持久化以便刷新后恢复。 */
export async function runQwenImageGeneration(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, signal?: AbortSignal, onTaskIds?: (ids: string[]) => void): Promise<QwenGeneratedImage[]> {
    const ids = await createQwenImageTasks(config, prompt, references, count, signal);
    onTaskIds?.(ids);
    return waitForQwenImageTasks(ids, signal);
}

/** 上传参考图并把生成图提交到云端队列，返回任务编号（顺序与请求张数一致）。 */
export async function createQwenImageTasks(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, signal?: AbortSignal): Promise<string[]> {
    const clientId = crypto.randomUUID();
    const seed = resolveSeed(config);
    const common = {
        prompt,
        negativePrompt: (config.imageNegative || "").trim(),
        width: 0,
        height: 0,
        customLatent: false,
        resolution: 0,
        steps: Math.max(1, Math.round(Number(config.imageSteps) || QWEN_IMAGE_21_DEFAULT_STEPS)),
        cfg: Math.max(1, Number(config.imageCfg) || 1),
        seed,
        count,
        images: [] as string[],
        upscaleLongEdge: 0,
        outputPrefix: `ai-creative-studio/${clientId}`,
    };
    const graphs: QwenImageWorkflowInput[] = [];
    if (references.length) {
        const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
        const images = await Promise.all(files.map((file) => uploadReference(file, clientId, signal)));
        // 编辑：仅「跟随原图/自动比例」沿用首图 latent；选定比例或宽高后按用户画布采样。
        const plan = resolveQwenCanvasPlan(config, true);
        for (let index = 0; index < count; index += 1) graphs.push({ ...common, seed: seed + index, images, resolution: plan.budget, customLatent: plan.customLatent, width: plan.nativeWidth, height: plan.nativeHeight, upscaleLongEdge: plan.upscaleLongEdge });
    } else {
        const plan = resolveQwenCanvasPlan(config, false);
        graphs.push({ ...common, resolution: plan.budget, customLatent: true, width: plan.nativeWidth, height: plan.nativeHeight, upscaleLongEdge: plan.upscaleLongEdge });
    }
    return Promise.all(graphs.map((graph) => submitQwenPrompt(graph, signal)));
}

/** 轮询云端任务直到全部完成并下载为 dataURL；任务失败抛错，超时抛错但任务仍在云端继续。 */
export async function waitForQwenImageTasks(ids: string[], signal?: AbortSignal): Promise<QwenGeneratedImage[]> {
    return collectQwenImages(ids, signal);
}

async function uploadReference(file: File, clientId: string, signal?: AbortSignal) {
    const body = new FormData();
    body.append("image", file, `${crypto.randomUUID()}-${file.name}`);
    body.append("type", "input");
    body.append("subfolder", `ai-creative-studio/${clientId}`);
    const { data } = await api.post<{ name: string; subfolder: string }>("/upload/image", body, { signal });
    if (!data.name) throw new Error("ComfyUI 未返回上传后的文件名。");
    return [data.subfolder, data.name].filter(Boolean).join("/");
}

async function submitQwenPrompt(graph: QwenImageWorkflowInput, signal?: AbortSignal) {
    const clientId = crypto.randomUUID();
    // 构建即校验：非法参数在本地抛错，不进 GPU 队列。
    const { data } = await api.post<{ prompt_id?: string }>("/prompt", { prompt: buildQwenImageWorkflow(graph), client_id: clientId }, { signal });
    if (!data.prompt_id) throw new Error("ComfyUI 没有返回任务编号，请检查云端队列后再试。");
    return data.prompt_id;
}

async function collectQwenImages(ids: string[], signal?: AbortSignal) {
    const deadline = Date.now() + QWEN_IMAGE_TIMEOUT_MS;
    const pending = new Set(ids);
    const files = new Map<string, OutputFile[]>();
    while (pending.size) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        if (Date.now() > deadline) throw new Error("云端生成超时，请稍后在 ComfyUI 队列中查看进度后重试。");
        for (const id of [...pending]) {
            const { data } = await api.get<Record<string, HistoryEntry>>(`/history/${encodeURIComponent(id)}`, { signal });
            const entry = data[id];
            if (entry?.status?.status_str === "error") {
                const failure = entry.status.messages?.findLast(([type]) => type === "execution_error" || type === "execution_interrupted");
                throw new Error(failure?.[1].exception_message || "ComfyUI 生成失败或任务被中断，请检查云端执行记录。");
            }
            if (!entry?.status?.completed) continue;
            const outputs = Object.values(entry.outputs || {}).flatMap((output) => (Array.isArray(output.images) ? (output.images as OutputFile[]) : []));
            if (!outputs.length) throw new Error("ComfyUI 已结束，但保存节点没有返回图片。");
            files.set(id, outputs);
            pending.delete(id);
        }
        if (pending.size) await delay(POLL_INTERVAL_MS, signal);
    }
    const images = await Promise.all(
        ids.flatMap((id) => files.get(id) || []).map(async (file) => ({ id: nanoid(), dataUrl: await downloadImage(file, signal) })),
    );
    if (!images.length) throw new Error("ComfyUI 没有返回图片。");
    return images;
}

async function downloadImage(file: OutputFile, signal?: AbortSignal) {
    const { data: blob } = await api.get<Blob>("/view", { params: file, responseType: "blob", signal });
    if (!blob.size || /json|html/i.test(blob.type)) throw new Error("ComfyUI 返回的内容不是图片，请重试。");
    return blobToDataUrl(blob);
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取生成图片失败。"));
        reader.readAsDataURL(blob);
    });
}

/** 画布计划：面板预览与提交链路共用同一份数学，保证所见即所采样。 */
export type QwenCanvasPlan = {
    /** 编辑模式保持第 1 张参考图原始尺寸（预算 0）。 */
    followOriginal: boolean;
    /** 是否在用户指定的空画布上采样（文生图恒为 true；编辑需用户选定比例或宽高）。 */
    customLatent: boolean;
    /** 参考图像素预算（跟随原图为 0）。 */
    budget: number;
    /** 最终输出宽高（4K 档为超分后；跟随/自动为 0，由运行时跟随首图决定）。 */
    width: number;
    height: number;
    /** 原生采样宽高（4K 档折半）。 */
    nativeWidth: number;
    nativeHeight: number;
    upscaleLongEdge: number;
};

/**
 * 解析输出画布：显式 WxH 优先（长边 ≥3072 触发折半采样 + SeedVR2 超分）；
 * 否则按 分辨率档 × 比例 计算（4K 档 = 长边 4096）。编辑模式下宽高比为「自动」
 * 或选择「跟随原图」时不使用自定义画布，输出跟随第 1 张参考图。
 */
export function resolveQwenCanvasPlan(config: AiConfig, editing: boolean): QwenCanvasPlan {
    const tier = resolveResolutionTier(config);
    const followOriginal = editing && tier.budget === 0;
    const size = (config.size || "auto").trim();
    const pixels = parsePixelSize(size);
    const explicitRatio = parseAspectRatio(size);
    const customLatent = !editing || (!followOriginal && Boolean(pixels || explicitRatio));
    const base = { budget: tier.budget, followOriginal, customLatent, width: 0, height: 0, nativeWidth: 0, nativeHeight: 0, upscaleLongEdge: tier.is4k ? QWEN_IMAGE_4K_LONG_EDGE : 0 };
    if (!customLatent) return base;
    const ratio = pixels || explicitRatio || { width: 1, height: 1 };
    if (pixels) {
        const width = alignQwen32(pixels.width);
        const height = alignQwen32(pixels.height);
        if (Math.max(width, height) < 3072) return { ...base, width, height, nativeWidth: width, nativeHeight: height, upscaleLongEdge: 0 };
        return { ...base, width, height, nativeWidth: alignQwen32(width / 2), nativeHeight: alignQwen32(height / 2), upscaleLongEdge: Math.max(width, height) };
    }
    if (tier.is4k) {
        const shortSide = alignQwen32((QWEN_IMAGE_4K_LONG_EDGE * Math.min(ratio.width, ratio.height)) / Math.max(ratio.width, ratio.height));
        const width = ratio.width >= ratio.height ? QWEN_IMAGE_4K_LONG_EDGE : shortSide;
        const height = ratio.width >= ratio.height ? shortSide : QWEN_IMAGE_4K_LONG_EDGE;
        return { ...base, width, height, nativeWidth: alignQwen32(width / 2), nativeHeight: alignQwen32(height / 2) };
    }
    const budget = tier.budget || 1024;
    const aspect = ratio.width / ratio.height;
    const width = alignQwen32(Math.sqrt(budget * budget * aspect));
    const height = alignQwen32(Math.sqrt(budget * budget / aspect));
    return { ...base, width, height, nativeWidth: width, nativeHeight: height, upscaleLongEdge: 0 };
}

/** 4K 超分档的目标长边。 */
export const QWEN_IMAGE_4K_LONG_EDGE = 4096;

/** 统一分辨率档：「跟随原图」(0) 在文生图下按 1K；自定义值钳制在 256–2048，≥4096 视为 4K 超分档。 */
function resolveResolutionTier(config: AiConfig): { budget: number; is4k: boolean } {
    const value = (config.imageResolution || "").trim();
    if (value === "0" || value === "original") return { budget: 0, is4k: false };
    const budget = align32(Math.round(Number(value) || 1024));
    if (budget >= QWEN_IMAGE_4K_LONG_EDGE) return { budget: 2048, is4k: true };
    return { budget: Math.min(2048, Math.max(256, budget)), is4k: false };
}

function resolveSeed(config: AiConfig) {
    const value = config.imageSeed?.trim();
    if (!value) return crypto.getRandomValues(new Uint32Array(1))[0];
    const seed = Number(value);
    if (!Number.isSafeInteger(seed) || seed < 0) throw new Error("随机种子需要是可精确表示的非负整数，请减小数值或留空随机。");
    return seed;
}

function align32(value: number) {
    return Math.min(4096, Math.max(256, Math.ceil(value / 32) * 32));
}

/** Qwen 采样画布的 32 对齐（面板预览与提交共用）。 */
export function alignQwen32(value: number) {
    return align32(value);
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
    });
}

export function qwenComfyError(error: unknown) {
    if (!axios.isAxiosError(error)) return error instanceof Error ? error.message : "ComfyUI 请求失败。";
    const data = error.response?.data as ComfyError | undefined;
    if (data && typeof data === "object") {
        const details = Object.values(data.node_errors || {}).flatMap((node) => (node.errors || []).map((item) => item.details || item.message)).filter(Boolean);
        return [data.error?.message, ...details].filter(Boolean).join("；") || `ComfyUI 请求失败（${error.response?.status}）。`;
    }
    return error.response?.status === 404
        ? "ComfyUI 转发入口不可用，请使用项目的本地启动方式，并确认能够访问云端 Jupyter。"
        : `无法连接云端 ComfyUI${error.response?.status ? `（${error.response.status}）` : ""}，请检查网络和云端服务。`;
}
