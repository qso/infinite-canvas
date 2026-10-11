import i18n from "@/i18n";
import { MUSIC_ENDPOINT, MUSIC_POLL_ATTEMPTS, MUSIC_POLL_INTERVAL_MS, type MusicAnalysisRequest, type MusicAnalysisTask, type MusicGenerationOutput, type MusicGenerationRequest, type MusicTaskStatus } from "@/constant/music";

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

// Polling tolerates transient proxy failures (5xx / network reset); consecutive failures beyond this count surface the error. 4xx keeps failing fast.
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
        throw new MusicApiError(detail || i18n.t("canvas.music.httpFailed", { status: response.status }), response.status);
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
        if (task.id !== id || task.request.id !== id) throw new Error(i18n.t("canvas.music.taskMismatch"));
        options.onTask?.(task);
        if (task.status === "completed" || task.status === "failed") return task;
        if (attempt < MUSIC_POLL_ATTEMPTS - 1) await delay(MUSIC_POLL_INTERVAL_MS, options.signal);
    }
    throw new Error(i18n.t("canvas.music.queryWindowEnded"));
}

export async function createMusicGenerationTask(request: MusicGenerationRequest, options: RequestOptions = {}): Promise<MusicGenerationTask> {
    return (await musicFetch("", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request), signal: options.signal })).json();
}

export async function getMusicGenerationTask(id: string, options: RequestOptions = {}): Promise<MusicGenerationTask> {
    return (await musicFetch(`/${encodeURIComponent(id)}`, { signal: options.signal })).json();
}

// The intranet gateway rejects single large responses (long WAV > ~100MB fails fast with 599) while range
// requests pass, so audio is fetched in chunks and stitched locally. Chunk failures retry once.
const MUSIC_CONTENT_CHUNK = 16 * 1024 * 1024;

export async function getMusicGenerationContent(id: string, options: RequestOptions = {}) {
    const path = `/${encodeURIComponent(id)}/content`;
    const first = await musicFetch(path, { headers: { Range: `bytes=0-${MUSIC_CONTENT_CHUNK - 1}` }, signal: options.signal });
    const contentType = first.headers.get("content-type") || "application/octet-stream";
    const firstPart = await first.blob();
    if (!firstPart.size) throw new Error(i18n.t("canvas.music.emptyOutput"));
    if (first.status !== 206) return firstPart;
    const total = Number(/\/(\d+)$/.exec(first.headers.get("content-range") || "")?.[1] || 0);
    if (total && firstPart.size >= total) return new Blob([firstPart], { type: contentType });
    const parts = [firstPart];
    let received = firstPart.size;
    while (!total || received < total) {
        const start = received;
        const end = total ? Math.min(start + MUSIC_CONTENT_CHUNK, total) - 1 : start + MUSIC_CONTENT_CHUNK - 1;
        const headers = { Range: `bytes=${start}-${end}` };
        let response: Response;
        try {
            response = await musicFetch(path, { headers, signal: options.signal });
        } catch {
            response = await musicFetch(path, { headers, signal: options.signal });
        }
        const part = await response.blob();
        if (!part.size) throw new Error(i18n.t("canvas.music.emptyOutput"));
        parts.push(part);
        received += part.size;
        if (!total && part.size < MUSIC_CONTENT_CHUNK) break;
    }
    if (total && received !== total) throw new Error(i18n.t("canvas.music.invalidOutput"));
    return new Blob(parts, { type: contentType });
}

export async function getMusicGenerationScore(id: string, options: RequestOptions & { variant?: "used" | "source" } = {}) {
    const variant = options.variant && options.variant !== "used" ? `?variant=${options.variant}` : "";
    return (await musicFetch(`/${encodeURIComponent(id)}/score${variant}`, { signal: options.signal })).text();
}

export async function waitForMusicGenerationTask(id: string, options: RequestOptions & { onTask?: (task: MusicGenerationTask) => void } = {}) {
    let failures = 0;
    for (let attempt = 0; attempt < MUSIC_POLL_ATTEMPTS; attempt += 1) {
        options.signal?.throwIfAborted();
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
        if (task.id !== id || task.request.id !== id) throw new Error(i18n.t("canvas.music.taskMismatch"));
        options.onTask?.(task);
        if (task.status === "completed" || task.status === "failed") return task;
        if (attempt < MUSIC_POLL_ATTEMPTS - 1) await delay(MUSIC_POLL_INTERVAL_MS, options.signal);
    }
    throw new Error(i18n.t("canvas.music.queryWindowEnded"));
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
