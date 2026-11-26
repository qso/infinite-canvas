// FireRedAudio 常量与类型。服务部署在第二台 RTX 5090（与 YuE2 音乐服务同机，端口 8191），
// 前端经 vite 代理 /firered 直连（token 由代理服务端注入，见 vite.config.ts）。
export const FIRERED_ENDPOINT = "/firered";
export const FIRERED_POLL_INTERVAL_MS = 3000;
export const FIRERED_POLL_ATTEMPTS = 600; // 单任务轮询窗口 30 分钟（含每次子进程加载模型的时间）。

export const FIRERED_SPEECH_OPTION = "firered::FireRedAudio"; // audio 能力：TTS 克隆 / 声音设计 / 语义编辑
export const FIRERED_UNDERSTAND_OPTION = "firered::FireRedAudio-ASR"; // text 能力：ASR / 音频理解

export function isFireRedSpeech(value: string) {
    return /^fireredaudio$/i.test(value.split("::").at(-1)?.trim() || "");
}

export function isFireRedUnderstand(value: string) {
    return /^fireredaudio-asr$/i.test(value.split("::").at(-1)?.trim() || "");
}

export function isFireRedModel(value: string) {
    return isFireRedSpeech(value) || isFireRedUnderstand(value);
}

export type FireRedTaskStatus = "queued" | "running" | "completed" | "failed";
export type FireRedSpeechMode = "clone" | "design" | "edit";

export type FireRedTaskRequest =
    | { id: string; type: "tts"; mode: "clone" | "design"; text: string; prompt_transcript: string | null; voice_description: string | null; language: "zh" | "en"; seed: number | null; audio_id: string | null }
    | { id: string; type: "edit"; audio_id: string; instruction: string; seed: number | null }
    | { id: string; type: "edit_acoustic"; audio_id: string; speed: number | null; pitch: number | null; volume: number | null; seed: number | null }
    | { id: string; type: "asr"; audio_ids: string[] }
    | { id: string; type: "understand"; audio_ids: string[]; prompt: string; thinking: boolean };

export type FireRedTaskResult = {
    mime_type?: string;
    sample_rate?: number;
    duration_ms?: number | null;
    bytes?: number;
    audio?: string;
    text?: string;
    reasoning?: string | null;
    edited_text?: string | null;
    used_transcript?: string | null;
    applied?: string[];
};

export type FireRedTask = {
    id: string;
    status: FireRedTaskStatus;
    stage: string;
    request: { id: string } & Record<string, unknown>;
    result: FireRedTaskResult | null;
    error: string | null;
};

// 声学编辑固定模板参数边界（官方训练模板：语速 0.5–2.0、音调 ±6 半音、音量 0.3–2.0）。
export const FIRERED_ACOUSTIC_LIMITS = { speed: { min: 0.5, max: 2, step: 0.1, neutral: 1 }, pitch: { min: -6, max: 6, step: 1, neutral: 0 }, volume: { min: 0.3, max: 2, step: 0.1, neutral: 1 } };
