import { QWEN_IMAGE_21_MAX_STEPS } from "@/constant/comfyui";

export type ComfyWorkflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
export type QwenImageWorkflowInput = {
    prompt: string;
    negativePrompt: string;
    /** 采样画布宽高（32 对齐，4K 档为折半后的原生尺寸）；仅在 customLatent 时使用。 */
    width: number;
    height: number;
    /** true：按 width/height 的空画布采样（文生图，或编辑时用户指定了比例/宽高）；false：编辑跟随第 1 张参考图的 latent。 */
    customLatent: boolean;
    /** 图像编辑的像素预算：参考图按比例缩放到约 resolution²（32 对齐）；0 表示保持参考图原始尺寸。 */
    resolution: number;
    steps: number;
    cfg: number;
    seed: number;
    /** 文生图一次采样出多张；图像编辑由服务端按张数提交多个任务。 */
    count: number;
    images: string[];
    /** 4K 档：原生出图后经 SeedVR2 超分到该长边；0 表示关闭。 */
    upscaleLongEdge: number;
    outputPrefix: string;
};

/** bf16 精度全套（ModelScope: Comfy-Org/Qwen-Image-2.1）。 */
export const QWEN_IMAGE_21_MODELS = {
    unet: "qwen_image_2.1_bf16.safetensors",
    clip: "qwen3vl_8b_bf16.safetensors",
    vae: "qwen_image_2.1_vae_bf16.safetensors",
};

/** 4K 超分（ModelScope: Comfy-Org/SeedVR2，comfy-core 内置节点链）。 */
export const QWEN_SEEDVR2_MODELS = {
    unet: "seedvr2_7b_fp16.safetensors",
    vae: "seedvr2_ema_vae_fp16.safetensors",
};

/** 官方图像编辑链路支持的最大参考图数量（image_1 是编辑目标，其余是参考）。 */
export const QWEN_IMAGE_MAX_REFERENCES = 10;

export function buildQwenImageWorkflow(input: QwenImageWorkflowInput): ComfyWorkflow {
    validateQwenInput(input);
    const editing = input.images.length > 0;
    // 文生图始终在自定义画布上采样；编辑时「跟随原图/自动比例」沿用首图 latent，选定比例或宽高后用空画布重新构图。
    const customLatent = !editing || input.customLatent;
    const node = (class_type: string, inputs: Record<string, unknown>) => ({ class_type, inputs });
    const conditioning: Record<string, unknown> = {
        clip: ["2", 0],
        vae: ["3", 0],
        prompt: input.prompt,
        negative_prompt: input.negativePrompt,
        resolution: editing ? input.resolution : Math.max(0, Math.round(Math.sqrt(input.width * input.height) / 32) * 32),
    };
    const graph: ComfyWorkflow = {
        "1": node("UNETLoader", { unet_name: QWEN_IMAGE_21_MODELS.unet, weight_dtype: "default" }),
        "2": node("CLIPLoader", { clip_name: QWEN_IMAGE_21_MODELS.clip, type: "qwen_image", device: "default" }),
        "3": node("VAELoader", { vae_name: QWEN_IMAGE_21_MODELS.vae }),
        "4": node("QwenImage21Cache", { model: ["1", 0], device: "auto", dtype: "default" }),
        "5": node("TextEncodeQwenImage21", conditioning),
        "7": node("KSampler", {
            model: ["4", 0],
            positive: ["5", 0],
            negative: ["5", 1],
            latent_image: customLatent ? ["6", 0] : ["5", 2],
            seed: input.seed,
            steps: input.steps,
            cfg: input.cfg,
            sampler_name: "euler",
            scheduler: "simple",
            denoise: 1,
        }),
        "8": node("VAEDecode", { samples: ["7", 0], vae: ["3", 0] }),
        ...(input.upscaleLongEdge ? buildSeedVR2Upscale(input) : {}),
        "9": node("SaveImage", { images: [input.upscaleLongEdge ? "28" : "8", 0], filename_prefix: input.outputPrefix }),
    };
    if (customLatent) graph["6"] = node("EmptyLatentImage", { width: input.width, height: input.height, batch_size: editing ? 1 : input.count });
    input.images.forEach((image, index) => {
        const id = String(10 + index);
        graph[id] = node("LoadImage", { image });
        conditioning[`images.image_${index + 1}`] = [id, 0];
    });
    return graph;
}

/**
 * SeedVR2 单步扩散超分（官方内置链）：lanczos 预放大到目标长边 → 分块 VAE 编码 →
 * 1 步采样还原细节 → 分块解码 → 与预放大结果做色彩校正。
 */
function buildSeedVR2Upscale(input: QwenImageWorkflowInput): ComfyWorkflow {
    const node = (class_type: string, inputs: Record<string, unknown>) => ({ class_type, inputs });
    return {
        "20": node("ImageScaleToMaxDimension", { image: ["8", 0], upscale_method: "lanczos", largest_size: input.upscaleLongEdge }),
        "21": node("SeedVR2Preprocess", { resized_images: ["20", 0] }),
        "22": node("VAELoader", { vae_name: QWEN_SEEDVR2_MODELS.vae }),
        "23": node("UNETLoader", { unet_name: QWEN_SEEDVR2_MODELS.unet, weight_dtype: "default" }),
        "24": node("VAEEncodeTiled", { pixels: ["21", 0], vae: ["22", 0], tile_size: 512, overlap: 128, temporal_size: 4096, temporal_overlap: 8 }),
        "25": node("SeedVR2Conditioning", { model: ["23", 0], vae_conditioning: ["24", 0] }),
        "26": node("KSampler", { model: ["23", 0], positive: ["25", 0], negative: ["25", 1], latent_image: ["24", 0], seed: input.seed, steps: 1, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 }),
        "27": node("VAEDecodeTiled", { samples: ["26", 0], vae: ["22", 0], tile_size: 512, overlap: 128, temporal_size: 4096, temporal_overlap: 8 }),
        "28": node("SeedVR2PostProcessing", { images: ["27", 0], original_resized_images: ["20", 0], color_correction_method: "wavelet" }),
    };
}

function validateQwenInput(input: QwenImageWorkflowInput) {
    if (!input.prompt.trim()) throw new Error("请填写图像提示词。");
    if (input.images.length > QWEN_IMAGE_MAX_REFERENCES) throw new Error(`图像编辑最多支持 ${QWEN_IMAGE_MAX_REFERENCES} 张参考图。`);
    if (!Number.isInteger(input.steps) || input.steps < 1 || input.steps > QWEN_IMAGE_21_MAX_STEPS) throw new Error(`采样步数需要是 1–${QWEN_IMAGE_21_MAX_STEPS} 的整数。`);
    if (!Number.isFinite(input.cfg) || input.cfg < 1 || input.cfg > 10) throw new Error("CFG 需要在 1–10 之间，官方链路保持 1 即可。");
    if (!Number.isSafeInteger(input.seed) || input.seed < 0) throw new Error("随机种子需要是可精确表示的非负整数，请减小数值或留空随机。");
    if (input.resolution !== 0 && (!Number.isInteger(input.resolution) || input.resolution < 256 || input.resolution > 4096)) throw new Error("图像编辑分辨率预算需要在 256–4096 之间（32 的倍数），或选择保持原图。");
    if (!input.images.length || input.customLatent) {
        for (const [key, value] of [["宽", input.width], ["高", input.height]] as const) {
            if (!Number.isInteger(value) || value < 256 || value > 4096) throw new Error(`输出尺寸的${key}需要在 256–4096 之间（32 的倍数）。`);
            if (value % 32 !== 0) throw new Error(`输出尺寸的${key}需要是 32 的倍数。`);
        }
    }
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 15) throw new Error("生成张数需要是 1–15 的整数。");
    if (input.upscaleLongEdge !== 0 && (!Number.isInteger(input.upscaleLongEdge) || input.upscaleLongEdge < 2048 || input.upscaleLongEdge > 8192)) throw new Error("4K 超分目标长边需要在 2048–8192 之间。");
}
