import axios from "axios";
import { nanoid } from "nanoid";

import { COMFYUI_PROXY_PATH, QWEN_IMAGE_21_DEFAULT_STEPS } from "@/constant/comfyui";
import { dataUrlToFile } from "@/lib/image-utils";
import { computeMediaSize, inferMediaRatio, inferMediaScale, parsePixelSize } from "@/lib/media-size";
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

export async function runQwenImageGeneration(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, signal?: AbortSignal): Promise<Array<{ id: string; dataUrl: string }>> {
    const clientId = crypto.randomUUID();
    const seed = resolveSeed(config);
    const common = {
        prompt,
        negativePrompt: (config.imageNegative || "").trim(),
        width: 0,
        height: 0,
        resolution: resolveEditResolution(config),
        steps: Math.max(1, Math.round(Number(config.imageSteps) || QWEN_IMAGE_21_DEFAULT_STEPS)),
        cfg: Math.max(1, Number(config.imageCfg) || 1),
        seed,
        count,
        images: [] as string[],
        upscaleLongEdge: 0,
        outputPrefix: `ai-creative-studio/${clientId}`,
    };
    // 文生图按 batch 一次采样；图像编辑没有可复制的批量 latent，按张数提交多个任务。
    const graphs: QwenImageWorkflowInput[] = [];
    if (references.length) {
        const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
        const images = await Promise.all(files.map((file) => uploadReference(file, clientId, signal)));
        const upscale = is4kEditResolution(config) ? QWEN_IMAGE_4K_LONG_EDGE : 0;
        for (let index = 0; index < count; index += 1) graphs.push({ ...common, seed: seed + index, images, upscaleLongEdge: upscale });
    } else {
        const size = resolveOutputSize(config.size);
        // 4K 档：原生按目标一半采样（约 2K），再由 SeedVR2 超分到目标长边。
        const native = is4kSize(config.size) ? { width: align32(size.width / 2), height: align32(size.height / 2) } : size;
        graphs.push({ ...common, width: native.width, height: native.height, upscaleLongEdge: is4kSize(config.size) ? Math.max(size.width, size.height) : 0 });
    }
    const ids = await Promise.all(graphs.map((graph) => submitQwenPrompt(graph, signal)));
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

/** 文生图输出尺寸：优先显式 WxH，其次按比例+分辨率档位取预设，最后对齐到 32。 */
export function resolveOutputSize(size: string) {
    const pixels = parsePixelSize(size || "");
    const scale = inferMediaScale(size || "1:1");
    const computed = parsePixelSize(computeMediaSize(scale === "auto" ? "1k" : scale, inferMediaRatio(size || "1:1")));
    const source = pixels || computed || { width: 1024, height: 1024 };
    return { width: align32(source.width), height: align32(source.height) };
}

/** 图像编辑分辨率预算：0 表示保持参考图原始尺寸；4K(4096) 是超分档，原生按 2K 预算采样。 */
export function resolveEditResolution(config: AiConfig) {
    const value = (config.imageResolution || "").trim();
    if (!value || value === "auto") return 1024;
    if (value === "0" || value === "original") return 0;
    if (value === "4096") return 2048;
    return align32(Math.round(Number(value) || 1024));
}

export function is4kEditResolution(config: AiConfig) {
    return (config.imageResolution || "").trim() === "4096";
}

/** 文生图 4K 判定：按所选/输入尺寸的长边是否达到 4K 档。 */
export function is4kSize(size: string) {
    return inferMediaScale(size) === "4k";
}

/** 4K 超分档的目标长边。 */
export const QWEN_IMAGE_4K_LONG_EDGE = 4096;

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
