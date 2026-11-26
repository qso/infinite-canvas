import { Download, FolderPlus, Info, Music2, RefreshCw, SlidersHorizontal, Sparkles, Trash2, Video } from "lucide-react";
import type { NodeToolContribution } from "@infinite-canvas/plugin-sdk";
import { canvasApply, nodeRetry, nodeTools } from "@infinite-canvas/plugin-sdk/builtin";
import { CanvasNodeType, isWebVideoTaskOwner } from "@infinite-canvas/shared/canvas/schema/canvas";
import { isFireRedSpeech } from "@workbench/constant/firered";
import { builtinPlugin } from "@workbench/lib/plugins/registry";
import { hostActions, runNodeCommand } from "@workbench/lib/canvas/host-actions";
import { hasNodeMedia } from "@workbench/lib/media-source";
import { models } from "@workbench/services/api/models/runtime";
import { useConfigStore } from "@workbench/stores/use-config-store";

export function registerBuiltinMediaTools() {
    const disposers = [CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Music].flatMap((kind) => {
        const tools: Array<[string, NodeToolContribution["resolve"]]> = [
            ["info", (ctx) => ({ title: "查看节点信息", label: "信息", icon: <Info className="size-4" />, run: () => hostActions.nodeOpenInfo({ nodeId: ctx.node.id }) })],
            ["delete", (ctx) => ({ title: "移除节点", label: "删除", icon: <Trash2 className="size-4" />, danger: true, run: runNodeCommand(ctx, canvasApply, { ops: [{ type: "delete_node", ids: [ctx.node.id] }] }) })],
        ];
        if (kind === CanvasNodeType.Video) {
            tools.push(["query-task", (ctx) => {
                const task = ctx.node.metadata?.webVideoTask;
                if (!task || models.tasks || !ctx.scope.projectId || !isWebVideoTaskOwner(ctx.scope.projectId, ctx.node, task) || (!task.paused && ctx.node.metadata?.status === "loading")) return null;
                return { title: "使用任务 ID 查询视频生成状态", label: "获取任务状态", icon: <RefreshCw className="size-4" />, run: runNodeCommand(ctx, nodeRetry, { nodeId: ctx.node.id }) };
            }]);
            tools.push(["promote-1080p", (ctx) => hasNodeMedia(ctx.node) && ctx.node.metadata?.dmDraftTaskId
                ? { title: "将 Seedance 草稿升为 1080p 正式成片", label: "升 1080p", icon: <Sparkles className="size-4" />, run: () => hostActions.nodePromoteVideoDraft({ nodeId: ctx.node.id, resolution: "1080p" }) } : null]);
            tools.push(["promote-4k", (ctx) => hasNodeMedia(ctx.node) && ctx.node.metadata?.dmDraftTaskId
                ? { title: "将 Seedance 草稿升为 4K 正式成片", label: "升 4K", icon: <Sparkles className="size-4" />, run: () => hostActions.nodePromoteVideoDraft({ nodeId: ctx.node.id, resolution: "4k" }) } : null]);
        }
        if (kind === CanvasNodeType.Audio) {
            tools.push(["acoustic-edit", (ctx) => {
                if (!hasNodeMedia(ctx.node)) return null;
                const cfg = useConfigStore.getState().config;
                const model = ctx.node.metadata?.model || cfg.audioModel || cfg.model;
                return isFireRedSpeech(model)
                    ? { title: "调节语速、音调和音量并派生新音频", label: "声学调节", icon: <SlidersHorizontal className="size-4" />, run: () => hostActions.nodeOpenAcousticEdit({ nodeId: ctx.node.id }) }
                    : null;
            }]);
        }
        tools.push(["retry", (ctx) => ctx.node.metadata?.status === "error" && !ctx.node.metadata.webVideoTask && kind !== CanvasNodeType.Music
            ? { title: "重新生成", label: "重试", icon: <RefreshCw className="size-4" />, run: runNodeCommand(ctx, nodeRetry, { nodeId: ctx.node.id }) } : null]);
        if (kind === CanvasNodeType.Video) tools.push(["save-asset", (ctx) => hasNodeMedia(ctx.node)
            ? { title: "加入我的资产", label: "存资产", icon: <FolderPlus className="size-4" />, run: () => hostActions.nodeSaveAsset({ nodeId: ctx.node.id }) } : null]);
        tools.push(["download", (ctx) => hasNodeMedia(ctx.node)
            ? { title: kind === CanvasNodeType.Video ? "下载视频" : "下载音频", label: "下载", icon: <Download className="size-4" />, run: () => hostActions.nodeDownloadResource({ nodeId: ctx.node.id }) } : null]);
        if (kind !== CanvasNodeType.Music) {
            const name = kind === CanvasNodeType.Audio ? "音频" : "视频";
            tools.push(["replace", (ctx) => ({ title: `${hasNodeMedia(ctx.node) ? "替换" : "上传"}${name}`, label: `${hasNodeMedia(ctx.node) ? "替换" : "上传"}${name}`, icon: kind === CanvasNodeType.Audio ? <Music2 className="size-4" /> : <Video className="size-4" />, run: () => hostActions.canvasOpenMediaPicker({ nodeId: ctx.node.id }) })]);
        }
        return tools.map(([id, resolve]) => builtinPlugin.extensions.contribute(nodeTools, {
            id: `builtin:${kind}-${id}`,
            value: { resolve: (ctx) => ctx.node.type === kind ? resolve(ctx) : null },
        }));
    });
    return () => { for (const dispose of disposers) dispose(); };
}
