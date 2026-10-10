import gc
import math
import os
import sys
import traceback
import uuid

sys.path.insert(0, "/var/tmp")

import torch
import torch.nn.functional as F

import comfy.model_management
import folder_paths


class H3X2VAEDecode:
    """Decode the H3 joint AV latent's video stream at 2x spatial size with the
    MiniMax-H3-X2-Detail VAE (packed-12ch decoder + PixelShuffle 2).
    Memory-lean variant: pixel-shuffles frame by frame into one preallocated
    output tensor instead of materializing full-size intermediates."""

    _runtime_cache = {}

    @classmethod
    def INPUT_TYPES(cls):
        names = [name for name in folder_paths.get_filename_list("vae") if "X2" in name]
        return {"required": {"samples": ("LATENT",), "vae_name": (names or ["MiniMax-H3-X2-Detail-v1.safetensors"],)}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "decode"
    CATEGORY = "latent/minimax"

    def decode(self, samples, vae_name):
        from x2node.nodes import _load_runtime, _expand_rgb_stat
        vae = H3X2VAEDecode._runtime_cache.get(vae_name)
        if vae is None:
            path = folder_paths.get_full_path_or_raise("vae", vae_name)
            vae, _detail = _load_runtime(path)
            H3X2VAEDecode._runtime_cache[vae_name] = vae

        z = samples["samples"]
        if hasattr(z, "tensors"):
            z = z.tensors[0]

        try:
            inner = vae.first_stage_model
            d = inner.decoder
            packed_channels = int(d.proj_out.weight.shape[0]) // (int(d.patch_size_t) * int(d.patch_size) * int(d.patch_size))
            upscale = int(round(math.sqrt(packed_channels // 3)))

            saved = (inner.decoder.out_channels, inner.pixel_mean, inner.pixel_std, inner.tiling, inner.tile_size, inner.tile_overlap_min)
            try:
                inner.decoder.out_channels = packed_channels
                inner.tiling = True
                inner.tile_size = 256
                inner.tile_overlap_min = 64
                with comfy.model_management.cuda_device_context(vae.device):
                    memory_used = vae.memory_used_decode(z.shape, vae.vae_dtype)
                    comfy.model_management.load_models_gpu([vae.patcher], memory_required=memory_used, force_full_load=vae.disable_offload)
                    inner.pixel_mean = _expand_rgb_stat(inner.pixel_mean, packed_channels)
                    inner.pixel_std = _expand_rgb_stat(inner.pixel_std, packed_channels)
                    outdev = comfy.model_management.intermediate_device()
                    packed = torch.empty(inner.decode_output_shape(z.shape), device=outdev, dtype=vae.vae_output_dtype())
                    latent = z.to(device=vae.device, dtype=vae.vae_dtype)
                    with torch.inference_mode():
                        inner.decode(latent, output_buffer=packed)
                    vae.process_output(packed)

                    B, C, T, H, W = packed.shape
                    out = torch.empty(B * T, H * upscale, W * upscale, 3, dtype=torch.float32)
                    for b in range(B):
                        for t in range(T):
                            q = packed[b, :, t]
                            img = F.pixel_shuffle(q, upscale)
                            out[b * T + t] = img.permute(1, 2, 0)
            finally:
                (inner.decoder.out_channels, inner.pixel_mean, inner.pixel_std, inner.tiling, inner.tile_size, inner.tile_overlap_min) = saved
            return (out,)
        except Exception:
            traceback.print_exc()
            raise


class H3X2VAEDecodeVideo:
    """Streaming variant of H3X2VAEDecode: decodes the packed latent frame by frame
    and encodes straight into an H.264 MP4 via PyAV, so the full-size IMAGE tensor
    (27GB+ for 4K x 15s) is never materialized. Returns a ComfyUI VIDEO backed by
    the encoded temp file; a downstream SaveVideo with matching mp4/h264 settings
    stream-copies it instead of re-encoding. Diffusion/text models are unloaded
    before decoding to keep the RAM peak low enough for smart-memory servers."""

    _runtime_cache = {}

    @classmethod
    def INPUT_TYPES(cls):
        names = [name for name in folder_paths.get_filename_list("vae") if "X2" in name]
        return {
            "required": {
                "samples": ("LATENT",),
                "vae_name": (names or ["MiniMax-H3-X2-Detail-v1.safetensors"],),
                "fps": ("FLOAT", {"default": 24.0, "min": 1.0, "max": 120.0, "step": 1.0}),
                "crf": ("INT", {"default": 19, "min": 0, "max": 51}),
            },
            "optional": {"audio": ("AUDIO",)},
        }

    RETURN_TYPES = ("VIDEO",)
    FUNCTION = "decode"
    CATEGORY = "latent/minimax"

    def decode(self, samples, vae_name, fps, crf, audio=None):
        import av
        import numpy as np
        from comfy_api.latest import InputImpl
        from x2node.nodes import _load_runtime, _expand_rgb_stat

        # The UNet / text encoder are dead weight from here on. Drop whatever the
        # runtime lets go before the big decode so the RAM peak stays bounded.
        try:
            comfy.model_management.unload_all_models()
        except Exception:
            pass
        gc.collect()
        try:
            comfy.model_management.soft_empty_cache()
        except Exception:
            pass

        vae = H3X2VAEDecodeVideo._runtime_cache.get(vae_name)
        if vae is None:
            path = folder_paths.get_full_path_or_raise("vae", vae_name)
            vae, _detail = _load_runtime(path)
            H3X2VAEDecodeVideo._runtime_cache[vae_name] = vae

        z = samples["samples"]
        if hasattr(z, "tensors"):
            z = z.tensors[0]

        try:
            inner = vae.first_stage_model
            d = inner.decoder
            packed_channels = int(d.proj_out.weight.shape[0]) // (int(d.patch_size_t) * int(d.patch_size) * int(d.patch_size))
            upscale = int(round(math.sqrt(packed_channels // 3)))

            saved = (inner.decoder.out_channels, inner.pixel_mean, inner.pixel_std, inner.tiling, inner.tile_size, inner.tile_overlap_min)
            try:
                inner.decoder.out_channels = packed_channels
                inner.tiling = True
                inner.tile_size = 256
                inner.tile_overlap_min = 64
                with comfy.model_management.cuda_device_context(vae.device):
                    memory_used = vae.memory_used_decode(z.shape, vae.vae_dtype)
                    comfy.model_management.load_models_gpu([vae.patcher], memory_required=memory_used, force_full_load=vae.disable_offload)
                    inner.pixel_mean = _expand_rgb_stat(inner.pixel_mean, packed_channels)
                    inner.pixel_std = _expand_rgb_stat(inner.pixel_std, packed_channels)
                    outdev = comfy.model_management.intermediate_device()
                    packed = torch.empty(inner.decode_output_shape(z.shape), device=outdev, dtype=vae.vae_output_dtype())
                    latent = z.to(device=vae.device, dtype=vae.vae_dtype)
                    with torch.inference_mode():
                        inner.decode(latent, output_buffer=packed)
                    vae.process_output(packed)

                    B, C, T, H, W = packed.shape
                    width, height = W * upscale, H * upscale
                    out_path = os.path.join(folder_paths.get_temp_directory(), f"h3_x2_stream_{uuid.uuid4().hex}.mp4")
                    with av.open(out_path, mode="w", format="mp4") as container:
                        vstream = container.add_stream("libx264", rate=int(round(fps)))
                        vstream.width = width
                        vstream.height = height
                        vstream.pix_fmt = "yuv420p"
                        vstream.options = {"crf": str(int(crf)), "preset": "medium"}

                        astream = None
                        waveform = None
                        source_rate = 0
                        if isinstance(audio, dict) and audio.get("waveform") is not None and audio["waveform"].numel():
                            source_rate = int(audio.get("sample_rate", 44100))
                            wave = audio["waveform"].detach().float().cpu()
                            if wave.dim() == 3:
                                wave = wave[0]
                            layout = {1: "mono", 2: "stereo", 6: "5.1"}.get(wave.shape[0], "stereo")
                            astream = container.add_stream("aac", rate=source_rate, layout=layout)
                            waveform = wave.contiguous()

                        for b in range(B):
                            for t in range(T):
                                img = F.pixel_shuffle(packed[b, :, t], upscale)
                                arr = (img.permute(1, 2, 0).float().clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)
                                frame = av.VideoFrame.from_ndarray(arr, format="rgb24")
                                frame = frame.reformat(format="yuv420p")
                                for packet in vstream.encode(frame):
                                    container.mux(packet)
                        for packet in vstream.encode(None):
                            container.mux(packet)

                        if astream is not None and waveform is not None:
                            aframe = av.AudioFrame.from_ndarray(waveform.numpy(), format="fltp", layout=astream.layout.name)
                            aframe.sample_rate = source_rate
                            aframe.pts = 0
                            for packet in astream.encode(aframe):
                                container.mux(packet)
                            for packet in astream.encode(None):
                                container.mux(packet)
                del packed
                return (InputImpl.VideoFromFile(out_path),)
            finally:
                (inner.decoder.out_channels, inner.pixel_mean, inner.pixel_std, inner.tiling, inner.tile_size, inner.tile_overlap_min) = saved
        except Exception:
            traceback.print_exc()
            raise


NODE_CLASS_MAPPINGS = {
    "H3X2VAEDecode": H3X2VAEDecode,
    "H3X2VAEDecodeVideo": H3X2VAEDecodeVideo,
}
