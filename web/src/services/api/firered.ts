import i18n from "@/i18n";
import { getMediaBlob, resolveMediaUrl } from "@/services/file-storage";
import { FIRERED_ENDPOINT, FIRERED_POLL_ATTEMPTS, FIRERED_POLL_INTERVAL_MS, type FireRedTask, type FireRedTaskRequest } from "@/constant/firered";
import type { ReferenceAudio } from "@/types/media";

type RequestOptions = { signal?: AbortSignal };

export class FireRedApiError extends Error {
    constructor(message: string, public status: number) {
        super(message);
        this.name = "FireRedApiError";
    }
}

const POLL_TOLERATED_FAILURES = 6;
const CONTENT_CHUNK = 16 * 1024 * 1024; // 内网网关限制单响应大小，音频分块拉取（同 music.ts）。

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
        // A bodyless 404 means the /firered proxy itself is absent (vite answered),
        // i.e. the cloud service was never deployed or the local env is not configured.
        const fallback = response.status === 404 && !detail ? i18n.t("canvas.fireRed.notConfigured") : i18n.t("canvas.fireRed.httpFailed", { status: response.status });
        throw new FireRedApiError(detail || fallback, response.status);
    }
    return response;
}

// The intranet gateway intermittently answers 503 "no healthy upstream" while the
// service itself is fine; uploads and task creation retry transient 5xx with backoff.
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

/** 参考音频（画布节点 / 资产）转成可上传的 File；与 video.ts 的 referenceMediaToFile 同一策略。 */
export async function fireRedAudioToFile(audio: ReferenceAudio, options: RequestOptions = {}): Promise<File> {
    let blob = audio.storageKey ? await getMediaBlob(audio.storageKey) : null;
    if (!blob) {
        const url = audio.storageKey ? await resolveMediaUrl(audio.storageKey, audio.url || "") : audio.url || "";
        if (!url) throw new Error(i18n.t("apiErrors.invalidReferenceAudio"));
        blob = await (await fetch(url, { signal: options.signal })).blob();
    }
    if (!blob.size) throw new Error(i18n.t("apiErrors.invalidReferenceAudio"));
    return new File([blob], audio.name || "reference.wav", { type: audio.type || blob.type || "audio/wav" });
}

export async function createFireRedTask(request: FireRedTaskRequest, options: RequestOptions = {}): Promise<FireRedTask> {
    return withGatewayRetry(() => fireredFetch("/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: options.signal }).then((response) => response.json() as Promise<FireRedTask>), options);
}

export async function getFireRedTask(id: string, options: RequestOptions = {}): Promise<FireRedTask> {
    return (await fireredFetch(`/tasks/${encodeURIComponent(id)}`, { signal: options.signal })).json() as Promise<FireRedTask>;
}

export async function waitForFireRedTask(id: string, options: RequestOptions & { onTask?: (task: FireRedTask) => void } = {}): Promise<FireRedTask> {
    let failures = 0;
    for (let attempt = 0; attempt < FIRERED_POLL_ATTEMPTS; attempt += 1) {
        options.signal?.throwIfAborted();
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
        if (task.id !== id || task.request.id !== id) throw new Error(i18n.t("canvas.fireRed.taskMismatch"));
        options.onTask?.(task);
        if (task.status === "completed" || task.status === "failed") {
            if (task.status === "failed") throw new Error(task.error || i18n.t("canvas.fireRed.taskFailed"));
            return task;
        }
        if (attempt < FIRERED_POLL_ATTEMPTS - 1) await delay(FIRERED_POLL_INTERVAL_MS, options.signal);
    }
    throw new Error(i18n.t("canvas.fireRed.queryWindowEnded"));
}

export async function getFireRedTaskContent(id: string, options: RequestOptions = {}): Promise<Blob> {
    const path = `/tasks/${encodeURIComponent(id)}/content`;
    const first = await fireredFetch(path, { headers: { Range: `bytes=0-${CONTENT_CHUNK - 1}` }, signal: options.signal });
    const contentType = first.headers.get("content-type") || "audio/wav";
    const firstPart = await first.blob();
    if (!firstPart.size) throw new Error(i18n.t("canvas.fireRed.emptyOutput"));
    if (first.status !== 206) return new Blob([firstPart], { type: contentType });
    const total = Number(/\/(\d+)$/.exec(first.headers.get("content-range") || "")?.[1] || 0);
    if (total && firstPart.size >= total) return new Blob([firstPart], { type: contentType });
    const parts = [firstPart];
    let received = firstPart.size;
    while (!total || received < total) {
        const start = received;
        const end = total ? Math.min(start + CONTENT_CHUNK, total) - 1 : start + CONTENT_CHUNK - 1;
        const headers = { Range: `bytes=${start}-${end}` };
        let response: Response;
        try {
            response = await fireredFetch(path, { headers, signal: options.signal });
        } catch {
            response = await fireredFetch(path, { headers, signal: options.signal });
        }
        const part = await response.blob();
        if (!part.size) throw new Error(i18n.t("canvas.fireRed.emptyOutput"));
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
