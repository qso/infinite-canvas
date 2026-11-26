export const DREAMMAKER_PROXY_PREFIX = "/dreammaker";
export const DREAMMAKER_API_PATH = "/dreammaker/api";
export const DREAMMAKER_STATIC_PATH = "/dreammaker/static";
export const DREAMMAKER_DOWNLOAD_PATH = "/dreammaker/download";
export const DREAMMAKER_HEALTH_PATH = "/dreammaker/health";
export const DREAMMAKER_STATIC_ORIGIN = "https://dreammaker.netease.com";

export type DreamMakerImageFamily = "gpt" | "mj" | "ark";
export type DreamMakerVideoFamily = "seedance" | "h3";

export type DreamMakerImageSpec = {
    option: string;
    label: string;
    family: DreamMakerImageFamily;
    app: "llm-image" | "mj" | "ark";
    subApp: string;
    apiModel?: string;
    mjVersion?: "8.1" | "8.2";
    niji?: "7";
    arkTiers?: readonly string[];
    supportsTransparent?: boolean;
    supportsLayerDecomp?: boolean;
    supportsWebSearch?: boolean;
    supportsOptimizePrompt?: boolean;
    supportsMaskPaint?: boolean;
};

export type DreamMakerVideoSpec = {
    option: string;
    label: string;
    family: DreamMakerVideoFamily;
    app: "jimeng-video" | "minimax-h3";
    subApp?: string;
    modelName: string;
    displayModel: string;
    resolutions: readonly string[];
    defaultResolution: string;
    maxSeconds: number;
    supportsEditExtend: boolean;
    supportsDraftPromote: boolean;
    supportsAudioToggle: boolean;
};

export const DREAMMAKER_IMAGE_SPECS: readonly DreamMakerImageSpec[] = [
    {
        option: "dreammaker::gpt-image-2.6-sunburst",
        label: "GPT Image 2.6 Sunburst（DreamMaker）",
        family: "gpt",
        app: "llm-image",
        subApp: "gpt-image-2.6-sunburst",
        apiModel: "gpt-image-2.6-sunburst",
        supportsTransparent: true,
        supportsMaskPaint: true,
    },
    {
        option: "dreammaker::gpt-image-2.6-flare",
        label: "GPT Image 2.6 Flare（DreamMaker）",
        family: "gpt",
        app: "llm-image",
        subApp: "gpt-image-2.6-flare",
        apiModel: "gpt-image-2.6-flare",
        supportsTransparent: true,
        supportsMaskPaint: true,
    },
    {
        option: "dreammaker::gpt-image-2.5-sunburst",
        label: "GPT Image 2.5 Sunburst（DreamMaker）",
        family: "gpt",
        app: "llm-image",
        subApp: "gpt-image-2.5-sunburst",
        apiModel: "gpt-image-2.5-sunburst",
        supportsTransparent: true,
        supportsMaskPaint: true,
    },
    {
        option: "dreammaker::gpt-image-2.5-flare",
        label: "GPT Image 2.5 Flare（DreamMaker）",
        family: "gpt",
        app: "llm-image",
        subApp: "gpt-image-2.5-flare",
        apiModel: "gpt-image-2.5-flare",
        supportsTransparent: true,
        supportsMaskPaint: true,
    },
    {
        option: "dreammaker::mj-8.2",
        label: "Midjourney 8.2（DreamMaker）",
        family: "mj",
        app: "mj",
        subApp: "diffusion",
        mjVersion: "8.2",
    },
    {
        option: "dreammaker::mj-8.1",
        label: "Midjourney 8.1（DreamMaker）",
        family: "mj",
        app: "mj",
        subApp: "diffusion",
        mjVersion: "8.1",
        supportsMaskPaint: true,
    },
    {
        option: "dreammaker::niji-7",
        label: "Niji 7（DreamMaker）",
        family: "mj",
        app: "mj",
        subApp: "diffusion",
        niji: "7",
    },
    {
        option: "dreammaker::seedream-5.5",
        label: "Seedream 5.5（DreamMaker）",
        family: "ark",
        app: "ark",
        subApp: "seedream_5.5",
        apiModel: "doubao-seedream-5-5",
        arkTiers: ["1K", "1.5K", "2K"],
        supportsLayerDecomp: true,
    },
    {
        option: "dreammaker::seedream-5.0-pro",
        label: "Seedream 5.0 Pro（DreamMaker）",
        family: "ark",
        app: "ark",
        subApp: "seedream_5.0_pro",
        apiModel: "doubao-seedream-5-0-pro-260628",
        arkTiers: ["1K", "2K"],
        supportsLayerDecomp: true,
        supportsOptimizePrompt: true,
    },
    {
        option: "dreammaker::seedream-5.0-flash",
        label: "Seedream 5.0 Flash（DreamMaker）",
        family: "ark",
        app: "ark",
        subApp: "seedream_5.0_flash",
        apiModel: "doubao-seedream-5-0-flash",
        arkTiers: ["1K", "2K"],
    },
    {
        option: "dreammaker::seedream-5.0",
        label: "Seedream 5.0 Lite（DreamMaker）",
        family: "ark",
        app: "ark",
        subApp: "seedream_5.0",
        apiModel: "doubao-seedream-5.0-lite",
        arkTiers: ["2K", "3K"],
        supportsWebSearch: true,
    },
    {
        option: "dreammaker::seedream-4.5",
        label: "Seedream 4.5（DreamMaker）",
        family: "ark",
        app: "ark",
        subApp: "seedream_4.5",
        apiModel: "doubao-seedream-4-5",
        arkTiers: ["1K", "2K", "4K"],
    },
    {
        option: "dreammaker::seedream-4.0",
        label: "Seedream 4.0（DreamMaker）",
        family: "ark",
        app: "ark",
        subApp: "seedream_4.0",
        apiModel: "doubao-seedream-4-0",
        arkTiers: ["1K", "2K", "4K"],
    },
];

export const DREAMMAKER_VIDEO_SPECS: readonly DreamMakerVideoSpec[] = [
    {
        option: "dreammaker::seedance-2.5",
        label: "Seedance 2.5（DreamMaker）",
        family: "seedance",
        app: "jimeng-video",
        modelName: "doubao-seedance-2-5",
        displayModel: "Seedance 2.5",
        resolutions: ["480", "720", "1080", "2160", "480_draft"],
        defaultResolution: "1080",
        maxSeconds: 20,
        supportsEditExtend: true,
        supportsDraftPromote: true,
        supportsAudioToggle: true,
    },
    {
        option: "dreammaker::seedance-2.5-flash",
        label: "Seedance 2.5 Flash（DreamMaker）",
        family: "seedance",
        app: "jimeng-video",
        modelName: "doubao-seedance-2-5-flash",
        displayModel: "Seedance 2.5 Flash",
        resolutions: ["480", "720"],
        defaultResolution: "720",
        maxSeconds: 20,
        supportsEditExtend: true,
        supportsDraftPromote: false,
        supportsAudioToggle: true,
    },
    {
        option: "dreammaker::seedance-2.0",
        label: "Seedance 2.0（DreamMaker）",
        family: "seedance",
        app: "jimeng-video",
        modelName: "doubao-seedance-2-0",
        displayModel: "Seedance 2.0",
        resolutions: ["480", "720", "1080"],
        defaultResolution: "1080",
        maxSeconds: 15,
        supportsEditExtend: false,
        supportsDraftPromote: false,
        supportsAudioToggle: true,
    },
    {
        option: "dreammaker::seedance-2.0-fast",
        label: "Seedance 2.0 Fast（DreamMaker）",
        family: "seedance",
        app: "jimeng-video",
        modelName: "doubao-seedance-2-0-fast",
        displayModel: "Seedance 2.0 Fast",
        resolutions: ["480", "720"],
        defaultResolution: "720",
        maxSeconds: 15,
        supportsEditExtend: false,
        supportsDraftPromote: false,
        supportsAudioToggle: true,
    },
    {
        option: "dreammaker::seedance-2.0-mini",
        label: "Seedance 2.0 Mini（DreamMaker）",
        family: "seedance",
        app: "jimeng-video",
        modelName: "doubao-seedance-2-0-mini",
        displayModel: "Seedance 2.0 Mini",
        resolutions: ["480", "720"],
        defaultResolution: "720",
        maxSeconds: 15,
        supportsEditExtend: false,
        supportsDraftPromote: false,
        supportsAudioToggle: true,
    },
    {
        option: "dreammaker::minimax-h3",
        label: "MiniMax H3（DreamMaker）",
        family: "h3",
        app: "minimax-h3",
        subApp: "minimax-h3-video",
        modelName: "minimax-h3-video",
        displayModel: "MiniMax H3",
        resolutions: ["768", "1440"],
        defaultResolution: "1440",
        maxSeconds: 15,
        supportsEditExtend: false,
        supportsDraftPromote: false,
        supportsAudioToggle: false,
    },
];

export const DREAMMAKER_IMAGE_OPTIONS = DREAMMAKER_IMAGE_SPECS.map((item) => item.option);
export const DREAMMAKER_VIDEO_OPTIONS = DREAMMAKER_VIDEO_SPECS.map((item) => item.option);

const IMAGE_SPEC_MAP = new Map(DREAMMAKER_IMAGE_SPECS.map((item) => [item.option, item]));
const VIDEO_SPEC_MAP = new Map(DREAMMAKER_VIDEO_SPECS.map((item) => [item.option, item]));

export function getDreamMakerImageSpec(value: string) {
    return IMAGE_SPEC_MAP.get((value || "").trim()) || null;
}

export function getDreamMakerVideoSpec(value: string) {
    return VIDEO_SPEC_MAP.get((value || "").trim()) || null;
}

export function isDreamMakerImage(value: string) {
    return IMAGE_SPEC_MAP.has((value || "").trim());
}

export function isDreamMakerVideo(value: string) {
    return VIDEO_SPEC_MAP.has((value || "").trim());
}

export function isDreamMakerModel(value: string) {
    const key = (value || "").trim();
    return IMAGE_SPEC_MAP.has(key) || VIDEO_SPEC_MAP.has(key);
}

export function isDreamMakerMj(value: string) {
    return getDreamMakerImageSpec(value)?.family === "mj";
}

export function isDreamMakerGpt(value: string) {
    return getDreamMakerImageSpec(value)?.family === "gpt";
}

export function isDreamMakerArk(value: string) {
    return getDreamMakerImageSpec(value)?.family === "ark";
}

export function isDreamMakerSeedance(value: string) {
    return getDreamMakerVideoSpec(value)?.family === "seedance";
}

export function isDreamMakerH3(value: string) {
    return getDreamMakerVideoSpec(value)?.family === "h3";
}

export function dreamMakerModelLabel(value: string) {
    return getDreamMakerImageSpec(value)?.label || getDreamMakerVideoSpec(value)?.label || "";
}

/** Seedance 多模态参考与 ASMR 锁机位快捷提示词模板。 */
export const SEEDANCE_REFERENCE_PROMPT_TEMPLATES = [
    {
        label: "多素材分工",
        prompt: "@图片1用于主体的外貌、服饰与质感，不采用其背景。\n@图片2用于场景的空间布局与光线。\n保持画面稳定连贯，无文字、无水印。",
    },
    {
        label: "参考视频动作",
        prompt: "@图片1用于人物外貌与服装。\n@视频1用于动作节奏与运镜，不采用其人物身份与服装。\n保持画风与光影一致，无文字、无水印。",
    },
];

export const SEEDANCE_FRAMES_PROMPT_TEMPLATES = [
    {
        label: "首帧锁机位微动",
        prompt: "保持原有光影、构图、机位与人物外貌完全不变。\n主体产生缓慢自然细微动作（如呼吸起伏、衣袂与发丝轻摆），镜头完全固定锁死：全程无推拉、无摇移、无环绕、无手持、无切镜。\n无文字、无水印。",
    },
];
