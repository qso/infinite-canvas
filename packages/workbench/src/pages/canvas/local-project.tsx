import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Button } from "@infinite-canvas/plugin-sdk/ui/button";
import CanvasProjectPage from "@workbench/pages/canvas/project";
import { isDshEmbed, resolveCanvasMcpClientId } from "@workbench/lib/embed-mode";
import { storagePageId } from "@workbench/services/storage/http";
import { ImageThumbnail } from "@workbench/components/image-thumbnail";
import { useCanvasStore, type CanvasProject } from "@workbench/stores/canvas/use-canvas-store";

function SavedCanvas({ project }: { project: CanvasProject }) {
    const nodes = new Map(project.nodes.map(node => [node.id, node]));
    if (!nodes.size) return <p>空白画布</p>;
    const bounds = project.nodes.reduce((box, { position, width, height }) => ({
        left: Math.min(box.left, position.x), top: Math.min(box.top, position.y),
        right: Math.max(box.right, position.x + width), bottom: Math.max(box.bottom, position.y + height),
    }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
    return <svg className="w-full h-3/4" aria-label={project.title}
        viewBox={[bounds.left - 20, bounds.top - 20, bounds.right - bounds.left + 40, bounds.bottom - bounds.top + 40].join(" ")}>
        {project.connections.map(edge => {
            const from = nodes.get(edge.fromNodeId), to = nodes.get(edge.toNodeId);
            return from && to && <line key={edge.id} x1={from.position.x + from.width} y1={from.position.y + from.height / 2}
                x2={to.position.x} y2={to.position.y + to.height / 2} stroke="currentColor" strokeWidth="3" opacity=".6" />;
        })}
        {project.nodes.map(node => <foreignObject key={node.id} x={node.position.x} y={node.position.y} width={node.width} height={node.height}>
            <div className="h-full overflow-hidden rounded-xl border bg-card p-3">
                <strong>{node.title || node.type}</strong>
                {node.type === "text" && typeof node.metadata?.content === "string" && <p className="whitespace-pre-wrap">{node.metadata.content}</p>}
                {node.type === "image" && <ImageThumbnail storageKey={node.metadata?.storageKey ?? node.metadata?.images?.find(image => image.storageKey)?.storageKey} alt={node.title} className="h-4/5" />}
            </div>
        </foreignObject>)}
    </svg>;
}

function EditorGate({ id }: { id: string }) {
    const [state, setState] = useState<"waiting" | "editor" | "observer" | "offline">("waiting");
    const [attempt, setAttempt] = useState(0);
    const project = useCanvasStore(store => store.projects.find(item => item.id === id));
    useEffect(() => {
        let active = true;
        const query = new URLSearchParams({ project: id, writer: storagePageId, clientId: resolveCanvasMcpClientId(), exclusive: isDshEmbed() ? "1" : "0" });
        const socket = new WebSocket(`ws://${location.host}/canvas/editor?${query}`);
        socket.onmessage = async event => {
            if (!active) return;
            if (JSON.parse(event.data).state === "observer") { setState("observer"); return; }
            try {
                await useCanvasStore.getState().reloadProject(id);
                if (active && socket.readyState === WebSocket.OPEN) setState("editor");
            } catch { if (active) { setState("offline"); socket.close(); } }
        };
        socket.onclose = () => { if (active) setState("offline"); };
        return () => {
            active = false;
            void useCanvasStore.getState().flush(id).finally(() => socket.close()).catch(console.error);
        };
    }, [id, attempt]);
    useEffect(() => {
        if (!isDshEmbed() || window.parent === window) return;
        const prepare = (event: MessageEvent) => {
            if (event.source !== window.parent || event.data?.type !== "dsh-canvas-flush" || event.data.projectId !== id) return;
            const reply = event.ports[0];
            if (!reply) return;
            void useCanvasStore.getState().flush(id).then(() => reply.postMessage({ ok: true }),
                error => reply.postMessage({ ok: false, error: String(error) })).finally(() => reply.close());
        };
        window.addEventListener("message", prepare);
        return () => window.removeEventListener("message", prepare);
    }, [id]);
    if (state === "editor") return <CanvasProjectPage />;
    return <main className="h-full overflow-auto p-6">
        <h2>{project?.title ?? "画布"}</h2>
        <p role="status">{state === "observer" ? "只读预览 · 另一窗口正在编辑。对方释放画布后可接手。" : state === "offline" ? "编辑连接已断开" : "正在打开画布…"}</p>
        {state === "observer" && project && <SavedCanvas project={project} />}
        {state !== "waiting" && <Button onClick={() => { setState("waiting"); setAttempt(n => n + 1); }}>重新获取编辑权</Button>}
    </main>;
}

export default function LocalCanvasProject() {
    const { id = "" } = useParams();
    return <EditorGate key={id} id={id} />;
}
