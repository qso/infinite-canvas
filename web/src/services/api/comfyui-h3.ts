import axios from "axios";
import localforage from "localforage";

import { COMFYUI_PROXY_PATH, H3_DEFAULT_STEPS, H3_FAST_DEFAULT_STEPS } from "@/constant/comfyui";
import { buildH3Workflow, type H3WorkflowInput } from "./comfyui-h3-workflow";
import type { VideoGenerationTaskState } from "./video";

type OutputFile = { filename: string; subfolder: string; type: string };
type H3TaskRecord = { id: string; createdAt: number; mode: H3WorkflowInput["mode"]; width: number; height: number; seconds: number; seed: number; steps: number; fast: boolean; hd: boolean; refImageSize: "match" | "max"; generateAudio: boolean; output?: OutputFile };
type HistoryEntry = {
    outputs?: Record<string, Record<string, unknown>>;
    status?: { completed: boolean; status_str: string; messages?: Array<[string, { exception_message?: string; node_type?: string }]> };
};
type ComfyError = { error?: { message?: string }; node_errors?: Record<string, { errors?: Array<{ details?: string; message?: string }> }> };
const tasks = localforage.createInstance({ name: "infinite-canvas", storeName: "comfyui_h3_tasks" });
const api = axios.create({ baseURL: COMFYUI_PROXY_PATH });

export async function createH3VideoTask(input: Omit<H3WorkflowInput, "images" | "videos" | "audios" | "outputPrefix"> & { images: File[]; videos: File[]; audios: File[] }, signal?: AbortSignal) {
    const clientId = crypto.randomUUID();
    // Validate before uploading, so invalid mode/parameter combinations never reach the GPU queue.
    const placeholder = { ...input, images: input.images.map((file) => file.name), videos: input.videos.map((file) => file.name), audios: input.audios.map((file) => file.name), outputPrefix: `ai-creative-studio/${clientId}` };
    buildH3Workflow(placeholder);
    const upload = async (file: File) => {
        const body = new FormData();
        body.append("image", file, `${crypto.randomUUID()}-${file.name}`);
        body.append("type", "input");
        body.append("subfolder", `ai-creative-studio/${clientId}`);
        const { data } = await api.post<{ name: string; subfolder: string }>("/upload/image", body, { signal });
        if (!data.name) throw new Error("ComfyUI 未返回上传后的文件名。");
        return [data.subfolder, data.name].filter(Boolean).join("/");
    };
    try {
        const [images, videos, audios] = await Promise.all([Promise.all(input.images.map(upload)), Promise.all(input.videos.map(upload)), Promise.all(input.audios.map(upload))]);
        const graph = buildH3Workflow({ ...placeholder, images, videos, audios });
        const { data } = await api.post<{ prompt_id?: string }>("/prompt", { prompt: graph, client_id: clientId }, { signal });
        if (!data.prompt_id) throw new Error("ComfyUI 没有返回任务编号，请检查云端队列后再试。");
        const record: H3TaskRecord = { id: data.prompt_id, createdAt: Date.now(), mode: input.mode, width: Math.max(32, Math.round(input.width / 32) * 32), height: Math.max(32, Math.round(input.height / 32) * 32), seconds: input.seconds, seed: input.seed, steps: input.fast ? H3_FAST_DEFAULT_STEPS : input.steps ?? H3_DEFAULT_STEPS, fast: Boolean(input.fast), hd: Boolean(input.hd), refImageSize: input.refImageSize || "match", generateAudio: input.generateAudio };
        await tasks.setItem(record.id, record);
        return record.id;
    } catch (error) {
        if (axios.isCancel(error) || signal?.aborted) throw error;
        throw new Error(h3Error(error));
    }
}

export async function pollH3VideoTask(id: string, signal?: AbortSignal): Promise<VideoGenerationTaskState> {
    try {
        const record = await tasks.getItem<H3TaskRecord>(id);
        let output = record?.output;
        if (!output) {
            const { data } = await api.get<Record<string, HistoryEntry>>(`/history/${encodeURIComponent(id)}`, { signal });
            const entry = data[id];
            if (entry?.status?.status_str === "error") {
                const failure = entry.status.messages?.findLast(([type]) => type === "execution_error" || type === "execution_interrupted");
                return { status: "failed", error: failure?.[1].exception_message || "ComfyUI 生成失败或任务被中断，请检查云端执行记录。" };
            }
            if (!entry?.status?.completed) return { status: "pending" };
            output = Object.values(entry.outputs?.["14"] || {}).flat().find((value): value is OutputFile => Boolean(value && typeof value === "object" && "filename" in value && typeof value.filename === "string" && /\.mp4$/i.test(value.filename)));
            if (!output) return { status: "failed", error: "ComfyUI 已结束，但视频保存节点没有返回 MP4 文件。" };
            // Keep the file locator even if ComfyUI's in-memory history is later cleared.
            await tasks.setItem(id, { ...record, id, output });
        }
        const { data: blob } = await api.get<Blob>("/view", { params: output, responseType: "blob", signal });
        if (!blob.size || /json|html/i.test(blob.type)) throw new Error("ComfyUI 返回的内容不是可播放的视频，任务编号已保留，可以重试下载。");
        return { status: "completed", result: { blob, mimeType: blob.type || "video/mp4" } };
    } catch (error) {
        if (axios.isCancel(error) || signal?.aborted) throw error;
        throw new Error(h3Error(error));
    }
}

function h3Error(error: unknown) {
    if (!axios.isAxiosError(error)) return error instanceof Error ? error.message : "ComfyUI 请求失败。";
    const data = error.response?.data as ComfyError | undefined;
    if (data && typeof data === "object") {
        const details = Object.values(data.node_errors || {}).flatMap((node) => (node.errors || []).map((item) => item.details || item.message)).filter(Boolean);
        return [data.error?.message, ...details].filter(Boolean).join("；") || `ComfyUI 请求失败（${error.response?.status}）。`;
    }
    return error.response?.status === 404
        ? "ComfyUI 转发入口不可用，请使用项目的本地启动方式，并确认能够访问云端 Jupyter。"
        : `无法连接云端 ComfyUI${error.response?.status ? `（${error.response.status}）` : ""}，请检查网络和云端服务；已有任务可稍后恢复查询。`;
}
