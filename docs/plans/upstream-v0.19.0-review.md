# 原仓 v0.19.0 同步与审查

## 同步结果

- 原仓：[basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas)，已通过 GitHub 仓库元数据确认它是 `qso/infinite-canvas` 的 parent 和 source，并配置为 `upstream`。
- 基线从 `d213a74`（v0.18.0）更新到 `e856c87`（v0.19.0），原仓新增 13 个提交、涉及 27 个文件。
- 当前工作分支为 `codex/sync-upstream-v0.19.0`，本地服务使用该分支及保留下来的 H3 改动；`main` 仍指向原来的基线。
- 同步前的 21 个未提交文件已有完整备份，并保留在 Git stash `064ead58fd089e1ca2236f34c44e0352a788b047`。与原仓更新不重叠的 15 个文件已逐一核对，内容保持一致。
- 已处理更新日志、待验收清单和视频页面导入语句的三处冲突；视频页面同时保留原仓缩略图能力与本地 H3 查询恢复逻辑。
- 服务地址：[本地网页](http://127.0.0.1:3000)。浏览器页面显示 v0.19.0，云端 ComfyUI 的只读健康接口返回成功。

## 需求价值与实现质量

需求价值：图片密集画布的缩略图、拖拽更新合帧和连线裁剪符合现有使用场景，值得保留。生图请求增加 10 分钟超时，超时后结束等待并提示失败；这是原仓本次已有的行为变更。

实现质量：页面可以启动，现有针对性检查通过，但确认了下面三个 P2 问题。前两项由原仓缩略图更新引入，第三项存在于本地 H3 接入。建议修复后再合入主分支；本轮只完成同步、冲突处理和审查，未修改这些缺陷的实现。

## 1. P2：取消发生在缩略图生成期间，图片仍被保存并返回成功

来源：原仓 v0.19.0。

位置：[image-storage.ts:62](/Users/hzlizhaoming/Project/ai-creative-studio/web/src/services/image-storage.ts:62)。画布调用方在 [project.tsx:2456](/Users/hzlizhaoming/Project/ai-creative-studio/web/src/pages/canvas/project.tsx:2456) 拿到结果后直接写入节点。

`storeImage` 原本在写入原图后检查取消信号，本次在最后一次检查之后新增 `await storeImagePreview(...)`，随后直接返回。用户在这个异步阶段点击停止时，取消不会再被检查，原图和缩略图仍留在本地，调用方也可能把已停止的生成结果写回画布。

复现：在独立浏览器页面调用真实 `uploadImage`，让取消信号在 `createImageBitmap` 开始生成缩略图时触发。结果为 `aborted: true`、`outcome: resolved`、`persisted: true`、`hasPreview: true`。

建议：缩略图处理后再次检查取消信号；取消清理应覆盖原图、缩略图和内存 URL，再向调用方抛出取消错误。

## 2. P2：同一缩略图并发读取会创建多个无法释放的 URL

来源：原仓 v0.19.0。

位置：[image-storage.ts:175](/Users/hzlizhaoming/Project/ai-creative-studio/web/src/services/image-storage.ts:175)、[image-storage.ts:201](/Users/hzlizhaoming/Project/ai-creative-studio/web/src/services/image-storage.ts:201)。

`ensureImagePreview` 只在等待 IndexedDB 之前检查内存缓存，缺少按 storageKey 合并正在进行的读取。多个引用同时恢复同一张图时，每个调用都会创建 Blob URL，后一次直接覆盖 Map 中的前一次；删除图片只释放 Map 中最后一个 URL。缩略图首次生成队列也没有按图片去重。

复现：为同一个已存储的缩略图并发调用四次 `ensureImagePreview`，得到四个不同 URL；调用真实 `deleteStoredImages` 后只释放一个，另外三个仍未释放。测试结束后另行清理了这些测试 URL。

建议：合并同一 storageKey 的读取和生成任务，在等待之后复查缓存，并在替换缓存时释放旧 URL。

## 3. P2：H3 已提交任务，但本地存储失败会丢失返回给页面的任务编号

来源：现有本地 H3 接入，与原仓本次更新无关。

位置：[comfyui-h3.ts:35](/Users/hzlizhaoming/Project/ai-creative-studio/web/src/services/api/comfyui-h3.ts:35)、[video/index.tsx:188](/Users/hzlizhaoming/Project/ai-creative-studio/web/src/pages/video/index.tsx:188)。

ComfyUI 返回 `prompt_id` 后，代码必须等 `tasks.setItem` 成功才把编号返回页面。若浏览器存储空间不足或写入失败，函数抛出普通错误，页面把它当作创建失败，失败记录没有 task；用户点击重试会走新建请求，而原来的云端任务可能仍在执行。

复现：在独立浏览器中拦截 `/comfyui/prompt`，返回一个明确的模拟任务编号，再让 H3 任务仓库写入抛出 `QuotaExceededError`。调用返回失败，错误中不含编号，本地也没有任务记录。提交接口使用模拟响应，未提交真实 GPU 任务。

建议：一旦拿到远端编号，就将任务视为已提交；单独报告持久化失败，并把编号保留在页面状态或可复制的错误信息中，让用户继续查询该编号。

## 验证范围

- 现有缩略图选择检查 3 项、H3 工作流检查 6 项，共 9 项通过、0 项失败。
- 浏览器正常打开视频工作台并显示更新后的版本；上述三个缺陷使用当前实际模块完成针对性复现。
- 本地网页及 `/comfyui/system_stats` 返回 HTTP 200；后者只证明云端接口可访问，不证明所有生成模式已重新验收。
- 复现结果保存在本地忽略目录 [browser-probes.json](/Users/hzlizhaoming/Project/ai-creative-studio/data/upstream-review/browser-probes.json)。
- 按项目约定未执行类型检查或构建。未重跑真实 GPU 生成、ZCode 连接或完整 WebDAV 同步。
- 多节点拖拽、组投放、视口边缘连线、原图下载与导出，以及更新后 H3 各模式的完整生成，仍需按待验收清单确认。
