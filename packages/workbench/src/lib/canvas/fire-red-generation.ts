import { createFireRedTask, fireRedAudioToFile, getFireRedTaskContent, uploadFireRedAudio, waitForFireRedTask } from "@workbench/services/api/firered";
import type { FireRedSpeechMode, FireRedTaskRequest } from "@workbench/constant/firered";
import type { ReferenceAudio } from "@workbench/types/media";

type RunOptions = { signal: AbortSignal; onTaskId: (id: string) => void; onStage?: (stage: string) => void };

export type FireRedSpeechSettings = {
    mode: FireRedSpeechMode;
    transcript: string;
    voiceDescription: string;
    language: "auto" | "zh" | "en";
    seed: string;
};

export async function runFireRedSpeechTask(prompt: string, settings: FireRedSpeechSettings, referenceAudios: ReferenceAudio[], options: RunOptions): Promise<{ blob: Blob; durationMs: number | null; editedText: string | null }> {
    const seed = parseSeed(settings.seed);
    const id = crypto.randomUUID();
    if (settings.mode === "edit") {
        const target = referenceAudios[0];
        if (!target) throw new Error("语音编辑需要连接目标音频");
        const audioId = await uploadFireRedAudio(await fireRedAudioToFile(target, options), options);
        const task = await waitFor(id, { id, type: "edit", audio_id: audioId, instruction: prompt, seed }, options);
        return finishAudio(task, options);
    }
    if (settings.mode === "design") {
        if (!settings.voiceDescription.trim()) throw new Error("请先在音频设置里填写声音描述");
        const task = await waitFor(id, { id, type: "tts", mode: "design", text: prompt, prompt_transcript: null, voice_description: settings.voiceDescription.trim(), language: resolveLanguage(settings.language, prompt), seed, audio_id: null }, options);
        return finishAudio(task, options);
    }
    const reference = referenceAudios[0];
    if (!reference) throw new Error("声音克隆需要连接参考音频（建议 5–10 秒清晰人声）");
    const audioId = await uploadFireRedAudio(await fireRedAudioToFile(reference, options), options);
    const task = await waitFor(id, { id, type: "tts", mode: "clone", text: prompt, prompt_transcript: settings.transcript.trim() || null, voice_description: null, language: resolveLanguage(settings.language, prompt), seed, audio_id: audioId }, options);
    return finishAudio(task, options);
}

export async function runFireRedUnderstandTask(prompt: string, referenceAudios: ReferenceAudio[], thinking: boolean, options: RunOptions): Promise<{ text: string; reasoning: string | null }> {
    if (!referenceAudios.length) throw new Error("请连接要识别的音频参考");
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
    if (!text) throw new Error(task.error || "没有识别出文本内容");
    return { text, reasoning: task.result?.reasoning || null };
}

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

export async function resumeFireRedTextResult(taskId: string, options: { signal?: AbortSignal }): Promise<string> {
    const task = await waitForFireRedTask(taskId, options);
    const text = task.result?.text?.trim();
    if (!text) throw new Error(task.error || "没有识别出文本内容");
    return text;
}

export async function resumeFireRedAudio(taskId: string, options: { signal?: AbortSignal }): Promise<Blob> {
    const task = await waitForFireRedTask(taskId, options);
    return getFireRedTaskContent(task.id, options);
}

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
