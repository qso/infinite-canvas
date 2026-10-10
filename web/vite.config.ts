import { readdirSync, readFileSync } from "node:fs";
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
    // 转发目标来自 web/.env.local 的 COMFYUI_REMOTE_URL；未配置时不注册代理。
    const comfyuiRemoteUrl = loadEnv(mode, webDir, "").COMFYUI_REMOTE_URL;
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
    return {
        server: { proxy: comfyuiProxy },
        preview: { proxy: comfyuiProxy },
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
