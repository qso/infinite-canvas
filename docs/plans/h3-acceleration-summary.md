# MiniMax H3 加速版与 4K 支持：阶段总结

本阶段围绕一条目标展开：把云端 ComfyUI 上的 MiniMax H3 推理做到「分钟级出片 + 支持 4K」，并以前端独立模型选项的形式接入产品。

## 一、产品侧交付

### 模型选项
- `comfyui::MiniMax-H3`：标准版，原生链路，默认 20 步（用户可调）。
- `comfyui::MiniMax-H3-Fast`：加速版，固定配方不暴露开关。文生 / 首尾帧 / 参考生视频三模式与声音开关均支持，随机种子与参考图细节可用。

### 加速版架构（buildH3FastWorkflow，2026-10-09 终版）
复刻 UP 主（AIwood 爱屋研究所）的工作流架构，关键改动是**从 Easy 链切回原生链 + SelfLiftAvatar**：

```
原生条件链（MiniMaxH3ImageToVideo / ReferenceToVideo）
  → UNETLoader（int8 pruned 21GB）
  → LoraLoaderModelOnly（DMAD 4 步蒸馏 LoRA, strength 1.0）
  → ModelAttentionBackend（comfy kitchen INT8 注意力, ~20x 加速）
  → Euler + BasicScheduler(simple, 8 步)
  → H3SigmaRefiner（extra_steps=1, start_at_sigma=0.7, cosine, 尾段精修）
  → SelfLiftAvatarH3Sampler（核心：内部管理分辨率）
       transition_step=6（前 6 步 0.5x 低清采样）
       lowres_scale=0.5（低清阶段为目标的 50%）
       upscaler_model=h3_upscaler_lms_v0.1（LMS 锐化放大器）
       highres_tiling=true, tiling_mode=auto（后 2 步升维到全分辨率 + 空间分块）
  → ≤2K：VAEDecode（int8 VAE）
  → >2K：H3X2VAEDecode（X2 Detail VAE 一次放大）
```

### 分辨率体系
- 标准版和加速版均支持 480p ~ 1080p + 自定义 + 2K + 4K。
- **加速版不再外部降分辨率**——SelfLiftAvatar 在采样器内部管理（低清→升维→分块），始终以目标分辨率原生采样。
- 2K 以内直接输出；>2K 时 H3X2VAEDecode 放大 2 倍。

### 其他
- 默认渠道更名「官方」（i18n `defaultName`；旧浏览器存储需手动改名）。
- 模型下拉标签只对两个内置选项打「云端 ComfyUI」，渠道内同名模型回落渠道名。

## 二、云端环境架构（v3 终版）

| 层 | 位置 | 说明 |
|---|---|---|
| 代码 | `/var/tmp/ComfyUI`（v0.39.1） | 含修改版 model.py（UP 主提供的爆显存优化版） |
| 运行时 | `/var/tmp/cenv` | `--system-site-packages` venv（继承 conda torch 2.9.0+cu128） |
| 模型 | `/project/.../comfyui-models`（持久卷实体） | `models` 目录为符号链接 |
| 启动 | `TORCH_DEVICE_BACKEND_AUTOLOAD=0` 必带 | 否则 torch_npu 残留崩启动；启动 8-15 分钟 |

### 自定义节点清单
| 节点包 | 来源 | 作用 |
|---|---|---|
| Veda-on-ComfyUI | veda-sparse | VEDA 稀疏注意力（当前加速版未使用） |
| ComfyUI-MiniMaxH3-Easy | nkxx188 | Easy 链（当前加速版未使用，保留备用） |
| ComfyUI-MiniMaxH3_LatentUpscaler | Tr1dae | MiniMaxH3VAEDecodeFast（分块解码） |
| ComfyUI-H3-Latent-Upscaler-Mamad8 | mamad8c | Mamad8 清洁 latent 放大器 |
| selflift-Avatar | slmonker | **核心采样器**（空间分块 + 内部分辨率管理） |
| ComfyUI-YCNodes-MiniMax-H3 | yichengup | H3SigmaRefiner（尾段精修） |
| h3_x2_decode（自研） | 本项目 | X2 VAE 胶水解码节点 |
| zz_kitchen_cuda（自研） | 本项目 | 启用 kitchen CUDA 后端 |

## 三、实测数据（RTX 5090 32G, 90GB RAM）

| 场景 | 分辨率 | 时长 | 采样 | 耗时 | 成品 |
|---|---|---|---|---|---|
| 加速版（SelfLiftAvatar） | **2048×1152 原生** | **15s** | 原生 2K | **651s** | **2048×1152 · 362帧 · 19.9MB** |
| 加速版（旧 Easy 链） | 768×448 原生 | 5s | 原生 | 68-72s | ✅ |
| 加速版（旧 Easy 链） | 1088×1920 原生 | 6s | 原生 | 239s | ✅ |
| 标准版（无加速） | 768×448 | 5s | 原生 | ~460s | ✅ |
| 旧加速版（外部降半+Mamad8+X2） | 720×544→2944×2176 | 15s | 720×544 | 390s | ⚠️ 模糊（已弃用） |

## 四、关键教训（按重要性排序）

### 1. 不要在外部降采样——SelfLiftAvatar 自己管分辨率
这是导致画质模糊的根本原因。旧方案在 `video.ts` 用 token 预算把分辨率砍半（如 2K 砍到 1024×576），SelfLiftAvatar 根本没机会在全分辨率上工作。SelfLiftAvatar 的设计是：**前 transition_step 步在 lowres_scale 倍分辨率上采样（快），然后升维到全分辨率 + 空间分块处理剩余步（好）**。采样器的 width/height 就是目标的 width/height，不需要也不应该外部降。

### 2. 验证必须同尺寸+同时长+同架构
- 6s 验证过 ≠ 15s 能过（token 数差 2.5 倍）
- Easy 链验证过 ≠ SelfLiftAvatar 链能过（架构不同）
- int8 验证过 ≠ BF16 能过（内存特征不同）

### 3. int8 底模必须配 kitchen attention
不配则走 eager 慢速路径（实测 459s vs 21s，差 20 倍），且 eager 路径的 `torch.cat(scaled_parts)` 在大分辨率时直接 OOM。kitchen CUDA 扩展（cp310 manylinux 平台 wheel）必须装入 cenv site-packages（pip 顽固走 user-site 时用 unzip 直装）。

### 4. 90GB RAM 容器限制
- int8 (21GB) ✅ 可用
- pruned BF16 (40GB) ❌ 之前杀容器（但当时无 SelfLiftAvatar 分块和 model.py，值得重试）
- full BF16 (66GB) ❌ 装不下
- BF16 文件已下载到持久卷，切换只需改文件名

### 5. cubefs 大文件写入
多连接并行写入持久卷会丢尾巴且多副本读不一致。**必须**：分段拼装在本地盘 → 单流写入 → 延迟 30s 二次校验尺寸 → 张量级校验。

### 6. 容器会被 OOM 杀死并清空 /var/tmp
多次发生。快照恢复是唯一保命手段（5 分钟 vs 3 小时重建）。每次环境变更后必须重打快照。

## 五、当前可用能力

| 时长 | 分辨率 | 可用 | 耗时 | 画质 |
|---|---|---|---|---|
| 任意 | 480p-2K | ✅ | ~11 分钟(15s 2K) | ✅ 清晰（原生采样） |
| 任意 | 4K | ✅ | ~15 分钟(15s 4K, X2 放大) | ⚠️ 预期尚可（单次放大） |
| 6s | 4K | ✅ | ~4 分钟 | ✅ 预期好（原生 1440×1088 + X2） |

## 六、遗留事项

1. **pruned BF16 实验**——用 SelfLiftAvatar 分块 + model.py 重试，可能画质更好
2. **4K 实际画质验收**——SelfLiftAvatar 原生 2K 已确认清晰，4K 路径需用户确认
3. **标准版是否加 kitchen attention**——当前标准版跑慢速路径（~20x 慢），用户尚未拍板
4. **VEDA 是否重新引入**——当前未用（UP 主也 bypass），如需可加回

## 七、一键恢复手册

持久卷 `/project/daixinliang/recover/` 存有环境快照（含全部节点包 + venv + model.py）。

```bash
# 5 分钟恢复
cd /var/tmp && tar xzf /project/daixinliang/recover/var_tmp_snapshot.tar.gz
cd /var/tmp/ComfyUI && TORCH_DEVICE_BACKEND_AUTOLOAD=0 nohup /var/tmp/cenv/bin/python \
  main.py --listen 0.0.0.0 --port 8188 >> /var/tmp/comfyui_agent.log 2>&1 &
```
