import { runPluginCommand } from "./plugins.js";
import path from "node:path";
import { homedir } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import open from "open";
import { startLocalServer, type LocalWeb } from "@infinite-canvas/server";
import { startMcpServer } from "@infinite-canvas/server/server/mcp";
import { DEFAULT_PORT, saveConfig } from "@infinite-canvas/server/config";
import { StorageError } from "@infinite-canvas/shared/storage-data";

export async function runCli(web: LocalWeb, entryUrl: string) {
    const desktop = process.env.INFINITE_CANVAS_DESKTOP_HOST === "1" && typeof process.send === "function";
    try {
        const { values, positionals } = parseArgs({
            allowPositionals: true,
            options: { registry: { type: "string" }, "data-dir": { type: "string", default: path.join(homedir(), ".infinite-canvas", "workspace") }, "shared-config-dir": { type: "string" }, port: { type: "string", default: String(DEFAULT_PORT) }, open: { type: "boolean" }, "skip-plugins": { type: "boolean" }, "no-save-config": { type: "boolean" }, help: { type: "boolean", short: "h" }, debug: { type: "boolean" } },
        });
        if (values.help) {
            console.log("用法：infinite-canvas serve [--data-dir <目录>] [--shared-config-dir <目录>] [--port <端口>] [--open] [--skip-plugins]\n      infinite-canvas mcp\n      infinite-canvas plugin add|update|remove|enable|disable|list|registry\n\nserve 启动画布并把业务数据保存在目录中；--shared-config-dir 可把渠道凭据、偏好与插件目录共享到公共目录。\nmcp 连接已启动的服务。\n--skip-plugins 本次跳过第三方插件启动，保留数据和启用选择，可在插件设置中逐个重新启用。\n需要 Node.js 22 或更高版本。按 Ctrl+C 停止服务。");
        } else if (positionals[0] === "plugin") {
            await runPluginCommand(positionals.slice(1), path.resolve(values["data-dir"]), values.registry);
        } else if (positionals.length === 1 && positionals[0] === "mcp") {
            await startMcpServer();
        } else if (positionals.length === 0 || positionals.length === 1 && positionals[0] === "serve") {
            const port = Number(values.port);
            if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("INVALID_PORT");
            const development = entryUrl.endsWith(".ts");
            const dataDirectory = path.resolve(values["data-dir"]);
            const sharedConfigDirectory = values["shared-config-dir"]?.trim() ? path.resolve(values["shared-config-dir"]) : undefined;
            const mcp = development ? { command: process.execPath, args: ["--import", import.meta.resolve("tsx"), fileURLToPath(entryUrl), "mcp"] } : { command: process.execPath, args: [fileURLToPath(entryUrl), "mcp"] };
            const urlFile = path.join(dataDirectory, ".canvas.url");
            const service = await startLocalServer({ dataDirectory, sharedConfigDirectory, web, port, skipThirdPartyPlugins: values["skip-plugins"], mcp: development ? mcp : undefined }).catch(async (error) => {
                // 同一目录已有服务在运行时直接复用它，不再启动第二个进程。
                if (desktop || !(error instanceof StorageError && error.code === "WORKSPACE_LOCKED")) throw error;
                const url = await readFile(urlFile, "utf8").catch(() => "");
                if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) throw error;
                const manifest = JSON.parse(await readFile(path.join(dataDirectory, "workspace.json"), "utf8"));
                const config = await fetch(`${url}/config`, { signal: AbortSignal.timeout(2500) }).then(response => response.json()).catch(() => null);
                if (!manifest.id || config?.workspaceId !== manifest.id) throw error;
                return url;
            });
            if (typeof service === "string") {
                console.log(`无限画布已在运行，直接使用已有服务\n打开地址：${service}\n数据目录：${dataDirectory}`);
                if (values.open) await open(service).catch(() => console.error("未能自动打开浏览器，请复制上方地址打开。"));
                return;
            }
            try {
                await writeFile(urlFile, service.url);
                if (!values["no-save-config"]) saveConfig({ url: service.url });
            } catch (error) {
                await service.close();
                throw error;
            }
            const stop = () => { void service.close().catch(() => { console.error("停止保存时遇到问题，请保留数据目录后重试。"); process.exitCode = 1; }).finally(() => { if (desktop && process.connected) process.disconnect(); }); };
            process.once("SIGINT", stop);
            process.once("SIGTERM", stop);
            if (desktop) {
                process.once("disconnect", stop);
                if (!process.connected) { await service.close(); return; }
                process.send!({ type: "ready", url: service.url }, (error: Error | null) => { if (error) stop(); });
                return;
            }
            console.log(`无限画布\n打开地址：${service.url}\n数据目录：${dataDirectory}\nMCP 地址：${service.url}/mcp`);
            console.log(JSON.stringify({ mcpServers: { "infinite-canvas": mcp } }, null, 2));
            if (values.open) await open(service.url).catch(() => console.error("未能自动打开浏览器，请复制上方地址打开。"));
        } else {
            throw new Error("INVALID_COMMAND");
        }
    } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : error instanceof Error ? error.message : "";
        const messages: Record<string, string> = {
            EADDRINUSE: "端口已被占用，请停止已有程序，或使用 --port 选择其他端口。",
            ENOENT: "找不到启动所需文件，请检查安装是否完整。",
            INVALID_PORT: "端口必须是 1 到 65535 之间的整数。",
            INVALID_COMMAND: "未知命令，请运行 infinite-canvas --help 查看用法。",
        };
        const message = error instanceof StorageError ? error.message : messages[String(code)] ?? "无法启动画布，请检查命令参数和数据目录权限。";
        console.error(message);
        if (desktop && process.connected) process.send!({ type: "failed", code: String(code) }, () => { if (process.connected) process.disconnect(); });
        process.exitCode = 1;
    }
}
