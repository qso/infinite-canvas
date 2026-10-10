import { H3_DEFAULT_STEPS, H3_FAST_DEFAULT_STEPS, H3_MAX_STEPS } from "@/constant/comfyui";

export type ComfyWorkflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
export type H3Mode = "text" | "frames" | "reference";
export type H3WorkflowInput = {
    prompt: string;
    mode: H3Mode;
    width: number;
    height: number;
    seconds: number;
    seed: number;
    steps?: number;
    fast?: boolean;
    hd?: boolean;
    upscale?: number;
    refImageSize?: "match" | "max";
    images: string[];
    videos: string[];
    audios: string[];
    generateAudio: boolean;
    outputPrefix: string;
};

const H3_BASE_MODELS = {
    int8: {
        fl2va: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
        ref2va: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
        videoVae: "3_minimax_h3_video_vae_int8_convrot.safetensors",
    },
    bf16: {
        fl2va: "minimax_h3_fl2va_pruned_bf16.safetensors",
        ref2va: "minimax_h3_ref2va_pruned_bf16.safetensors",
        videoVae: "minimax_h3_video_vae_fp16.safetensors",
    },
};

export const H3_MODELS = {
    ...H3_BASE_MODELS.int8,
    clip: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    audioVae: "minimax_h3_audio_vae_fp32.safetensors",
};

export const H3_FAST_MODELS = {
    lora: "minimax_h3_DMAD_4step_full_lora_avg_rank_39_bf16.safetensors",
    latentUpscaler: "h3_upscaler_lms_v0.1.safetensors",
    x2VideoVae: "MiniMax-H3-X2-Detail-v1.safetensors",
    ...H3_BASE_MODELS.bf16,
    clip: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    audioVae: "minimax_h3_audio_vae_fp32.safetensors",
};

/** Native H3 API graph; UI-only switches, sample files and custom samplers are intentionally absent. */
export function buildH3Workflow(input: H3WorkflowInput): ComfyWorkflow {
    validateH3Input(input);
    return input.fast ? buildH3FastWorkflow(input) : buildH3NativeWorkflow(input);
}

function validateH3Input(input: H3WorkflowInput) {
    const steps = input.fast ? H3_FAST_DEFAULT_STEPS : input.steps ?? H3_DEFAULT_STEPS;
    const refImageSize = input.refImageSize ?? "match";
    if (!Number.isInteger(steps) || steps < 1 || steps > H3_MAX_STEPS) throw new Error(`采样步数需要是 1–${H3_MAX_STEPS} 的整数。`);
    if (!Number.isSafeInteger(input.seed) || input.seed < 0) throw new Error("随机种子需要是可精确表示的非负整数，请减小数值或留空随机。");
    if (!["match", "max"].includes(refImageSize)) throw new Error("参考图细节设置无效，请选择自动匹配或保留更多。");
    if (!input.prompt.trim()) throw new Error("请填写视频提示词。");
    if (input.mode === "text" && (input.images.length || input.videos.length || input.audios.length)) throw new Error("文生视频不使用参考素材，请切换到图生视频或参考生视频。");
    if (input.mode !== "reference" && (input.images.length > 2 || input.videos.length || input.audios.length)) throw new Error("首尾帧模式支持最多两张图片；更多图片、视频或音频请使用参考生视频。");
    if (input.mode === "reference" && !input.images.length && !input.videos.length && !input.audios.length) throw new Error("参考生视频需要至少一份参考素材。");
    if (input.images.length > 9 || input.videos.length > 3 || input.audios.length > 3) throw new Error("H3 参考输入最多支持 9 张图片、3 个视频和 3 段音频。");
    if (![input.width, input.height, input.seconds].every((value) => Number.isFinite(value) && value > 0)) throw new Error("视频尺寸和时长必须是有效的正数。");
}

function buildH3NativeWorkflow(input: H3WorkflowInput): ComfyWorkflow {
    const reference = input.mode === "reference";
    const steps = input.steps ?? H3_DEFAULT_STEPS;
    const refImageSize = input.refImageSize ?? "match";
    const frames = Math.round(input.seconds * 24);
    const base = input.hd ? H3_BASE_MODELS.bf16 : H3_BASE_MODELS.int8;
    // Above 2K the full-resolution sampler OOMs on 32GB VRAM; the SelfLift chain
    // (low-res prefix → latent lift → spatial tiling) is the only verified way through.
    const highres = Boolean(input.upscale);
    const conditioning: Record<string, unknown> = {
        clip: ["2", 0], vae: ["3", 0], prompt: input.prompt,
        width: Math.max(32, Math.round(input.width / 32) * 32),
        height: Math.max(32, Math.round(input.height / 32) * 32),
        length: frames + (5 - frames % 17 + 17) % 17,
        ...(reference ? { audio_vae: ["4", 0], ref_image_size: refImageSize } : {}),
    };
    const node = (class_type: string, inputs: Record<string, unknown>) => ({ class_type, inputs });
    const graph: ComfyWorkflow = {
        "1": node("UNETLoader", { unet_name: base[reference ? "ref2va" : "fl2va"], weight_dtype: "default" }),
        "2": node("CLIPLoader", { clip_name: H3_MODELS.clip, type: "minimax", device: "default" }),
        "3": node("VAELoader", { vae_name: base.videoVae }),
        "4": node("VAELoader", { vae_name: H3_MODELS.audioVae }),
        "5": node(reference ? "MiniMaxH3ReferenceToVideo" : "MiniMaxH3ImageToVideo", conditioning),
        "16": node("ModelAttentionBackend", { model: ["1", 0], attention: "comfy kitchen attention" }),
        "8": node("KSamplerSelect", { sampler_name: "res_multistep" }),
        "9": node("BasicScheduler", { model: ["16", 0], scheduler: "simple", steps, denoise: 1 }),
        ...(highres
            ? {
                "10": node("ConditioningZeroOut", { conditioning: ["5", 0] }),
                "35": node("SelfLiftAvatarH3Sampler", {
                    low_res_model: ["16", 0],
                    positive: ["5", 0],
                    negative: ["10", 0],
                    vae: ["3", 0],
                    latent_image: ["5", 1],
                    sampler: ["8", 0],
                    sigmas: ["9", 0],
                    seed: input.seed,
                    cfg: 1.0,
                    transition_step: Math.max(1, Math.min(steps - 1, Math.round(steps * 0.75))),
                    lowres_scale: 0.5,
                    rho: 0.0,
                    w_min: 0.5,
                    w_max: 1.0,
                    upscaler_model: H3_FAST_MODELS.latentUpscaler,
                    highres_tiling: true,
                    tiling_mode: "auto",
                    tiling_tiles: 2,
                    tiling_axis: "auto",
                }),
            }
            : {
                "6": node("RandomNoise", { noise_seed: input.seed }),
                "7": node("BasicGuider", { model: ["16", 0], conditioning: ["5", 0] }),
                "10": node("SamplerCustomAdvanced", { noise: ["6", 0], guider: ["7", 0], sampler: ["8", 0], sigmas: ["9", 0], latent_image: ["5", 1] }),
            }),
        "11": node(
            highres ? "H3X2VAEDecodeVideo" : "VAEDecode",
            highres
                ? { samples: ["35", 0], vae_name: H3_FAST_MODELS.x2VideoVae, fps: 24, crf: 19, ...(input.generateAudio ? { audio: ["12", 0] } : {}) }
                : { samples: ["10", 0], vae: ["3", 0] },
        ),
        ...(highres ? {} : { "13": node("CreateVideo", { images: ["11", 0], fps: 24, ...(input.generateAudio ? { audio: ["12", 0] } : {}) }) }),
        "14": node("SaveVideo", { video: [highres ? "11" : "13", 0], filename_prefix: input.outputPrefix, format: "mp4", "format.codec": "h264", "format.codec.encoding": "auto" }),
    };
    if (input.generateAudio) graph["12"] = node("VAEDecodeAudio", { samples: [highres ? "35" : "10", 0], vae: ["4", 0] });
    input.images.forEach((image, index) => {
        const id = String(20 + index);
        graph[id] = node("LoadImage", { image });
        conditioning[reference ? `ref_images.ref_image_${index}` : index === 0 ? "first_frame" : "last_frame"] = [id, 0];
    });
    input.videos.forEach((video, index) => {
        const id = String(40 + index);
        graph[id] = node("VHS_LoadVideo", { video, force_rate: 24, custom_width: 0, custom_height: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1, format: "None" });
        conditioning[`ref_videos.ref_video_${index}`] = [id, 0];
        conditioning[`ref_video_audios.ref_video_audio_${index}`] = [id, 2];
    });
    input.audios.forEach((audio, index) => {
        const id = String(50 + index);
        graph[id] = node("LoadAudio", { audio });
        conditioning[`ref_audios.ref_audio_${index}`] = [id, 0];
    });
    return graph;
}

/**
 * Accelerated H3 graph on the SelfLiftAvatar native chain:
 * Native conditioning → DMAD LoRA → kitchen attention → SelfLiftAvatar sampler
 * (internal low-res→lift→tiled high-res) → X2 VAE decode for 4K.
 */
function buildH3FastWorkflow(input: H3WorkflowInput): ComfyWorkflow {
    const reference = input.mode === "reference";
    const width = Math.max(32, Math.round(input.width / 32) * 32);
    const height = Math.max(32, Math.round(input.height / 32) * 32);
    const frames = Math.round(input.seconds * 24);
    const base = input.hd ? H3_BASE_MODELS.bf16 : H3_BASE_MODELS.int8;
    const conditioning: Record<string, unknown> = {
        clip: ["2", 0], vae: ["3", 0], prompt: input.prompt,
        width, height,
        length: frames + (5 - frames % 17 + 17) % 17,
        ...(reference ? { audio_vae: ["4", 0], ref_image_size: input.refImageSize === "max" ? "max" : "match" } : {}),
    };
    const node = (class_type: string, inputs: Record<string, unknown>) => ({ class_type, inputs });
    const graph: ComfyWorkflow = {
        "1": node("UNETLoader", { unet_name: base[reference ? "ref2va" : "fl2va"], weight_dtype: "default" }),
        "2": node("CLIPLoader", { clip_name: H3_FAST_MODELS.clip, type: "minimax", device: "default" }),
        "3": node("VAELoader", { vae_name: base.videoVae }),
        "4": node("VAELoader", { vae_name: H3_FAST_MODELS.audioVae }),
        "5": node(reference ? "MiniMaxH3ReferenceToVideo" : "MiniMaxH3ImageToVideo", conditioning),
        "15": node("LoraLoaderModelOnly", { model: ["1", 0], lora_name: H3_FAST_MODELS.lora, strength_model: 1.0 }),
        "16": node("ModelAttentionBackend", { model: ["15", 0], attention: "comfy kitchen attention" }),
        "7": node("KSamplerSelect", { sampler_name: "euler" }),
        "9": node("BasicScheduler", { model: ["16", 0], scheduler: "simple", steps: 8, denoise: 1 }),
        "19": node("H3SigmaRefiner", { sigmas: ["9", 0], extra_steps: 1, start_at_sigma: 0.7, end_at_sigma: 0, spacing: "cosine" }),
        "6": node("RandomNoise", { noise_seed: input.seed }),
        "10": node("ConditioningZeroOut", { conditioning: ["5", 0] }),
        "35": node("SelfLiftAvatarH3Sampler", {
            low_res_model: ["16", 0],
            positive: ["5", 0],
            negative: ["10", 0],
            vae: ["3", 0],
            latent_image: ["5", 1],
            sampler: ["7", 0],
            sigmas: ["19", 0],
            seed: input.seed,
            cfg: 1.0,
            transition_step: 6,
            lowres_scale: 0.5,
            rho: 0.0,
            w_min: 0.5,
            w_max: 1.0,
            upscaler_model: H3_FAST_MODELS.latentUpscaler,
            highres_tiling: true,
            tiling_mode: "auto",
            tiling_tiles: 2,
            tiling_axis: "auto",
        }),
        ...(input.upscale
            ? { "11": node("H3X2VAEDecodeVideo", { samples: ["35", 0], vae_name: H3_FAST_MODELS.x2VideoVae, fps: 24, crf: 19, ...(input.generateAudio ? { audio: ["12", 0] } : {}) }) }
            : { "11": node("VAEDecode", { samples: ["35", 0], vae: ["3", 0] }) }),
        ...(input.upscale ? {} : { "13": node("CreateVideo", { images: ["11", 0], fps: 24, ...(input.generateAudio ? { audio: ["12", 0] } : {}) }) }),
        "14": node("SaveVideo", { video: [input.upscale ? "11" : "13", 0], filename_prefix: input.outputPrefix, format: "mp4", "format.codec": "h264", "format.codec.encoding": "auto" }),
    };
    if (input.generateAudio) graph["12"] = node("VAEDecodeAudio", { samples: ["35", 0], vae: ["4", 0] });
    input.images.forEach((image, index) => {
        const id = String(20 + index);
        graph[id] = node("LoadImage", { image });
        conditioning[reference ? `ref_images.ref_image_${index}` : index === 0 ? "first_frame" : "last_frame"] = [id, 0];
    });
    input.videos.forEach((video, index) => {
        const id = String(40 + index);
        graph[id] = node("VHS_LoadVideo", { video, force_rate: 24, custom_width: 0, custom_height: 0, frame_load_cap: 0, skip_first_frames: 0, select_every_nth: 1, format: "None" });
        conditioning[`ref_videos.ref_video_${index}`] = [id, 0];
        conditioning[`ref_video_audios.ref_video_audio_${index}`] = [id, 2];
    });
    input.audios.forEach((audio, index) => {
        const id = String(50 + index);
        graph[id] = node("LoadAudio", { audio });
        conditioning[`ref_audios.ref_audio_${index}`] = [id, 0];
    });
    return graph;
}
