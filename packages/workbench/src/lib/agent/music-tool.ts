import { z } from "zod";
import { defineCommand, type CommandContext } from "@infinite-canvas/plugin-sdk";
import { agentTools, commands } from "@infinite-canvas/plugin-sdk/builtin";
import { CanvasNodeType, type CanvasNodeMetadata } from "@infinite-canvas/shared/canvas/schema/canvas";
import { DEFAULT_MUSIC_DRAFT, MUSIC_ENDPOINT } from "@workbench/constant/music";
import { builtinPlugin } from "@workbench/lib/plugins/registry";
import { audioMetadata, createCanvasNode } from "@workbench/lib/canvas/canvas-node-factory";
import { buildMusicGenerationRequest } from "@workbench/lib/canvas/canvas-generation-helpers";
import type { CanvasSession } from "@workbench/lib/canvas/canvas-session";
import { createMusicGenerationTask, getMusicGenerationContent, waitForMusicGenerationTask } from "@workbench/services/api/music";
import { uploadMediaFile } from "@workbench/services/file-storage";
import { storage } from "@workbench/services/storage/runtime";

const input = z.object({ style: z.string().min(1), lyrics: z.string().optional(), instrumental: z.boolean().optional(), autoRun: z.boolean().optional() }).strict();
const command = defineCommand({
    id: "builtin:yue2-music", scope: "project", input,
    output: z.object({ nodeId: z.string(), taskId: z.string().nullable(), submitted: z.boolean() }),
});

export function registerMusicAgentTool(session: CanvasSession) {
    const source = { kind: "agent" as const };
    const patch = (id: string, metadata: CanvasNodeMetadata) => session.transact([{ type: "update_node", id, metadata }], { source });
    const run = async (args: z.infer<typeof input>, context: CommandContext) => {
        context.signal.throwIfAborted();
        const draft = { ...DEFAULT_MUSIC_DRAFT, style: args.style, lyrics: args.lyrics || "", outputType: args.instrumental ? "instrumental" as const : "song" as const };
        const request = buildMusicGenerationRequest(crypto.randomUUID(), draft);
        const right = session.getSnapshot().nodes.reduce((x, node) => Math.max(x, node.position.x + node.width), 0);
        const node = createCanvasNode(CanvasNodeType.Music, { x: right + 300, y: 200 }, { musicDraft: draft });
        node.title = args.style.slice(0, 32);
        session.transact([{ type: "add_node", node }], { source });
        if (!args.autoRun) {
            await session.flush();
            return { nodeId: node.id, taskId: null, submitted: false };
        }
        patch(node.id, { musicRequest: { ...request }, musicTaskId: request.id, musicTaskEndpoint: MUSIC_ENDPOINT, musicTaskStatus: "queued", status: "loading" });
        await session.flush();
        try {
            await createMusicGenerationTask(request, { signal: AbortSignal.any([session.signal, context.signal]) });
        } catch (error) {
            if (!session.signal.aborted) patch(node.id, { status: "error", musicError: String(error) });
            throw error;
        }
        // The submitted generation lives with the canvas after the tool returns.
        const finish = async () => {
            const signal = session.signal;
            const task = await waitForMusicGenerationTask(request.id, { signal });
            if (task.status !== "completed" || !task.output) throw new Error(task.error || "音乐生成失败");
            const file = await uploadMediaFile(await getMusicGenerationContent(request.id, { signal }), "audio", signal);
            try {
                signal.throwIfAborted();
                if (session.getSnapshot().nodes.find(row => row.id === node.id)?.metadata?.musicTaskId !== request.id) throw new Error("音乐节点已变化");
                patch(node.id, { ...audioMetadata(file), musicTaskStatus: "completed", durationMs: task.output.duration_ms });
            } catch (error) {
                await storage.media.removeItem(file.storageKey);
                throw error;
            }
        };
        void finish().catch(error => {
            if (!session.signal.aborted && session.getSnapshot().nodes.find(row => row.id === node.id)?.metadata?.musicTaskId === request.id) {
                patch(node.id, { status: "error", musicError: String(error), errorDetails: String(error) });
            }
        });
        return { nodeId: node.id, taskId: request.id, submitted: true };
    };
    const unregister = builtinPlugin.extensions.contribute(commands, { id: command.id, value: { command, title: "YuE2 音乐生成", run } });
    const hide = builtinPlugin.extensions.contribute(agentTools, { id: command.id, value: { command, description: "Create a YuE2 music node. Provide style and optional lyrics or instrumental. Set autoRun to submit once; inspect the returned node with generation_get_status." } });
    return () => { hide(); unregister(); };
}
