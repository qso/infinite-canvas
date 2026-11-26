import { readMediaBlob } from "@workbench/services/file-storage";
import { FIRERED_ENDPOINT, FIRERED_POLL_ATTEMPTS, FIRERED_POLL_INTERVAL_MS, type FireRedTask, type FireRedTaskRequest } from "@workbench/constant/firered";
import type { ReferenceAudio } from "@workbench/types/media";

type RequestOptions = { signal?: AbortSignal };

export class FireRedApiError extends Error {
    constructor(message: string, public status: number) {
        super(message);
        this.name = "FireRedApiError";
    }
}

const POLL_TOLERATED_FAILURES = 6;
const CONTENT_CHUNK = 16 * 1024 * 1024;

function isTransientPollError(error: unknown) {
    return !(error instanceof FireRedApiError) || error.status >= 500;
}

async function fireredFetch(path: string, init: RequestInit = {}) {
    const response = await fetch(`${FIRERED_ENDPOINT}/v1/firered${path}`, init);
    if (!response.ok) {
        const body = await response.text();
        let detail = "";
        try {
            const payload = JSON.parse(body) as { detail?: unknown; error?: string };
            detail = typeof payload.detail === "string" ? payload.detail : payload.error || "";
        } catch {
            // Proxy error pages are not task responses.
        }
        const fallback = response.status === 404 && !detail
            ? "未连接到 FireRedAudio 服务（404）：请先部署 services/firered-audio，并在 .env.local 配置 FIRERED_REMOTE_URL 与 data/firered-api.token 后重启本地服务。"
            : `FireRedAudio 服务请求失败（HTTP ${response.status}）`;
        throw new FireRedApiError(detail || fallback, response.status);
    }
    return response;
}

async function withGatewayRetry<T>(action: () => Promise<T>, options?: RequestOptions): Promise<T> {
    let lastError: unknown;
    const backoffs = [1000, 2000, 4000, 8000, 15000, 30000];
    for (let attempt = 0; attempt <= backoffs.length; attempt += 1) {
        try {
            return await action();
        } catch (error) {
            lastError = error;
            if (!(error instanceof FireRedApiError) || error.status < 500 || attempt === backoffs.length) throw error;
            await delay(backoffs[attempt], options?.signal);
        }
    }
    throw lastError;
}

export async function uploadFireRedAudio(blob: Blob, options: RequestOptions = {}): Promise<string> {
    const data = await withGatewayRetry(() => fireredFetch("/audio", { method: "POST", headers: { "Content-Type": blob.type || "application/octet-stream" }, body: blob, signal: options.signal }).then((response) => response.json() as Promise<{ id: string }>), options);
    return data.id;
}

export async function fireRedAudioToFile(audio: ReferenceAudio, options: RequestOptions = {}): Promise<File> {
    const blob = await readMediaBlob(audio.storageKey, audio.url, { signal: options.signal });
    if (!blob.size) throw new Error("参考音频无效或已丢失");
    return new File([blob], audio.name || "reference.wav", { type: audio.type || blob.type || "audio/wav" });
}

export async function createFireRedTask(request: FireRedTaskRequest, options: RequestOptions = {}): Promise<FireRedTask> {
    return withGatewayRetry(() => fireredFetch("/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: options.signal,
    }).then((response) => response.json() as Promise<FireRedTask>), options);
}

export async function getFireRedTask(id: string, options: RequestOptions = {}): Promise<FireRedTask> {
    return fireredFetch(`/tasks/${encodeURIComponent(id)}`, { signal: options.signal }).then((response) => response.json() as Promise<FireRedTask>);
}

export async function waitForFireRedTask(id: string, options: RequestOptions & { onTask?: (task: FireRedTask) => void } = {}): Promise<FireRedTask> {
    let failures = 0;
    for (let attempt = 0; attempt < FIRERED_POLL_ATTEMPTS; attempt += 1) {
        let task: FireRedTask;
        try {
            task = await getFireRedTask(id, options);
            failures = 0;
        } catch (error) {
            options.signal?.throwIfAborted();
            if (!isTransientPollError(error) || ++failures >= POLL_TOLERATED_FAILURES) throw error;
            await delay(FIRERED_POLL_INTERVAL_MS, options.signal);
            continue;
        }
        options.signal?.throwIfAborted();
        if (task.id !== id || task.request?.id !== id) throw new Error("返回任务与请求编号不一致，已停止处理。");
        options.onTask?.(task);
        if (task.status === "completed" || task.status === "failed") {
            if (task.status === "failed") throw new Error(task.error || "任务失败");
            return task;
        }
        if (attempt < FIRERED_POLL_ATTEMPTS - 1) await delay(FIRERED_POLL_INTERVAL_MS, options.signal);
    }
    throw new Error("本轮查询已结束，云端可能仍在处理。任务编号已保留，重试将继续查询。");
}

export async function getFireRedTaskContent(id: string, options: RequestOptions = {}): Promise<Blob> {
    const path = `/tasks/${encodeURIComponent(id)}/content`;
    const first = await fireredFetch(path, { headers: { Range: `bytes=0-${CONTENT_CHUNK - 1}` }, signal: options.signal });
    const contentType = first.headers.get("Content-Type") || "audio/wav";
    const firstPart = await first.blob();
    if (!firstPart.size) throw new Error("音频为空");
    if (first.status !== 206) return firstPart;

    const total = Number(first.headers.get("Content-Range")?.split("/")[1]) || 0;
    const parts: Blob[] = [firstPart];
    let received = firstPart.size;
    while (!total || received < total) {
        const end = total ? Math.min(total - 1, received + CONTENT_CHUNK - 1) : received + CONTENT_CHUNK - 1;
        const headers = { Range: `bytes=${received}-${end}` };
        let response = await fireredFetch(path, { headers, signal: options.signal });
        if (response.status >= 500) {
            await delay(1000, options.signal);
            response = await fireredFetch(path, { headers, signal: options.signal });
        }
        const part = await response.blob();
        if (!part.size) throw new Error("音频为空");
        parts.push(part);
        received += part.size;
        if (!total && part.size < CONTENT_CHUNK) break;
    }
    return new Blob(parts, { type: contentType });
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
