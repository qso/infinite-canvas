import { isMiniMaxH3, isQwenImage21 } from "@/constant/comfyui";
import { getDreamMakerImageSpec, getDreamMakerVideoSpec } from "@/constant/dreammaker";
import { requestImageQuestion, type AiTextMessage } from "@/services/api/image";
import { boolConfig, type AiConfig } from "@/stores/use-config-store";
import type { CanvasGenerationMode } from "@/types/canvas";

export type PromptOptimizeContext = {
    mode: CanvasGenerationMode;
    model: string;
    config: AiConfig;
    imageCount: number;
    videoCount: number;
    audioCount: number;
};

export type PromptOptimizeSpec = {
    specLabel: string;
    systemPrompt: string;
};

export function getPromptOptimizeSpec(context: PromptOptimizeContext): PromptOptimizeSpec {
    const { mode, model, config, imageCount, videoCount, audioCount } = context;

    if (mode === "image") {
        const dmImg = getDreamMakerImageSpec(model);
        if (dmImg?.family === "mj") {
            const isNiji = Boolean(dmImg.niji);
            const editHint = imageCount > 0 ? `\n- 当前已连接 ${imageCount} 张参考图（垫图参考）：请完整描述目标画面内容、构图与光影变化，不要只写“模仿参考图”。` : "";
            return {
                specLabel: isNiji ? "Niji 7 规范" : `Midjourney ${dmImg.mjVersion || "8.2"} 规范`,
                systemPrompt: [
                    `你是专业 AI 视觉提示词工程师。请把用户输入的生图草稿改写为严格符合 ${isNiji ? "Midjourney Niji 7" : `Midjourney V${dmImg.mjVersion || "8.2"}`} 官方规范的英文提示词。`,
                    "核心规则：",
                    "1. 必须输出简短、具象、画面感强的英文视觉短语组合，遵循公式：[主体与姿态/动作] + [艺术媒介/摄影或插画风格] + [环境与背景] + [构图/景别/机位] + [光影/材质/色彩]。",
                    isNiji ? "2. 专精日系动漫/二次元插画表达（cel shading, anime illustration, clean linework, expressive lighting 等）。" : "2. 避免空洞废话和长篇散文，名词与光学/材质描述精准具体。",
                    "3. 主描述控制简洁（≤ 1024 字符）。若画面中需要呈现文字，用英文双引号 \"...\" 包裹。",
                    "4. 禁止在正文里写否定词（如 no people、without text），如果用户要求排除元素，统一放到末尾用 `--no 元素1, 元素2` 表示。",
                    "5. 不要自动添加 `--ar`、`--v`、`--stylize`、`--chaos`、`--weird`、`--q` 等参数（这些由节点参数面板控制）；严禁输出 V8.2 不支持的 `--oref`、`--cref`、`--turbo`、`::`、`--preview`。" + editHint,
                    "6. 只输出优化后的最终提示词正文，不要任何解释、标题或 Markdown 代码块。",
                ].join("\n"),
            };
        }

        if (dmImg?.family === "gpt") {
            const transparent = config.background === "transparent";
            const isEdit = imageCount > 0;
            const rules = [
                `你是专业视觉导演与提示词架构师。请把用户的生图草稿改写为严格符合 ${dmImg.label}（OpenAI GPT Image 2.6/2.5）规范的提示词。`,
                "核心规则：",
                "1. 使用清晰、精确的自然语言（默认英文，若画面需渲染中文文字则保留中文引号内容并说明字体/排版位置）。",
                "2. 严禁堆砌 SD/MJ 废词（绝对不要写 8k, masterpiece, ultra detailed, trending on artstation, hyperrealistic 或孤立的 photorealistic）。",
            ];
            if (isEdit) {
                rules.push(
                    `3. 当前为图生图/编辑模式（共 ${imageCount} 张参考图）：必须先明确指定变化动作与每张参考图的分工（如 image 1、image 2），再显式锁定保持不变的部分（例如 Keep the person's facial features, hairstyle, pose, proportions, and original lighting completely unchanged），并说明光影、材质与阴影自然融合。`,
                );
            } else {
                rules.push(
                    "3. 文生图采用模块化清晰结构：依次覆盖 Subject & Pose、Composition & Proportions（写明人物/主体位置与画面占比）、Costume & Props、Environment、Lighting & Color Palette（明确主光源方向与色彩）、Optical Aesthetic & Camera（若是写实/影视大片，加入 Cooke lens rendering, subtle Black Pro-Mist 1/8 diffusion, soft subsurface scattering, low micro-contrast 与主次锐度分离，避免数字锐化塑料感）、Constraints（末尾排雷如 no distorted anatomy, no extra fingers, no watermark）。",
                );
            }
            if (transparent) {
                rules.push("4. 当前已开启「透明背景」：务必明确写出 isolated on a transparent background, floating slightly with no ground plane, no contact shadow, no drop shadow, crisp clean silhouette edges。");
            }
            rules.push("5. 不要把尺寸参数写死成冲突像素；只输出优化后的最终提示词正文，不要解释或加多余前缀。");
            return {
                specLabel: "GPT Image 2.6/2.5 规范",
                systemPrompt: rules.join("\n"),
            };
        }

        if (dmImg?.family === "ark") {
            const isEdit = imageCount > 0;
            return {
                specLabel: "Seedream 规范",
                systemPrompt: [
                    `你是专业中文视觉提示词工程师。请把用户草稿改写为严格符合豆包方舟 ${dmImg.label} 规范的提示词。`,
                    "核心规则：",
                    "1. 必须使用连贯、自然的中文完整句子（不要用逗号堆砌碎片标签词！）。",
                    isEdit
                        ? `2. 当前为图生图/多图参考模式（共 ${imageCount} 张参考图）：严格使用“变化动作（移除/添加/替换/保持） + 变化对象 + 变化特征 + 不变声明”结构；${imageCount > 1 ? "明确用“图1”“图2”区分每张参考图分工，" : ""}避免使用“它/这个”等模糊代词，并显式声明其余人物特征、光影与背景保持不变。`
                        : "2. 文生图公式：应用场景或风格定位 + 主体与动作 + 环境背景 + 简洁美学短语（色彩、光影、构图）。",
                    "3. 若画面需要出现文字，将文字放入双引号 \"\" 中并描述位置与风格。",
                    "4. 篇幅凝练（建议 ≤ 300 汉字），不要把分辨率/比例参数（如 2K、9:16）写进正文。",
                    "5. 只输出优化后的最终提示词正文，不要任何解释、标题或 Markdown 代码块。",
                ].join("\n"),
            };
        }

        if (isQwenImage21(model)) {
            return {
                specLabel: "Qwen Image 2.1 规范",
                systemPrompt: [
                    "你是专业 AI 生图提示词工程师。请把用户草稿优化为适合 Qwen Image 2.1（中英文双语自然语言理解强）的清晰提示词。",
                    imageCount > 0 ? `当前已连接 ${imageCount} 张参考图：保留或规范使用 <image1>、<image2> 引用，明确编辑指令和需要保持不变的要素。` : "依次明确主体、姿态/动作、服饰道具、环境背景、构图景别、光影色彩与画面质感。",
                    "不要输出分辨率/比例数值，不要输出解释，只输出最终提示词正文。",
                ].join("\n"),
            };
        }
    }

    if (mode === "video") {
        const dmVid = getDreamMakerVideoSpec(model);
        if (dmVid?.family === "seedance") {
            const videoMode = config.videoMode || (imageCount > 2 || videoCount || audioCount ? "reference" : imageCount ? "frames" : "text");
            const audioEnabled = boolConfig(config.videoGenerateAudio, true);
            const modeRules =
                videoMode === "frames"
                    ? `当前为【图生视频（首尾帧）】模式（已连接 ${imageCount} 张图片）：\n- 铁律：只描述“动态变化与运镜”，绝不重复复述首帧里已经存在的静态外貌/服装/陈设，否则会导致画面漂移。\n- 必须显式加一句：“保持原有光影、构图、机位与人物外貌完全不变”。\n- 物理幅度必须与静态首帧匹配，一次给 1 个清晰连贯动作；若描述微动/呼吸，写清物理方向（如“胸口与衣襟随呼吸缓慢起伏”），不要写“保持静止”。\n- 不需要写 @图片1 分工。`
                    : videoMode === "reference"
                      ? `当前为【多模态参考】模式（图片 ${imageCount} 张、视频 ${videoCount} 段、音频 ${audioCount} 段）：\n- 必须先用一行逐个写明每份素材负责什么、不采用什么，例如：\n  @图片1用于主体的外貌、服装与材质，不采用其背景。\n  @视频1用于动作与运镜节奏，不采用其人物身份与服装。\n- 再写出清晰的动态事件、画面风格、镜头与声音。`
                      : videoMode === "edit"
                        ? "当前为【视频编辑】模式：用清晰中文写出要对原视频进行的画面或音频修改指令，并显式说明人物动作、镜头与其余未修改元素保持不变。"
                        : videoMode === "extend"
                          ? "当前为【视频延长】模式：承接原视频末尾画面与动作势能，自然描写后续延长部分的情节发展、镜头运动与声画延续。"
                          : "当前为【文生视频】模式：用四行模板完整写清主体动作、场景环境、视觉风格、运镜与声音。";

            return {
                specLabel: `${dmVid.displayModel} 规范`,
                systemPrompt: [
                    `你是专业视频导演。请把用户的视频提示词草稿改写为严格符合字节跳动 ${dmVid.displayModel} 官方提示词规范的中文提示词。`,
                    "官方四行模板（不需要的段落可省略）：",
                    "<主体>在<场景与环境>中<主要动作或事件>。",
                    "画面呈现<视觉风格>。",
                    "镜头采用<景别、机位、运镜或切镜>。",
                    "声音包括<环境声、音效或无声说明>。",
                    "",
                    modeRules,
                    "",
                    "五大禁忌（严格遵守）：",
                    "1. 绝对不要把分辨率、帧率、宽高比、时长（如 4K、1080p、9:16、8 秒、24fps）写进提示词。",
                    "2. 同一个动作不要重复描述（避免“走着、继续走、一直走”）。",
                    "3. 不要堆砌空洞形容词（如“唯美、高级、震撼大片感”），改用可执行光学/质感描述（如“库克镜头、1/8 黑柔、低微反差、柔和逆光”）。",
                    "4. 不要写互相矛盾的指令；Seedance 天然倾向动镜头，如果用户希望固定机位/不切镜，必须写死“镜头完全固定锁死：全程无推拉、无摇移、无环绕、无手持、无切镜”。",
                    `5. 声音策略：当前面板「生成声音」为【${audioEnabled ? "开启" : "关闭（静音）"}】，${audioEnabled ? "请写明所需的纯环境音效/人声或音频风格（若不想要背景音乐请写“仅纯环境音效，无背景音乐”）" : "请在末尾明确写“无声”"}。`,
                    "6. 没有独立 negative_prompt 字段，排除项统一以“无文字、无水印、无额外人物”短句写在最末尾。",
                    "7. 只输出优化后的最终提示词正文，不要解释或加多余标题。",
                ].join("\n"),
            };
        }

        if (dmVid?.family === "h3" || isMiniMaxH3(model)) {
            const audioEnabled = boolConfig(config.videoGenerateAudio, true);
            const videoMode = config.videoMode || (imageCount > 2 || videoCount || audioCount ? "reference" : imageCount ? "frames" : "text");
            const refTagHint = dmVid?.family === "h3" ? "<Picture 1:reference_image> / <Video 1:reference_video>" : "<Picture 1> / <Video 1>";
            return {
                specLabel: "MiniMax H3 规范",
                systemPrompt: [
                    "你是专业 AI 视频提示词工程师。请把用户的视频草稿优化为严格符合 MiniMax H3 规范的英文一段式提示词。",
                    "核心规则：",
                    "1. 使用简洁精准的英文短句组合（一段式：镜头控制 + 主体动作物理过程 + 环境动态 + 光学质感 + 声音约束）。",
                    "2. 镜头运动必须明确唯一：若是固定机位，首句写 `Single continuous locked-off fixed tripod shot — strictly no zoom, no push-in, no pan, no tilt, no cut or cross-dissolve.`；若需运镜，只给单一清晰运镜。",
                    "3. 物理动作具体可感（例如呼吸起伏写明吸气抬起与呼气回落，刚性物体注明 rigid straight 不弯曲）；不要只写静止不动。",
                    videoMode === "reference" ? `4. 当前为参考生视频模式：保留或规范使用 ${refTagHint} 引用标签，写清替换或迁移关系。` : videoMode === "frames" ? "4. 当前为首尾帧/图生视频模式：聚焦从首帧出发的自然动态演变，不破坏原画面风格与主体结构。" : "4. 当前为文生视频模式：完整交代主体、环境层次与动态光影。",
                    `5. 声音约束：${audioEnabled ? "在末尾补充清晰音效要求（如不需要杂乱配乐则写 `Audio: pure diegetic sound effects only, strictly no background music, no melody.`）" : "当前已关闭生成声音，不要加入音频/对白描写"}。`,
                    "6. 不要输出分辨率、帧率或时长数字；只输出优化后的最终英文提示词正文，不要解释。",
                ].join("\n"),
            };
        }
    }

    return {
        specLabel: "通用提示词规范",
        systemPrompt: [
            `你是专业 AI ${mode === "video" ? "视频" : mode === "audio" ? "音频" : "视觉"}提示词优化助手。`,
            "请在不改变用户核心意图的前提下，把草稿优化为表达更清晰、画面感与可执行细节更强的完整提示词。",
            "保留用户原有引用标签（如 图片1、视频1、<image1>、@图片1 等），不要输出分辨率/时长等界面参数，只输出优化后的最终提示词正文，不要解释。",
        ].join("\n"),
    };
}

export async function optimizeModelPrompt(
    config: AiConfig,
    draftPrompt: string,
    context: PromptOptimizeContext,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
): Promise<string> {
    const spec = getPromptOptimizeSpec(context);
    const trimmed = draftPrompt.trim();
    if (!trimmed) throw new Error("请先输入简短的提示词或想法，再进行优化。");

    const refSummaryParts: string[] = [];
    if (context.imageCount > 0) refSummaryParts.push(`参考图片 ${context.imageCount} 张`);
    if (context.videoCount > 0) refSummaryParts.push(`参考视频 ${context.videoCount} 段`);
    if (context.audioCount > 0) refSummaryParts.push(`参考音频 ${context.audioCount} 段`);
    const refLine = refSummaryParts.length ? `已连接素材：${refSummaryParts.join("，")}` : "已连接素材：无（纯文本生成）";

    const messages: AiTextMessage[] = [
        { role: "system", content: spec.systemPrompt },
        {
            role: "user",
            content: `${refLine}\n请按规范优化以下草稿，直接输出最终提示词正文：\n\n${trimmed}`,
        },
    ];

    const textConfig: AiConfig = {
        ...config,
        model: config.textModel || config.model,
        systemPrompt: "",
    };

    const result = await requestImageQuestion(textConfig, messages, onDelta, { signal });
    return result.trim();
}
