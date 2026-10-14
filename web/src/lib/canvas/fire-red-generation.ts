import i18n from "@/i18n";
import { createFireRedTask, fireRedAudioToFile, getFireRedTaskContent, uploadFireRedAudio, waitForFireRedTask } from "@/services/api/firered";
import type { FireRedSpeechMode, FireRedTaskRequest } from "@/constant/firered";
import type { ReferenceAudio } from "@/types/media";

type RunOptions = { signal: AbortSignal; onTaskId: (id: string) => void; onStage?: (stage: string) => void };

export type FireRedSpeechSettings = {
    mode: FireRedSpeechMode;
    transcript: string;
    voiceDescription: string;
    language: "auto" | "zh" | "en";
    seed: string;
};

/** 音频节点 FireRed 生成（TTS 克隆 / 声音设计 / 语义编辑）。prompt 为合成文本或编辑指令。 */
export async function runFireRedSpeechTask(prompt: string, settings: FireRedSpeechSettings, referenceAudios: ReferenceAudio[], options: RunOptions): Promise<{ blob: Blob; durationMs: number | null; editedText: string | null }> {
    const seed = parseSeed(settings.seed);
    const id = crypto.randomUUID();
    if (settings.mode === "edit") {
        const target = referenceAudios[0];
        if (!target) throw new Error(i18n.t("canvas.fireRed.editNeedsAudio"));
        const audioId = await uploadFireRedAudio(await fireRedAudioToFile(target, options), options);
        const task = await waitFor(id, { id, type: "edit", audio_id: audioId, instruction: prompt, seed }, options);
        return finishAudio(task, options);
    }
    if (settings.mode === "design") {
        if (!settings.voiceDescription.trim()) throw new Error(i18n.t("canvas.fireRed.descriptionRequired"));
        const task = await waitFor(id, { id, type: "tts", mode: "design", text: prompt, prompt_transcript: null, voice_description: settings.voiceDescription.trim(), language: resolveLanguage(settings.language, prompt), seed, audio_id: null }, options);
        return finishAudio(task, options);
    }
    const reference = referenceAudios[0];
    if (!reference) throw new Error(i18n.t("canvas.fireRed.cloneNeedsAudio"));
    const audioId = await uploadFireRedAudio(await fireRedAudioToFile(reference, options), options);
    const task = await waitFor(id, { id, type: "tts", mode: "clone", text: prompt, prompt_transcript: settings.transcript.trim() || null, voice_description: null, language: resolveLanguage(settings.language, prompt), seed, audio_id: audioId }, options);
    return finishAudio(task, options);
}

/** 文本节点 FireRed 识别与理解：prompt 为空 = 纯转写（asr），有内容 = 针对音频提问（understand）。 */
export async function runFireRedUnderstandTask(prompt: string, referenceAudios: ReferenceAudio[], thinking: boolean, options: RunOptions): Promise<{ text: string; reasoning: string | null }> {
    if (!referenceAudios.length) throw new Error(i18n.t("canvas.fireRed.understandNeedsAudio"));
    const audioIds: string[] = [];
    for (const audio of referenceAudios) {
        audioIds.push(await uploadFireRedAudio(await fireRedAudioToFile(audio, options), options));
    }
    const id = crypto.randomUUID();
    const request: FireRedTaskRequest = prompt.trim()
        ? { id, type: "understand", audio_ids: audioIds, prompt: prompt.trim(), thinking }
        : { id, type: "asr", audio_ids: audioIds };
    const task = await waitFor(id, request, options);
    const text = task.result?.text?.trim();
    if (!text) throw new Error(task.error || i18n.t("canvas.fireRed.emptyTranscript"));
    return { text, reasoning: task.result?.reasoning || null };
}

/** 音频节点 hover 声学调节：非中性参数逐项走官方固定模板，服务端单次任务内串行编辑。 */
export async function runFireRedAcousticEditTask(audio: ReferenceAudio, values: { speed: number; pitch: number; volume: number }, options: RunOptions): Promise<{ blob: Blob; durationMs: number | null; applied: string[] }> {
    const audioId = await uploadFireRedAudio(await fireRedAudioToFile(audio, options), options);
    const id = crypto.randomUUID();
    const request = {
        id, type: "edit_acoustic" as const, audio_id: audioId,
        speed: values.speed !== 1 ? values.speed : null,
        pitch: values.pitch !== 0 ? values.pitch : null,
        volume: values.volume !== 1 ? values.volume : null,
        seed: null,
    };
    const task = await waitFor(id, request, options);
    const blob = await getFireRedTaskContent(task.id, options);
    return { blob, durationMs: task.result?.duration_ms ?? null, applied: task.result?.applied || [] };
}

export function fireRedSpeechSettings(metadata: { audioFireRedMode?: string; audioFireRedTranscript?: string; audioFireRedVoiceDesc?: string; audioFireRedLanguage?: string; audioFireRedSeed?: string }): FireRedSpeechSettings {
    const mode = metadata.audioFireRedMode === "design" || metadata.audioFireRedMode === "edit" ? metadata.audioFireRedMode : "clone";
    return {
        mode,
        transcript: metadata.audioFireRedTranscript || "",
        voiceDescription: metadata.audioFireRedVoiceDesc || "",
        language: metadata.audioFireRedLanguage === "en" || metadata.audioFireRedLanguage === "zh" ? metadata.audioFireRedLanguage : "auto",
        seed: metadata.audioFireRedSeed || "",
    };
}

/** FireRed 节点快照：随节点保存模型、模式与参数，重试/恢复时按原参数重放。 */
export function fireRedSpeechMetadata(settings: FireRedSpeechSettings, model: string) {
    return {
        model,
        audioFireRedMode: settings.mode,
        audioFireRedTranscript: settings.transcript || undefined,
        audioFireRedVoiceDesc: settings.voiceDescription || undefined,
        audioFireRedLanguage: settings.language,
        audioFireRedSeed: settings.seed || undefined,
    };
}

/** 恢复文本任务（ASR/理解）：服务中断后任务记录仍在 SQLite，直接续轮询。 */
export async function resumeFireRedTextResult(taskId: string, options: { signal?: AbortSignal }): Promise<string> {
    const task = await waitForFireRedTask(taskId, options);
    const text = task.result?.text?.trim();
    if (!text) throw new Error(task.error || i18n.t("canvas.fireRed.emptyTranscript"));
    return text;
}

/** 恢复音频任务（TTS/编辑）：续轮询并取回成品音频。 */
export async function resumeFireRedAudio(taskId: string, options: { signal?: AbortSignal }): Promise<Blob> {
    const task = await waitForFireRedTask(taskId, options);
    return getFireRedTaskContent(task.id, options);
}

/** 语言“自动”：按目标文本是否含汉字判断（模型 TTS 只支持中英）。 */
function resolveLanguage(value: FireRedSpeechSettings["language"], text: string): "zh" | "en" {
    if (value === "zh" || value === "en") return value;
    return /[\u3400-\u9fff]/.test(text) ? "zh" : "en";
}

function parseSeed(seed: string): number | null {
    const value = Number(seed.trim());
    return seed.trim() && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

async function waitFor(id: string, request: Parameters<typeof createFireRedTask>[0], options: RunOptions) {
    options.onTaskId(id);
    const created = await createFireRedTask(request, options);
    return waitForFireRedTask(created.id, { signal: options.signal, onTask: (task) => options.onStage?.(task.stage) });
}

async function finishAudio(task: Awaited<ReturnType<typeof waitForFireRedTask>>, options: RunOptions) {
    const blob = await getFireRedTaskContent(task.id, options);
    return { blob, durationMs: task.result?.duration_ms ?? null, editedText: task.result?.edited_text ?? null };
}
