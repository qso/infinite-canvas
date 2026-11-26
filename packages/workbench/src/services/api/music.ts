import { MUSIC_ENDPOINT, MUSIC_POLL_ATTEMPTS, MUSIC_POLL_INTERVAL_MS, type MusicAnalysisRequest, type MusicAnalysisTask, type MusicGenerationOutput, type MusicGenerationRequest, type MusicTaskStatus } from "@workbench/constant/music";

type RequestOptions = { signal?: AbortSignal };
export type MusicGenerationTask = {
    id: string;
    status: MusicTaskStatus;
    stage: string;
    seed: number;
    request: MusicGenerationRequest;
    output: MusicGenerationOutput | null;
    error: string | null;
};

export class MusicApiError extends Error {
    constructor(message: string, public status: number) {
        super(message);
        this.name = "MusicApiError";
    }
}

const POLL_TOLERATED_FAILURES = 3;

function isTransientPollError(error: unknown) {
    return !(error instanceof MusicApiError) || error.status >= 500;
}

async function musicFetch(path: string, init: RequestInit = {}, resource = "generations") {
    const response = await fetch(`${MUSIC_ENDPOINT}/v1/music/${resource}${path}`, init);
    if (!response.ok) {
        const body = await response.text();
        let detail = "";
        try {
            const payload = JSON.parse(body) as { detail?: unknown; error?: string };
            detail = typeof payload.detail === "string" ? payload.detail : payload.error || "";
        } catch {
            // A proxy error page is not a music task response.
        }
        throw new MusicApiError(detail || `音乐服务请求失败（HTTP ${response.status}）`, response.status);
    }
    return response;
}

export async function uploadMusicReference(blob: Blob, options: RequestOptions = {}): Promise<{ id: string; bytes: number }> {
    return (await musicFetch("", { method: "POST", headers: { "Content-Type": blob.type || "application/octet-stream" }, body: blob, signal: options.signal }, "audio")).json();
}

export async function createMusicAnalysis(request: MusicAnalysisRequest, options: RequestOptions = {}): Promise<MusicAnalysisTask> {
    return (await musicFetch("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: options.signal }, "analyses")).json();
}

export async function getMusicAnalysis(id: string, options: RequestOptions = {}): Promise<MusicAnalysisTask> {
    return (await musicFetch(`/${encodeURIComponent(id)}`, { signal: options.signal }, "analyses")).json();
}

export async function waitForMusicAnalysis(id: string, options: RequestOptions & { onTask?: (task: MusicAnalysisTask) => void } = {}) {
    let failures = 0;
    for (let attempt = 0; attempt < MUSIC_POLL_ATTEMPTS; attempt += 1) {
        let task: MusicAnalysisTask;
        try {
            task = await getMusicAnalysis(id, options);
            failures = 0;
        } catch (error) {
            options.signal?.throwIfAborted();
            if (!isTransientPollError(error) || ++failures >= POLL_TOLERATED_FAILURES) throw error;
            await delay(MUSIC_POLL_INTERVAL_MS, options.signal);
            continue;
        }
        options.signal?.throwIfAborted();
        if (task.id !== id || task.request.id !== id) throw new Error("音乐服务返回的任务编号与请求不一致。");
        options.onTask?.(task);
        if (task.status === "completed" || task.status === "failed") return task;
        if (attempt < MUSIC_POLL_ATTEMPTS - 1) await delay(MUSIC_POLL_INTERVAL_MS, options.signal);
    }
    throw new Error("本轮查询窗口已结束，云端可能仍在生成，请稍后重试查询。");
}

export async function createMusicGenerationTask(request: MusicGenerationRequest, options: RequestOptions = {}): Promise<MusicGenerationTask> {
    return (await musicFetch("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: options.signal })).json();
}

export async function getMusicGenerationTask(id: string, options: RequestOptions = {}): Promise<MusicGenerationTask> {
    return (await musicFetch(`/${encodeURIComponent(id)}`, { signal: options.signal })).json();
}

export async function getMusicGenerationContent(id: string, options: RequestOptions = {}): Promise<Blob> {
    const path = `/${encodeURIComponent(id)}/content`;
    const CHUNK = 16 * 1024 * 1024;
    const first = await musicFetch(path, { headers: { Range: `bytes=0-${CHUNK - 1}` }, signal: options.signal });
    const contentType = first.headers.get("Content-Type") || "audio/wav";
    const firstPart = await first.blob();
    if (!firstPart.size) throw new Error("音乐生成结果为空。");
    if (first.status !== 206) return firstPart;
    const total = Number(first.headers.get("Content-Range")?.split("/")[1]) || 0;
    const parts: Blob[] = [firstPart];
    let received = firstPart.size;
    while (!total || received < total) {
        const end = total ? Math.min(total - 1, received + CHUNK - 1) : received + CHUNK - 1;
        const headers = { Range: `bytes=${received}-${end}` };
        let response = await musicFetch(path, { headers, signal: options.signal });
        if (response.status >= 500) {
            await delay(1000, options.signal);
            response = await musicFetch(path, { headers, signal: options.signal });
        }
        const part = await response.blob();
        if (!part.size) throw new Error("音乐生成结果为空。");
        parts.push(part);
        received += part.size;
        if (!total && part.size < CHUNK) break;
    }
    return new Blob(parts, { type: contentType });
}

export async function getMusicGenerationScore(id: string, options: RequestOptions = {}, variant: "used" | "source" = "used"): Promise<string> {
    const query = variant === "source" ? "?variant=source" : "";
    return (await musicFetch(`/${encodeURIComponent(id)}/score${query}`, { signal: options.signal })).text();
}

export async function waitForMusicGenerationTask(id: string, options: RequestOptions & { onTask?: (task: MusicGenerationTask) => void } = {}) {
    let failures = 0;
    for (let attempt = 0; attempt < MUSIC_POLL_ATTEMPTS; attempt += 1) {
        let task: MusicGenerationTask;
        try {
            task = await getMusicGenerationTask(id, options);
            failures = 0;
        } catch (error) {
            options.signal?.throwIfAborted();
            if (!isTransientPollError(error) || ++failures >= POLL_TOLERATED_FAILURES) throw error;
            await delay(MUSIC_POLL_INTERVAL_MS, options.signal);
            continue;
        }
        options.signal?.throwIfAborted();
        if (task.id !== id || task.request.id !== id) throw new Error("音乐服务返回的任务编号与请求不一致。");
        options.onTask?.(task);
        if (task.status === "completed" || task.status === "failed") return task;
        if (attempt < MUSIC_POLL_ATTEMPTS - 1) await delay(MUSIC_POLL_INTERVAL_MS, options.signal);
    }
    throw new Error("本轮查询窗口已结束，云端可能仍在生成，请稍后重试查询。");
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        signal?.throwIfAborted();
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
