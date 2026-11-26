import { nanoid } from "nanoid";

import { COMFYUI_PROXY_PATH, QWEN_IMAGE_21_DEFAULT_STEPS } from "@workbench/constant/comfyui";
import { dataUrlToFile } from "@workbench/lib/image-utils";
import { parseAspectRatio, parsePixelSize } from "@workbench/lib/media-size";
import { imageToDataUrl } from "@workbench/services/image-storage";
import { buildQwenImageWorkflow, type QwenImageWorkflowInput } from "./comfyui-qwen-workflow";
import type { ReferenceImage } from "@workbench/types/image";
import type { AiConfig } from "@workbench/stores/use-config-store";

type OutputFile = { filename: string; subfolder: string; type: string };
type HistoryEntry = {
    outputs?: Record<string, Record<string, unknown>>;
    status?: { completed: boolean; status_str: string; messages?: Array<[string, { exception_message?: string; node_type?: string }]> };
};
type ComfyError = { error?: { message?: string }; node_errors?: Record<string, { errors?: Array<{ details?: string; message?: string }> }> };
const POLL_INTERVAL_MS = 2500;
const QWEN_IMAGE_TIMEOUT_MS = 10 * 60_000;

export type QwenGeneratedImage = { id: string; dataUrl: string };

class ComfyHttpError extends Error {
    constructor(public status: number, public data: ComfyError | null) {
        super(formatComfyError(status, data));
    }
}

function formatComfyError(status: number, data: ComfyError | null) {
    if (data && typeof data === "object") {
        const details = Object.values(data.node_errors || {}).flatMap((node) => (node.errors || []).map((item) => item.details || item.message)).filter(Boolean);
        return [data.error?.message, ...details].filter(Boolean).join("；") || `ComfyUI 请求失败（${status}）。`;
    }
    return status === 404
        ? "ComfyUI 转发入口不可用，请使用项目的本地启动方式，并确认能够访问云端 Jupyter。"
        : `无法连接云端 ComfyUI${status ? `（${status}）` : ""}，请检查网络和云端服务。`;
}

async function comfyFetch(path: string, init: RequestInit = {}) {
    const response = await fetch(`${COMFYUI_PROXY_PATH}${path}`, init);
    if (!response.ok) {
        let data: ComfyError | null = null;
        try { data = await response.json() as ComfyError; } catch { /* ignore */ }
        throw new ComfyHttpError(response.status, data);
    }
    return response;
}

export async function runQwenImageGeneration(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, signal?: AbortSignal, onTaskIds?: (ids: string[]) => void): Promise<QwenGeneratedImage[]> {
    const ids = await createQwenImageTasks(config, prompt, references, count, signal);
    onTaskIds?.(ids);
    return waitForQwenImageTasks(ids, signal);
}

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
        const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image, { signal }) })));
        const images = await Promise.all(files.map((file) => uploadReference(file, clientId, signal)));
        const plan = resolveQwenCanvasPlan(config, true);
        for (let index = 0; index < count; index += 1) graphs.push({ ...common, seed: seed + index, images, resolution: plan.budget, customLatent: plan.customLatent, width: plan.nativeWidth, height: plan.nativeHeight, upscaleLongEdge: plan.upscaleLongEdge });
    } else {
        const plan = resolveQwenCanvasPlan(config, false);
        graphs.push({ ...common, resolution: plan.budget, customLatent: true, width: plan.nativeWidth, height: plan.nativeHeight, upscaleLongEdge: plan.upscaleLongEdge });
    }
    return Promise.all(graphs.map((graph) => submitQwenPrompt(graph, signal)));
}

export async function waitForQwenImageTasks(ids: string[], signal?: AbortSignal): Promise<QwenGeneratedImage[]> {
    return collectQwenImages(ids, signal);
}

async function uploadReference(file: File, clientId: string, signal?: AbortSignal) {
    const body = new FormData();
    body.append("image", file, `${crypto.randomUUID()}-${file.name}`);
    body.append("type", "input");
    body.append("subfolder", `ai-creative-studio/${clientId}`);
    const data = await (await comfyFetch("/upload/image", { method: "POST", body, signal })).json() as { name: string; subfolder: string };
    if (!data.name) throw new Error("ComfyUI 未返回上传后的文件名。");
    return [data.subfolder, data.name].filter(Boolean).join("/");
}

async function submitQwenPrompt(graph: QwenImageWorkflowInput, signal?: AbortSignal) {
    const clientId = crypto.randomUUID();
    const data = await (await comfyFetch("/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: buildQwenImageWorkflow(graph), client_id: clientId }),
        signal,
    })).json() as { prompt_id?: string };
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
            const data = await (await comfyFetch(`/history/${encodeURIComponent(id)}`, { signal })).json() as Record<string, HistoryEntry>;
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
    const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type });
    const blob = await (await comfyFetch(`/view?${query.toString()}`, { signal })).blob();
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

export type QwenCanvasPlan = {
    followOriginal: boolean;
    customLatent: boolean;
    budget: number;
    width: number;
    height: number;
    nativeWidth: number;
    nativeHeight: number;
    upscaleLongEdge: number;
};

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

export const QWEN_IMAGE_4K_LONG_EDGE = 4096;

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
    return error instanceof Error ? error.message : "ComfyUI 请求失败。";
}
