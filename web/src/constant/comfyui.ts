export const MINIMAX_H3_OPTION = "comfyui::MiniMax-H3";
export const MINIMAX_H3_FAST_OPTION = "comfyui::MiniMax-H3-Fast";
export const QWEN_IMAGE_21_OPTION = "comfyui::Qwen-Image-2.1";
export const COMFYUI_PROXY_PATH = "/comfyui";
export const H3_DEFAULT_STEPS = 20;
export const H3_FAST_DEFAULT_STEPS = 4;
export const H3_MAX_STEPS = 10000; // BasicScheduler's native upper bound.
export const QWEN_IMAGE_21_DEFAULT_STEPS = 25; // 官方模板起步值；官方管线推荐 40-50。
export const QWEN_IMAGE_21_MAX_STEPS = 60;
// 转发目标地址放在 web/.env.local 的 COMFYUI_REMOTE_URL（vite.config / 测试脚本读取）。

export function isMiniMaxH3(value: string) {
    return /^minimax[-_ ]?h3(?:$|[-_ ])/i.test(value.split("::").at(-1)?.trim() || "");
}

export function isMiniMaxH3Fast(value: string) {
    return /^minimax[-_ ]?h3[-_ ]?fast/i.test(value.split("::").at(-1)?.trim() || "");
}

/** 精确匹配内置选项，避免误接管渠道里同名的 Qwen 模型。 */
export function isQwenImage21(value: string) {
    return value === QWEN_IMAGE_21_OPTION;
}

/** Quick prompt templates for H3 reference-to-video; tags must match the connection order (images → Picture, videos → Video). */
export const H3_REFERENCE_PROMPT_TEMPLATES = [
    { label: "人物替换", prompt: "将 <Video 1> 中出现的人物替换为 <Picture 1> 的形象，保持人物的动作、表情、镜头运动和道具不变，光影与画面风格保持一致。" },
    { label: "风格替换", prompt: "将 <Video 1> 的画面转换为 <Picture 1> 的风格，人物、动作、表情和镜头运动保持不变。" },
    { label: "动作迁移", prompt: "让 <Picture 1> 的人物做出与 <Video 1> 中人物一致的动作和表情，镜头运动与画面节奏保持一致。" },
];

