import { mkdir, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { buildH3Workflow, type H3Mode } from "../src/services/api/comfyui-h3-workflow";

// Explicit, opt-in GPU integration check. Saves request, task id, history and MP4 under ignored data/.
const mode = process.argv[2] as H3Mode;
if (!["text", "frames", "reference"].includes(mode)) throw new Error("Usage: bun scripts/test-h3-live.ts text|frames|reference [local image/video/audio files]");
const endpoint = process.env.H3_TEST_URL || process.env.COMFYUI_REMOTE_URL || "";
if (!endpoint) throw new Error("Missing endpoint: set COMFYUI_REMOTE_URL in web/.env.local (bun loads it automatically) or pass H3_TEST_URL.");
const runId = `h3-${mode}-${crypto.randomUUID()}`;
const directory = `../data/h3-tests/${runId}`;
await mkdir(directory, { recursive: true });
const images: string[] = [];
const videos: string[] = [];
const audios: string[] = [];
for (const path of process.argv.slice(3)) {
    const form = new FormData();
    form.append("image", Bun.file(path), basename(path));
    form.append("subfolder", `ai-creative-studio/${runId}`);
    const response = await fetch(`${endpoint}/upload/image`, { method: "POST", body: form });
    if (!response.ok) throw new Error(await response.text());
    const uploaded = await response.json() as { name: string; subfolder: string };
    const target = /\.(mp4|webm|mov)$/i.test(path) ? videos : /\.(wav|mp3|m4a)$/i.test(path) ? audios : images;
    target.push([uploaded.subfolder, uploaded.name].filter(Boolean).join("/"));
}
const prompt = mode === "reference"
    ? "Use <Picture 1> as the visual reference. A slow cinematic camera move around the subject, soft daylight, coherent shape and colors, gentle ambient sounds. One continuous shot."
    : mode === "frames"
      ? "Starting from the provided first frame, a gentle cinematic camera push in. The subject moves slightly in a soft breeze, consistent colors and shape, natural ambient sounds. One continuous shot."
      : "A red ceramic teapot on a wooden table beside a sunny window. A gentle ribbon of steam rises from the spout. Slow camera push in, warm afternoon light, realistic reflections, soft ambient room tone. One continuous shot.";
const graph = buildH3Workflow({ mode, prompt, width: 864, height: 480, seconds: 5, seed: 457, images, videos, audios, generateAudio: true, outputPrefix: `ai-creative-studio/tests/${runId}` });
await writeFile(`${directory}/request.json`, JSON.stringify(graph, null, 2));
const createdAt = Date.now();
const response = await fetch(`${endpoint}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: graph, client_id: runId }) });
const created = await response.json() as { prompt_id?: string; error?: unknown; node_errors?: unknown };
await writeFile(`${directory}/task.json`, JSON.stringify({ ...created, mode, endpoint, createdAt }, null, 2));
if (!response.ok || !created.prompt_id) throw new Error(JSON.stringify(created));
console.log(JSON.stringify({ mode, prompt_id: created.prompt_id, directory, status: "submitted" }));
let lastStage = "";
for (;;) {
    const historyResponse = await fetch(`${endpoint}/history/${created.prompt_id}`);
    if (!historyResponse.ok) throw new Error(`History returned ${historyResponse.status}; task id is saved in ${directory}/task.json`);
    const history = await historyResponse.json() as Record<string, any>;
    const entry = history[created.prompt_id];
    if (entry) {
        await writeFile(`${directory}/history.json`, JSON.stringify(entry, null, 2));
        if (entry.status?.status_str === "error") throw new Error(JSON.stringify(entry.status));
        if (entry.status?.completed) {
            const output = Object.values(entry.outputs?.["14"] || {}).flat().find((value: any) => value?.filename?.endsWith(".mp4")) as { filename: string; subfolder: string; type: string } | undefined;
            if (!output) throw new Error(`No MP4 in SaveVideo output: ${JSON.stringify(entry.outputs)}`);
            const videoResponse = await fetch(`${endpoint}/view?${new URLSearchParams(output)}`);
            if (!videoResponse.ok) throw new Error(`Video download failed: ${videoResponse.status}`);
            await writeFile(`${directory}/result.mp4`, Buffer.from(await videoResponse.arrayBuffer()));
            const result = { mode, prompt_id: created.prompt_id, seconds_elapsed: (Date.now() - createdAt) / 1000, output, file: `${directory}/result.mp4` };
            await writeFile(`${directory}/result.json`, JSON.stringify(result, null, 2));
            console.log(JSON.stringify(result));
            break;
        }
    }
    const queue = await (await fetch(`${endpoint}/queue`)).json() as { queue_running: any[]; queue_pending: any[] };
    const stage = queue.queue_running.some((item) => item[1] === created.prompt_id) ? "running" : queue.queue_pending.some((item) => item[1] === created.prompt_id) ? "queued" : "reconciling";
    if (stage !== lastStage) { console.log(JSON.stringify({ status: stage, elapsed_seconds: Math.round((Date.now() - createdAt) / 1000) })); lastStage = stage; }
    await Bun.sleep(2500);
}
