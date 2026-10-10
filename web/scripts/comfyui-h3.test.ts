import { describe, expect, test } from "bun:test";
import { isMiniMaxH3 } from "../src/constant/comfyui";
import { buildH3Workflow, H3_MODELS, type H3WorkflowInput } from "../src/services/api/comfyui-h3-workflow";

const input: H3WorkflowInput = { prompt: "Test scene", mode: "text", width: 854, height: 480, seconds: 5, seed: 457, images: [], videos: [], audios: [], generateAudio: true, outputPrefix: "test" };

describe("H3 GPU submission contract", () => {
    test("provider-qualified H3 names route locally without matching other models", () => {
        for (const model of ["MiniMax-H3", "comfyui::MiniMax-H3", "custom::MiniMax-H3-2K"]) expect(isMiniMaxH3(model)).toBe(true);
        for (const model of ["MiniMax-Hailuo-02", "grok-video", "MiniMax-H30"]) expect(isMiniMaxH3(model)).toBe(false);
    });
    test("text uses the FL2VA checkpoint and the native frame grid", () => {
        const graph = buildH3Workflow(input);
        expect(graph["1"].inputs.unet_name).toBe(H3_MODELS.frames);
        expect(graph["5"].inputs).toMatchObject({ width: 864, height: 480, length: 124 });
        expect(graph["5"].inputs.first_frame).toBeUndefined();
        expect(graph["9"].inputs.steps).toBe(20);
    });
    test("first and last frames stay ordered; reference mode uses its own checkpoint", () => {
        const frames = buildH3Workflow({ ...input, mode: "frames", images: ["first.png", "last.png"] });
        expect(frames["5"].inputs.first_frame).toEqual(["20", 0]);
        expect(frames["5"].inputs.last_frame).toEqual(["21", 0]);
        const reference = buildH3Workflow({ ...input, mode: "reference", images: ["subject.png"] });
        expect(reference["1"].inputs.unet_name).toBe(H3_MODELS.reference);
        expect(reference["5"].inputs["ref_images.ref_image_0"]).toEqual(["20", 0]);
        expect(reference["5"].inputs.first_frame).toBeUndefined();
        expect(reference["5"].inputs.ref_image_size).toBe("match");
    });
    test("reference video retains its paired audio; separate audio has a separate input", () => {
        const graph = buildH3Workflow({ ...input, mode: "reference", videos: ["scene.mp4"], audios: ["voice.wav"] });
        expect(graph["5"].inputs["ref_videos.ref_video_0"]).toEqual(["40", 0]);
        expect(graph["5"].inputs["ref_video_audios.ref_video_audio_0"]).toEqual(["40", 2]);
        expect(graph["5"].inputs["ref_audios.ref_audio_0"]).toEqual(["50", 0]);
    });
    test("invalid reference combinations are rejected before GPU submission", () => {
        expect(() => buildH3Workflow({ ...input, images: ["image.png"] })).toThrow("文生视频");
        expect(() => buildH3Workflow({ ...input, mode: "reference" })).toThrow("至少");
        expect(() => buildH3Workflow({ ...input, mode: "frames", images: ["a.png", "b.png", "c.png"] })).toThrow("两张");
    });
    test("sound can be toggled in all modes without removing reference conditioning", () => {
        for (const mode of ["text", "frames", "reference"] as const) {
            const source = { ...input, mode, images: mode === "text" ? [] : ["subject.png"], audios: mode === "reference" ? ["voice.wav"] : [] };
            const audible = buildH3Workflow(source);
            expect(audible["12"].class_type).toBe("VAEDecodeAudio");
            expect(audible["13"].inputs.audio).toEqual(["12", 0]);
            const silent = buildH3Workflow({ ...source, generateAudio: false });
            expect(silent["12"]).toBeUndefined();
            expect(silent["13"].inputs.audio).toBeUndefined();
            if (mode === "reference") {
                expect(silent["5"].inputs.audio_vae).toEqual(["4", 0]);
                expect(silent["5"].inputs["ref_audios.ref_audio_0"]).toEqual(["50", 0]);
            }
        }
    });
    test("custom steps, seed zero and reference sizing reach the native nodes", () => {
        const graph = buildH3Workflow({ ...input, mode: "reference", images: ["subject.png"], steps: 12, seed: 0, refImageSize: "max" });
        expect(graph["9"].inputs.steps).toBe(12);
        expect(graph["6"].inputs.noise_seed).toBe(0);
        expect(graph["5"].inputs.ref_image_size).toBe("max");
    });
    test("invalid advanced settings are rejected before GPU submission", () => {
        for (const steps of [0, -1, 1.5, 10001, NaN]) expect(() => buildH3Workflow({ ...input, steps })).toThrow("采样步数");
        for (const seed of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN]) expect(() => buildH3Workflow({ ...input, seed })).toThrow("随机种子");
        expect(() => buildH3Workflow({ ...input, refImageSize: "invalid" as H3WorkflowInput["refImageSize"] })).toThrow("参考图细节");
    });
});
