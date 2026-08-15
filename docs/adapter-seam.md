# llm-deepseek 适配器的 OCR 缝（接口契约，兼容保留）

> 自增强版起，本插件不再依赖这个缝：它会在 `llm/adapters-updated` 后包装
> `adapter.stream`，并声明 image 输入能力。本文档保留给旧部署，或已经按
> 上游 README 手动打过 `serializeMessages` 补丁的环境。

## 服务契约

- 服务名：`ocr`（`ctx.provide('ocr', { ocrImage, ocrDeep })`，均可选）
- 回调签名：`(ref, signal?) => Promise<string>`
- 返回该图片的 OCR 文本；空字符串表示识别失败/无文字
- 适配器应每次请求 `ctx.get('ocr')`，不要缓存

## 已打补丁的适配器行为

1. 消息里没有图片 → 原样纯文本序列化。
2. 有图片：
   - `ocrDeep` 可用且消息文本含 `[深度识图]` → 深度 OCR；
   - 否则 `ocrImage` → 快速 OCR；
   - 服务不可用 → 回退 `image_url` 直传（原行为）。
3. 结果包装为 `[图片OCR 附件 <name> <id前16位>]` 或 `[深度OCR 附件 ...]`。

本增强版插件同时提供 `ocrImage` / `ocrDeep`，因此旧补丁仍可工作；新部署无需再打补丁。
