import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Express, NextFunction, Request, Response } from "express";

type DreamMakerAuth = {
    gateway: string;
    accessKey: string;
    secretKey: string;
    user: string;
};

type ProxyRule = {
    prefix: string;
    target: string;
    rewrite: (requestPath: string) => string;
    mode: "comfyui" | "bearer" | "dreammaker";
    bearerToken?: string;
    denyMessage?: string;
};

function parseEnvFile(filePath: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!existsSync(filePath)) return out;
    try {
        for (const raw of readFileSync(filePath, "utf8").split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith("#") || !line.includes("=")) continue;
            const index = line.indexOf("=");
            const key = line.slice(0, index).trim();
            let value = line.slice(index + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (key) out[key] = value;
        }
    } catch {
        // Ignore unreadable env files.
    }
    return out;
}

function locateRepoRoot(): string | null {
    const explicit = process.env.INFINITE_CANVAS_REPO_ROOT?.trim();
    if (explicit && existsSync(explicit)) return path.resolve(explicit);
    let current = path.dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 7; depth += 1) {
        if (existsSync(path.join(current, "pnpm-workspace.yaml")) || existsSync(path.join(current, ".env.local"))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return null;
}

function loadCombinedEnv(repoRoot: string | null): Record<string, string> {
    const merged: Record<string, string> = {};
    if (repoRoot) {
        for (const name of [".env", ".env.local"]) {
            Object.assign(merged, parseEnvFile(path.join(repoRoot, name)));
        }
    }
    for (const [key, value] of Object.entries(process.env)) {
        if (typeof value === "string") merged[key] = value;
    }
    return merged;
}

function loadDreamMakerAuth(env: Record<string, string>): DreamMakerAuth {
    const cfg: Record<string, string> = {};
    const configPath = path.resolve(homedir(), ".dm-cli/config.yaml");
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
            // Ignore unreadable dm-cli config.
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

function matchesPrefix(pathname: string, prefix: string): boolean {
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function forwardHttpRequest(req: IncomingMessage, res: ServerResponse, targetBase: string, rewrittenPath: string, extraHeaders: Record<string, string>) {
    let upstreamUrl: URL;
    try {
        const base = targetBase.endsWith("/") ? targetBase : `${targetBase}/`;
        const relative = rewrittenPath.replace(/^\/+/, "");
        const target = new URL(base);
        upstreamUrl = new URL(relative, target);
        if (!["https:", "http:"].includes(target.protocol) || upstreamUrl.origin !== target.origin || upstreamUrl.username || upstreamUrl.password) {
            res.writeHead(400).end("无效的代理路径");
            return;
        }
    } catch (error) {
        res.writeHead(502).end(error instanceof Error ? error.message : "代理目标地址无效");
        return;
    }

    const headers: Record<string, string | string[] | undefined> = { ...req.headers };
    delete headers.host;
    delete headers.origin;
    delete headers.cookie;
    delete headers["sec-fetch-site"];
    delete headers["sec-fetch-mode"];
    delete headers["sec-fetch-dest"];
    for (const [k, v] of Object.entries(extraHeaders)) {
        headers[k] = v;
    }

    const transport = upstreamUrl.protocol === "https:" ? https : http;
    const proxyReq = transport.request(
        upstreamUrl,
        {
            method: req.method,
            headers,
        },
        (proxyRes) => {
            if (!res.headersSent) {
                res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            }
            proxyRes.pipe(res);
        },
    );

    proxyReq.on("error", (error) => {
        if (!res.headersSent) {
            res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        }
        res.end(`上游代理请求失败：${error.message}`);
    });

    req.on("aborted", () => {
        proxyReq.destroy();
    });

    req.pipe(proxyReq);
}

/**
 * Mount local private model proxies (DreamMaker, ComfyUI/H3, YuE2, FireRedAudio) directly
 * onto the Express server so built CLI mode (without Vite dev server) supports all custom models.
 */
export function mountPrivateProxies(app: Express): { enabled: boolean; prefixes: string[] } {
    const repoRoot = locateRepoRoot();
    const env = loadCombinedEnv(repoRoot);
    const dreammakerAuth = loadDreamMakerAuth(env);

    const readTokenFile = (rel: string) => {
        if (!repoRoot) return "";
        const full = path.join(repoRoot, rel);
        return existsSync(full) ? readFileSync(full, "utf8").trim() : "";
    };

    const yue2Token = env.YUE2_API_TOKEN || readTokenFile("data/yue2-api.token");
    const fireredToken = env.FIRERED_API_TOKEN || readTokenFile("data/firered-api.token");

    const rules: ProxyRule[] = [];
    if (env.COMFYUI_REMOTE_URL) {
        rules.push({
            prefix: "/comfyui",
            target: env.COMFYUI_REMOTE_URL,
            rewrite: (p) => p.slice("/comfyui".length) || "/",
            mode: "comfyui",
        });
    }
    const comfyuiVideoTarget = env.COMFYUI_VIDEO_REMOTE_URL || env.COMFYUI_REMOTE_URL;
    if (comfyuiVideoTarget) {
        rules.push({
            prefix: "/h3",
            target: comfyuiVideoTarget,
            rewrite: (p) => p.slice("/h3".length) || "/",
            mode: "comfyui",
        });
    }
    if (env.YUE2_REMOTE_URL && yue2Token) {
        rules.push({
            prefix: "/yue2",
            target: env.YUE2_REMOTE_URL,
            rewrite: (p) => p.slice("/yue2".length) || "/",
            mode: "bearer",
            bearerToken: yue2Token,
            denyMessage: "音乐 API 仅允许本机画布访问",
        });
    }
    if (env.FIRERED_REMOTE_URL && fireredToken) {
        rules.push({
            prefix: "/firered",
            target: env.FIRERED_REMOTE_URL,
            rewrite: (p) => p.slice("/firered".length) || "/",
            mode: "bearer",
            bearerToken: fireredToken,
            denyMessage: "FireRedAudio API 仅允许本机画布访问",
        });
    }
    rules.push(
        {
            prefix: "/dreammaker/api",
            target: dreammakerAuth.gateway,
            rewrite: (p) => p.replace(/^\/dreammaker/, "") || "/",
            mode: "dreammaker",
        },
        {
            prefix: "/dreammaker/static",
            target: dreammakerAuth.gateway,
            rewrite: (p) => p.replace(/^\/dreammaker/, "") || "/",
            mode: "dreammaker",
        },
    );

    app.get("/dreammaker/health", (req: Request, res: Response) => {
        if (!isLoopbackCanvasRequest(req)) {
            res.status(403).end("DreamMaker 代理仅允许本机画布访问");
            return;
        }
        res.json({
            ok: true,
            configured: Boolean(dreammakerAuth.accessKey && dreammakerAuth.secretKey && dreammakerAuth.user),
            gateway: dreammakerAuth.gateway,
        });
    });

    app.get("/dreammaker/download", async (req: Request, res: Response) => {
        if (!isLoopbackCanvasRequest(req)) {
            res.status(403).end("DreamMaker 下载代理仅允许本机画布访问");
            return;
        }
        const targetUrl = String(req.query.url || "");
        if (!isSafeRemoteHttpsUrl(targetUrl)) {
            res.status(400).end("无效的下载地址");
            return;
        }
        try {
            const upstream = await fetch(targetUrl, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
                },
            });
            const contentType = upstream.headers.get("content-type");
            res.status(upstream.status);
            if (contentType) res.setHeader("Content-Type", contentType);
            const contentLength = upstream.headers.get("content-length");
            if (contentLength) res.setHeader("Content-Length", contentLength);
            if (!upstream.body) {
                res.end();
                return;
            }
            Readable.fromWeb(upstream.body as never).pipe(res);
        } catch (error) {
            res.status(502).end(error instanceof Error ? error.message : "下载失败");
        }
    });

    app.use((req: Request, res: Response, next: NextFunction) => {
        const matched = rules.find((rule) => matchesPrefix(req.path, rule.prefix));
        if (!matched) {
            next();
            return;
        }
        if (matched.mode === "bearer") {
            if (!isLoopbackCanvasRequest(req)) {
                res.status(403).end(matched.denyMessage || "仅允许本机画布访问");
                return;
            }
            forwardHttpRequest(req, res, matched.target, matched.rewrite(req.originalUrl), {
                authorization: `Bearer ${matched.bearerToken}`,
            });
            return;
        }
        if (matched.mode === "dreammaker") {
            if (!isLoopbackCanvasRequest(req)) {
                res.status(403).end("DreamMaker API 仅允许本机画布访问");
                return;
            }
            if (!dreammakerAuth.accessKey || !dreammakerAuth.secretKey || !dreammakerAuth.user) {
                res.status(503).json({
                    code: 503,
                    message: "DreamMaker 凭据未配置：请在 ~/.dm-cli/config.yaml 或环境变量配置 DM_CLI_ACCESS_KEY / DM_CLI_SECRET_KEY / DM_CLI_USER",
                });
                return;
            }
            forwardHttpRequest(req, res, matched.target, matched.rewrite(req.originalUrl), {
                authorization: `Bearer ${makeDreamMakerJwt(dreammakerAuth.accessKey, dreammakerAuth.secretKey)}`,
                "x-real-user": dreammakerAuth.user,
            });
            return;
        }
        if (!isLoopbackCanvasRequest(req)) {
            res.status(403).end("仅允许本机画布访问");
            return;
        }
        forwardHttpRequest(req, res, matched.target, matched.rewrite(req.originalUrl), {});
    });

    return { enabled: true, prefixes: rules.map((r) => r.prefix) };
}
