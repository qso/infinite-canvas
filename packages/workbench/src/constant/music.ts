export const MUSIC_MODEL = "YuE2-3B";
export const MUSIC_ENDPOINT = "/yue2";
export const MUSIC_POLL_INTERVAL_MS = 2500;
export const MUSIC_POLL_ATTEMPTS = 240;

export type MusicPlanningMode = "full" | "melody" | "off";
export type MusicFormat = "wav" | "flac";
export type MusicOutputType = "song" | "instrumental";
export type MusicCreationMode = "original" | "melody" | "full" | "style";
export type MusicAnalysisSource = { audio_id: string | null; music_task_id: string | null };
export type MusicAnalysisRequest = { id: string; source: MusicAnalysisSource; score: boolean; style: boolean; lyrics: boolean };
export type MusicAnalysisResult = {
    abc_full: string | null;
    abc_melody: string | null;
    style: string | null;
    lyrics: string | null;
    source_lyrics?: string;
    warnings: string[];
    source: MusicAnalysisSource;
    version: string;
};
export type MusicAnalysisTask = { id: string; request: MusicAnalysisRequest; status: MusicTaskStatus; stage: string; result: MusicAnalysisResult | null; error: string | null };
export type MusicSamplingDraft = { temperature: string; topP: string; topK: string; repetitionPenalty: string };
export type MusicGenerationParams = {
    style: string;
    lyrics: string;
    cot: MusicPlanningMode;
    output_type: MusicOutputType;
    seed: number | null;
    cfg_scale: number | null;
    steps: number;
    temperature: number;
    abc: string | null;
    format: MusicFormat;
    reference?: { analysis_id: string; mode: Exclude<MusicCreationMode, "original">; style_override?: string | null } | null;
    abc_temperature?: number;
    abc_top_p?: number;
    abc_top_k?: number;
    abc_repetition_penalty?: number;
    top_p?: number;
    top_k?: number;
    repetition_penalty?: number;
};
export type MusicGenerationDraft = {
    style: string;
    lyrics: string;
    cot: MusicPlanningMode;
    outputType?: MusicOutputType;
    seed: string;
    cfgScale: string;
    steps: string;
    temperature: string;
    abc: string;
    format: MusicFormat;
    creationMode?: MusicCreationMode;
    referenceNodeId?: string;
    abcSampling?: MusicSamplingDraft;
    semanticSampling?: Omit<MusicSamplingDraft, "temperature">;
};
export type MusicGenerationRequest = Readonly<MusicGenerationParams & { id: string; model: typeof MUSIC_MODEL }>;
export type MusicTaskStatus = "queued" | "running" | "completed" | "failed";
export type MusicGenerationOutput = {
    mime_type: string;
    sample_rate: number;
    duration_ms: number;
    bytes: number;
    has_score: boolean;
    truncated: { abc: boolean; semantic: boolean };
    output_type?: MusicOutputType;
    instrumental?: { vocal_notes: number | null; affected_ins_notes: number } | null;
    used_input?: { style: string; lyrics: string; abc: string | null; cot: MusicPlanningMode };
};

export const DEFAULT_MUSIC_DRAFT: MusicGenerationDraft = {
    style: "",
    lyrics: "",
    cot: "full",
    seed: "",
    cfgScale: "",
    steps: "32",
    temperature: "1",
    abc: "",
    format: "wav",
};
