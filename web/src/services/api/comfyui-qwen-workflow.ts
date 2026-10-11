import { QWEN_IMAGE_21_MAX_STEPS } from "@/constant/comfyui";

export type ComfyWorkflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
export type QwenImageWorkflowInput = {
    prompt: string;
    negativePrompt: string;
    /** 文生图输出宽高（32 对齐）；图像编辑时不使用。 */
    width: number;
    height: number;
    /** 图像编辑的像素预算：参考图按比例缩放到约 resolution²（32 对齐）；0 表示保持参考图原始尺寸。 */
    resolution: number;
    steps: number;
    cfg: number;
    seed: number;
    /** 文生图一次采样出多张；图像编辑由服务端按张数提交多个任务。 */
    count: number;
    images: string[];
    outputPrefix: string;
};

/** bf16 精度全套（ModelScope: Comfy-Org/Qwen-Image-2.1）。 */
export const QWEN_IMAGE_21_MODELS = {
    unet: "qwen_image_2.1_bf16.safetensors",
    clip: "qwen3vl_8b_bf16.safetensors",
    vae: "qwen_image_2.1_vae_bf16.safetensors",
};

/** 官方图像编辑链路支持的最大参考图数量（image_1 是编辑目标，其余是参考）。 */
export const QWEN_IMAGE_MAX_REFERENCES = 10;

export function buildQwenImageWorkflow(input: QwenImageWorkflowInput): ComfyWorkflow {
    validateQwenInput(input);
    const editing = input.images.length > 0;
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
            latent_image: editing ? ["5", 2] : ["6", 0],
            seed: input.seed,
            steps: input.steps,
            cfg: input.cfg,
            sampler_name: "euler",
            scheduler: "simple",
            denoise: 1,
        }),
        "8": node("VAEDecode", { samples: ["7", 0], vae: ["3", 0] }),
        "9": node("SaveImage", { images: ["8", 0], filename_prefix: input.outputPrefix }),
    };
    if (!editing) graph["6"] = node("EmptyLatentImage", { width: input.width, height: input.height, batch_size: input.count });
    input.images.forEach((image, index) => {
        const id = String(10 + index);
        graph[id] = node("LoadImage", { image });
        conditioning[`images.image_${index + 1}`] = [id, 0];
    });
    return graph;
}

function validateQwenInput(input: QwenImageWorkflowInput) {
    if (!input.prompt.trim()) throw new Error("请填写图像提示词。");
    if (input.images.length > QWEN_IMAGE_MAX_REFERENCES) throw new Error(`图像编辑最多支持 ${QWEN_IMAGE_MAX_REFERENCES} 张参考图。`);
    if (!Number.isInteger(input.steps) || input.steps < 1 || input.steps > QWEN_IMAGE_21_MAX_STEPS) throw new Error(`采样步数需要是 1–${QWEN_IMAGE_21_MAX_STEPS} 的整数。`);
    if (!Number.isFinite(input.cfg) || input.cfg < 1 || input.cfg > 10) throw new Error("CFG 需要在 1–10 之间，官方链路保持 1 即可。");
    if (!Number.isSafeInteger(input.seed) || input.seed < 0) throw new Error("随机种子需要是可精确表示的非负整数，请减小数值或留空随机。");
    if (input.resolution !== 0 && (!Number.isInteger(input.resolution) || input.resolution < 256 || input.resolution > 4096)) throw new Error("图像编辑分辨率预算需要在 256–4096 之间（32 的倍数），或选择保持原图。");
    if (!input.images.length) {
        for (const [key, value] of [["宽", input.width], ["高", input.height]] as const) {
            if (!Number.isInteger(value) || value < 256 || value > 4096) throw new Error(`输出尺寸的${key}需要在 256–4096 之间（32 的倍数）。`);
            if (value % 32 !== 0) throw new Error(`输出尺寸的${key}需要是 32 的倍数。`);
        }
    }
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > 15) throw new Error("生成张数需要是 1–15 的整数。");
}
