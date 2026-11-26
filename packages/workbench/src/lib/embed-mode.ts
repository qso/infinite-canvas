const EMBED_STORAGE_KEY = "infinite-canvas:embed-host";
const CLIENT_ID_STORAGE_KEY = "infinite-canvas:dsh-client-id";
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{4,128}$/;

let cachedEmbedHost: string | null = null;
let cachedClientId: string | null = null;

function readQueryParam(name: string): string | null {
    if (typeof window === "undefined") return null;
    try {
        return new URLSearchParams(window.location.search).get(name);
    } catch {
        return null;
    }
}

function safeSessionGet(key: string): string | null {
    if (typeof window === "undefined") return null;
    try {
        return window.sessionStorage.getItem(key);
    } catch {
        return null;
    }
}

function safeSessionSet(key: string, value: string) {
    if (typeof window === "undefined") return;
    try {
        window.sessionStorage.setItem(key, value);
    } catch {
        // Ignore storage errors in restricted iframes.
    }
}

export function getEmbedHost(): string {
    if (cachedEmbedHost !== null) return cachedEmbedHost;
    const fromQuery = readQueryParam("embed")?.trim().toLowerCase();
    if (fromQuery) {
        safeSessionSet(EMBED_STORAGE_KEY, fromQuery);
        cachedEmbedHost = fromQuery;
        return cachedEmbedHost;
    }
    const stored = safeSessionGet(EMBED_STORAGE_KEY)?.trim().toLowerCase() || "";
    cachedEmbedHost = stored;
    return cachedEmbedHost;
}

export function isDshEmbed(): boolean {
    return getEmbedHost() === "dsh";
}

/**
 * Resolve a stable MCP bridge clientId. When embedded inside DeepSeek Harness,
 * the host passes `?dshClientId=<id>` so each DSH session routes tool calls
 * strictly to its own embedded canvas without cross-tab interference.
 */
export function resolveCanvasMcpClientId(): string {
    if (cachedClientId) return cachedClientId;
    const fromQuery = readQueryParam("dshClientId")?.trim() || "";
    if (CLIENT_ID_RE.test(fromQuery)) {
        safeSessionSet(CLIENT_ID_STORAGE_KEY, fromQuery);
        cachedClientId = fromQuery;
        return cachedClientId;
    }
    const stored = safeSessionGet(CLIENT_ID_STORAGE_KEY)?.trim() || "";
    if (isDshEmbed() && CLIENT_ID_RE.test(stored)) {
        cachedClientId = stored;
        return cachedClientId;
    }
    cachedClientId = crypto.randomUUID();
    return cachedClientId;
}
