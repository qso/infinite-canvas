import type { WebSocket } from "ws";

// Ordinary browser windows keep the workbench's shared editing policy. A DSH
// editor needs exclusive ownership because each Agent saves complete snapshots.
export class ProjectEditors {
    private readonly projects = new Map<string, Map<WebSocket, { writer: string; exclusive: boolean }>>();

    private readonly observers = new Map<WebSocket, { clientId: string; projectId: string }>();

    get readOnlyClients() {
        return Object.fromEntries([...this.observers.values()].map(row => [row.clientId, row.projectId]));
    }

    connect(socket: WebSocket, projectId: string, writer: string, exclusive: boolean, clientId: string | null) {
        const editors = this.projects.get(projectId) ?? new Map<WebSocket, { writer: string; exclusive: boolean }>();
        if (editors.size && (exclusive || [...editors.values()].some(row => row.exclusive))) {
            socket.send(JSON.stringify({ state: "observer" }));
            if (clientId) this.observers.set(socket, { clientId, projectId });
            socket.once("close", () => this.observers.delete(socket));
            return;
        }
        this.projects.set(projectId, editors);
        editors.set(socket, { writer, exclusive });
        socket.once("close", () => {
            editors.delete(socket);
            if (!editors.size) this.projects.delete(projectId);
        });
        socket.send(JSON.stringify({ state: "editor" }));
    }

    permits(projectId: string, writer: string) {
        const editors = this.projects.get(projectId);
        return !editors || [...editors.values()].every(row => !row.exclusive || row.writer === writer);
    }
}
