import { createHmac } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from "vite";

import { parseChangelog } from "./src/lib/release";
import { COMFYUI_PROXY_PATH, COMFYUI_VIDEO_PROXY_PATH } from "./src/constant/comfyui";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

type DreamMakerAuth = {
    gateway: string;
    accessKey: string;
    secretKey: string;
    user: string;
};

function loadDreamMakerAuth(env: Record<string, string>): DreamMakerAuth {
    const cfg: Record<string, string> = {};
    const configPath = resolve(homedir(), ".dm-cli/config.yaml");
    if (existsSync(configPath)) {
        try {
            for (const raw of readFileSync(configPath, "utf8").split(/\r?\n/)) {
                const line = raw.trim();
                if (!line || line.startsWith("#") || !line.includes(":")) continue;
                const index = line.indexOf(":");
                const key = line.slice(0, index).trim();
                const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
                cfg[key] = value;
            }
        } catch {
            // Ignore unreadable config file; env fallback still applies.
        }
    }
    return {
        gateway: (env.DM_CLI_GATEWAY || cfg.gateway || "https://api-all.dreammaker.netease.com").replace(/\/+$/, ""),
        accessKey: env.DM_CLI_ACCESS_KEY || cfg.access_key || "",
        secretKey: env.DM_CLI_SECRET_KEY || cfg.secret_key || "",
        user: env.DM_CLI_USER || cfg.user || "",
    };
}

function makeDreamMakerJwt(accessKey: string, secretKey: string, ttlSeconds = 300) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iss: accessKey, exp: now + ttlSeconds, nbf: now - 5 })).toString("base64url");
    const signature = createHmac("sha256", secretKey).update(`${header}.${payload}`).digest("base64url");
    return `${header}.${payload}.${signature}`;
}

function isLoopbackCanvasRequest(incoming: IncomingMessage) {
    const origin = incoming.headers.origin;
    const address = incoming.socket.remoteAddress || "";
    const loopback = address === "::1" || /^(?:::ffff:)?127\./.test(address);
    return loopback && incoming.headers["sec-fetch-site"] !== "cross-site" && (!origin || origin === `http://${incoming.headers.host}` || origin === `https://${incoming.headers.host}`);
}

function isSafeRemoteHttpsUrl(rawUrl: string) {
    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol !== "https:") return false;
        const host = parsed.hostname.toLowerCase();
        if (!host || host === "localhost" || host === "::1" || host.endsWith(".local")) return false;
        if (/^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)) return false;
        return true;
    } catch {
        return false;
    }
}

function dreammakerGatewayPlugin(auth: DreamMakerAuth): Plugin {
    const attach = (middlewares: { use: (route: string, fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void }) => {
        middlewares.use("/dreammaker/health", (req, res) => {
            if (!isLoopbackCanvasRequest(req)) {
                res.writeHead(403).end("DreamMaker 代理仅允许本机画布访问");
                return;
            }
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, configured: Boolean(auth.accessKey && auth.secretKey && auth.user), gateway: auth.gateway }));
        });
        middlewares.use("/dreammaker/download", async (req, res) => {
            if (!isLoopbackCanvasRequest(req)) {
                res.writeHead(403).end("DreamMaker 下载代理仅允许本机画布访问");
                return;
            }
            const parsed = new URL(req.url || "/", "http://127.0.0.1");
            const targetUrl = parsed.searchParams.get("url") || "";
            if (!isSafeRemoteHttpsUrl(targetUrl)) {
                res.writeHead(400).end("无效的下载地址");
                return;
            }
            try {
                const upstream = await fetch(targetUrl, {
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
                    },
                });
                const contentType = upstream.headers.get("content-type");
                res.statusCode = upstream.status;
                if (contentType) res.setHeader("Content-Type", contentType);
                const contentLength = upstream.headers.get("content-length");
                if (contentLength) res.setHeader("Content-Length", contentLength);
                if (!upstream.body) {
                    res.end();
                    return;
                }
                Readable.fromWeb(upstream.body as never).pipe(res);
            } catch (error) {
                res.writeHead(502).end(error instanceof Error ? error.message : "下载失败");
            }
        });
    };
    return {
        name: "dreammaker-gateway-middleware",
        configureServer(server) {
            attach(server.middlewares);
        },
        configurePreviewServer(server) {
            attach(server.middlewares);
        },
    };
}

export default defineConfig(({ mode }) => {
    // 固定云端转发目标仅由本地服务配置提供，密钥不暴露给浏览器。
    const env = loadEnv(mode, webDir, "");
    const dreammakerAuth = loadDreamMakerAuth(env);
    const comfyuiRemoteUrl = env.COMFYUI_REMOTE_URL;
    const comfyuiProxyFor = (path: string, target: string | undefined): Record<string, ProxyOptions> =>
        target
            ? {
                [path]: {
                    target,
                    changeOrigin: true,
                    rewrite: (requestPath: string) => requestPath.slice(path.length),
                    // ComfyUI receives a same-server request; the browser only talks to its own Vite origin.
                    configure: (proxy) => { proxy.on("proxyReq", (request) => request.removeHeader("origin")); },
                },
            }
            : {};
    const comfyuiProxy: Record<string, ProxyOptions> = {
        ...comfyuiProxyFor(COMFYUI_PROXY_PATH, comfyuiRemoteUrl),
        ...comfyuiProxyFor(COMFYUI_VIDEO_PROXY_PATH, env.COMFYUI_VIDEO_REMOTE_URL || comfyuiRemoteUrl),
    };
    const yue2TokenPath = resolve(webDir, "../data/yue2-api.token");
    const yue2Token = env.YUE2_API_TOKEN || (existsSync(yue2TokenPath) ? readFileSync(yue2TokenPath, "utf8").trim() : "");
    const fireredTokenPath = resolve(webDir, "../data/firered-api.token");
    const fireredToken = env.FIRERED_API_TOKEN || (existsSync(fireredTokenPath) ? readFileSync(fireredTokenPath, "utf8").trim() : "");
    // Loopback-only reverse proxy with server-side token injection; the browser never sees the token.
    const guardedServiceProxy = (path: string, target: string | undefined, token: string, denyMessage: string): Record<string, ProxyOptions> =>
        target && token
            ? {
                [path]: {
                    target,
                    changeOrigin: true,
                    rewrite: (requestPath: string) => requestPath.slice(path.length),
                    configure: (proxy) => {
                        proxy.on("proxyReq", (request, incoming, response) => {
                            // The browser must originate from this local canvas, not an unrelated website.
                            const origin = incoming.headers.origin;
                            const address = incoming.socket.remoteAddress || "";
                            const loopback = address === "::1" || /^(?:::ffff:)?127\./.test(address);
                            if (!loopback || incoming.headers["sec-fetch-site"] === "cross-site" || (origin && origin !== `http://${incoming.headers.host}` && origin !== `https://${incoming.headers.host}`)) {
                                request.destroy();
                                response.writeHead(403).end(denyMessage);
                                return;
                            }
                            request.setHeader("authorization", `Bearer ${token}`);
                            request.removeHeader("origin");
                            request.removeHeader("cookie");
                        });
                    },
                },
            }
            : {};
    const dreammakerProxyFor = (path: string): Record<string, ProxyOptions> => ({
        [path]: {
            target: dreammakerAuth.gateway,
            changeOrigin: true,
            rewrite: (requestPath: string) => requestPath.replace(/^\/dreammaker/, ""),
            configure: (proxy) => {
                proxy.on("proxyReq", (request, incoming, response) => {
                    if (!isLoopbackCanvasRequest(incoming)) {
                        request.destroy();
                        response.writeHead(403).end("DreamMaker API 仅允许本机画布访问");
                        return;
                    }
                    if (!dreammakerAuth.accessKey || !dreammakerAuth.secretKey || !dreammakerAuth.user) {
                        request.destroy();
                        response.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ code: 503, message: "DreamMaker 凭据未配置：请在 ~/.dm-cli/config.yaml 或环境变量配置 DM_CLI_ACCESS_KEY / DM_CLI_SECRET_KEY / DM_CLI_USER" }));
                        return;
                    }
                    request.setHeader("authorization", `Bearer ${makeDreamMakerJwt(dreammakerAuth.accessKey, dreammakerAuth.secretKey)}`);
                    request.setHeader("x-real-user", dreammakerAuth.user);
                    request.removeHeader("origin");
                    request.removeHeader("cookie");
                });
            },
        },
    });
    const proxy = {
        ...comfyuiProxy,
        ...dreammakerProxyFor("/dreammaker/api"),
        ...dreammakerProxyFor("/dreammaker/static"),
        ...guardedServiceProxy("/yue2", env.YUE2_REMOTE_URL, yue2Token, "音乐 API 仅允许本机画布访问"),
        ...guardedServiceProxy("/firered", env.FIRERED_REMOTE_URL, fireredToken, "FireRedAudio API 仅允许本机画布访问"),
    };
    return {
        server: { proxy, fs: { deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/yue2-api.token", "**/firered-api.token"] } },
        preview: { proxy },
        base: process.env.VITE_BASE || "/",
        plugins: [react(), localPluginsManifest(), dreammakerGatewayPlugin(dreammakerAuth)],
        resolve: {
            alias: {
                "@": resolve(webDir, "src"),
            },
        },
        define: {
            __APP_VERSION__: JSON.stringify(localVersion),
            __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
        },
    };
});
