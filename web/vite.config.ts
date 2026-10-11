import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from "vite";

import { parseChangelog } from "./src/lib/release";
import { COMFYUI_PROXY_PATH } from "./src/constant/comfyui";

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

export default defineConfig(({ mode }) => {
    // 固定云端转发目标仅由本地服务配置提供，密钥不暴露给浏览器。
    const env = loadEnv(mode, webDir, "");
    const comfyuiRemoteUrl = env.COMFYUI_REMOTE_URL;
    const comfyuiProxy: Record<string, ProxyOptions> = comfyuiRemoteUrl
        ? {
            [COMFYUI_PROXY_PATH]: {
                target: comfyuiRemoteUrl,
                changeOrigin: true,
                rewrite: (path: string) => path.slice(COMFYUI_PROXY_PATH.length),
                // ComfyUI receives a same-server request; the browser only talks to its own Vite origin.
                configure: (proxy) => { proxy.on("proxyReq", (request) => request.removeHeader("origin")); },
            },
        }
        : {};
    const yue2TokenPath = resolve(webDir, "../data/yue2-api.token");
    const yue2Token = env.YUE2_API_TOKEN || (existsSync(yue2TokenPath) ? readFileSync(yue2TokenPath, "utf8").trim() : "");
    const musicProxy: Record<string, ProxyOptions> = env.YUE2_REMOTE_URL && yue2Token
        ? {
            "/yue2": {
                target: env.YUE2_REMOTE_URL,
                changeOrigin: true,
                rewrite: (path: string) => path.slice("/yue2".length),
                configure: (proxy) => {
                    proxy.on("proxyReq", (request, incoming, response) => {
                        // The browser must originate from this local canvas, not an unrelated website.
                        const origin = incoming.headers.origin;
                        const address = incoming.socket.remoteAddress || "";
                        const loopback = address === "::1" || /^(?:::ffff:)?127\./.test(address);
                        if (!loopback || incoming.headers["sec-fetch-site"] === "cross-site" || (origin && origin !== `http://${incoming.headers.host}` && origin !== `https://${incoming.headers.host}`)) {
                            request.destroy();
                            response.writeHead(403).end("音乐 API 仅允许本机画布访问");
                            return;
                        }
                        request.setHeader("authorization", `Bearer ${yue2Token}`);
                        request.removeHeader("origin");
                        request.removeHeader("cookie");
                    });
                },
            },
        }
        : {};
    const proxy = { ...comfyuiProxy, ...musicProxy };
    return {
        server: { proxy, fs: { deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/yue2-api.token"] } },
        preview: { proxy },
        base: process.env.VITE_BASE || "/",
        plugins: [react(), localPluginsManifest()],
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
