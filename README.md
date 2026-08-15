# DSH 豆包视觉插件（dsh-doubao-vision-plugin）

> 基于 GitHub 上的 [dsh-ocr-plugin](https://github.com/CraZY222123/dsh-ocr-plugin) 增强。
> 本项目的核心增强是：**接入豆包视觉模型**，让 DeepSeek Harness 在 OCR 之外真正看懂生活场景图片。

给 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 加“眼睛”的社区插件：**原生 OCR 负责文字，豆包视觉模型负责看懂生活场景**。

DeepSeek API 本身不接收图片。本插件在请求到达 DeepSeek 适配器之前，把聊天中的图片块转换成文本块，让纯文本模型真正看到图片内容：

- **文字/文档/截图/表格/票据**：本地 RapidOCR（秒级）或 DeepSeek-OCR-2（`[深度识图]`，可选）。
- **生活场景图**（OCR 文字很少、DeepSeek-OCR-2 也容易理解不好的照片/表情包/自然场景）：可自动或手动调用**豆包视觉模型**，并把豆包的理解与本地 OCR/颜色/版面信息整合后一起发给 DeepSeek。
- 图片上传入口本身由 DSH Web 拖拽/粘贴提供；本插件负责让模型能真正消费这些图片。

## 与上游原版的区别

本仓库在 [dsh-ocr-plugin](https://github.com/CraZY222123/dsh-ocr-plugin) 基础上增强，重点加入**豆包视觉理解**。

1. **无需再手动改 `dsh-llm-deepseek` 适配器**。本版本会：
   - 把所选 provider 的模型能力声明为支持图片输入（`listModels` / `resolveModelInfo`），让 `session.prompt` 的图片准入检查放行；
   - 在适配器最终边界包装 `adapter.stream`，把图片块替换成 OCR/豆包文本后再调用原 DeepSeek 序列化逻辑。
2. **增加豆包视觉通道**，支持两种豆包后端：
   - 火山方舟 Ark API Key（推荐，稳定、无需浏览器）；
   - 豆包网页账户扫码登录（Playwright 驱动 doubao.com）。
3. 原生 OCR 结果、颜色/尺寸信息、豆包视觉描述会合并为 `[图片理解 附件 ...]` 文本块。

## 工作原理

```
DSH Web 上传图片
  → session.prompt 图片准入（插件已声明 image 能力，放行）
  → 会话中保存真实 ImageBlock
  → agent 构建请求（图片仍在会话日志中）
  → 插件包装 DeepSeek adapter.stream
       ├─ [豆包识图] / 文字太少  → RapidOCR + 豆包视觉（自动合并）
       ├─ [深度识图]             → RapidOCR + DeepSeek-OCR-2（可选 + 豆包）
       └─ 默认                   → RapidOCR
  → DeepSeek API 只收到文本
```

会话日志仍保留原始图片，因此 UI 缩略图、历史记录不受影响；只有模型侧看到的是理解后的文本。

## 安装

```bash
git clone https://github.com/CraZY222123/dsh-ocr-plugin.git
cd dsh-ocr-plugin

# 1) Python 快速通道依赖（系统 pip 受 PEP668 限制时，可 --target 或 venv）
pip install rapidocr_onnxruntime onnxruntime pillow numpy opencv-python
# 或安装到独立目录：
# pip install --target /path/to/ocr-pylibs rapidocr_onnxruntime onnxruntime pillow numpy opencv-python

# 2) 可选：下载 DeepSeek-OCR-2 GGUF 模型（约 2GB）
./scripts/download-models.sh

# 3) 安装插件到 DSH profile（默认 profile: web）
./scripts/install.sh --profile web
```

装完**重启 DSH**，把图片拖进输入框或 Ctrl+V 粘贴即可。

### 手动安装

1. 把 `package.json`、`lib/`、`tools/`、`scripts/`、`docs/` 复制到
   `$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-ocr/`。
2. 在 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: ocr-provider
      name: '@deepseek-ai/dsh-ocr'
```

> 注意：必须使用 `- insert:` 包裹。直接写 `- id: ocr-provider` 会被当作“修改已有插件”而跳过。

3. 重启 DSH。

## 豆包视觉配置

### 方式 A：火山方舟 Ark API Key（推荐）

在[火山方舟](https://console.volcengine.com/ark)开通豆包视觉模型并创建 API Key，然后设置环境变量：

```bash
export DOUBAO_MODE=ark
export DOUBAO_ARK_API_KEY='你的 API Key'
export DOUBAO_ARK_BASE_URL='https://ark.cn-beijing.volces.com/api/v3'
export DOUBAO_ARK_MODEL='doubao-seed-1.6-vision-250815'   # 也可用 doubao-1.5-vision-pro-32k-250115
```

### 方式 B：登录豆包网页账户（扫码）

需要 Python 环境里有 `playwright`，且已安装 Chromium：

```bash
pip install playwright
python3 -m playwright install chromium

# 登录（会把二维码保存到 $DOUBAO_PROFILE 旁边；有图形界面时会直接打开浏览器窗口）
python3 tools/doubao_vision.py login
```

扫码成功后，插件会自动复用持久化登录态，通过 doubao.com 网页上传图片并读取豆包的回答。

### 触发方式

| 消息写法 | 行为 |
| --- | --- |
| `这张图是什么？` | 本地 OCR；若 OCR 文字数 < `DSH_OCR_SCENE_MIN_TEXT`（默认 12），自动追加豆包视觉理解 |
| `[豆包识图] 这张图是什么？` | 强制本地 OCR + 豆包视觉理解 |
| `[视觉识图] 这张图是什么？` | 同上 |
| `[深度识图] 这张票据提取字段` | RapidOCR + DeepSeek-OCR-2；若结果文字很少，也会自动追加豆包理解 |
| `[深度识图] [豆包识图] ...` | 三种结果全部合并 |

## 配置（环境变量）

### 基础 / OCR

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_HOME` | `~/.dsh` | harness 数据目录 |
| `DSH_OCR_PYTHON` | `python3` | Python 解释器 |
| `DSH_OCR_PYTHONPATH` | 未设置 | 附加 Python 库路径（如 `pip --target` 目录） |
| `DSH_OCR_LD_LIBRARY_PATH` | 未设置 | 附加动态库路径 |
| `DSH_OCR_PROVIDERS` | `deepseek-official` | 需要图片转文本的 provider，逗号分隔；`*` 为全部 |
| `DSH_OCR_STREAM_HOOK` | `1` | 兼容保留项；当前版本通过 adapter.stream 包装工作 |
| `DSH_OCR_PATCH_MODEL_CAPABILITY` | `1` | 是否声明图片输入能力（关掉则 DSH 会在上传时拒绝图片） |

### 深度通道 DeepSeek-OCR-2

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_OCR2_BIN` | `llama-mtmd-cli` | llama.cpp 多模态二进制 |
| `DSH_OCR2_MODEL` | `$DSH_HOME/models/ocr2/DeepSeek-OCR-2-IQ4_NL.gguf` | 深度模型 |
| `DSH_OCR2_MMPROJ` | `$DSH_HOME/models/ocr2/mmproj-deepseek-ocr-2-q8_0.gguf` | 视觉投影 |
| `DSH_OCR2_MAX_TOKENS` | `1200` | 最大生成 token |
| `DSH_OCR2_THREADS` | `6` | CPU 推理线程数 |
| `DSH_OCR_RUN_FAST_WITH_DEEP` | `1` | `[深度识图]` 时是否同时保留 RapidOCR |

### 豆包视觉

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DOUBAO_MODE` | `auto` | `auto` / `ark` / `browser` / `off` |
| `DOUBAO_ARK_API_KEY` | 未设置 | Ark API Key |
| `DOUBAO_ARK_BASE_URL` | `https://ark.cn-beijing.volces.com/api/v3` | Ark 接口地址 |
| `DOUBAO_ARK_MODEL` | `doubao-seed-1.6-vision-250815` | 视觉模型 ID |
| `DOUBAO_ARK_MAX_TOKENS` | `1200` | 豆包输出上限 |
| `DOUBAO_PROFILE` | `$DSH_HOME/doubao/profile` | 网页登录态持久化目录 |
| `DOUBAO_PLAYWRIGHT_BROWSERS_PATH` | 未设置 | Playwright 浏览器目录 |
| `DOUBAO_PYTHON` | `$DSH_OCR_PYTHON` | 跑 `doubao_vision.py` 的 Python |
| `DOUBAO_PROMPT` | 内置中文提示词 | 自定义豆包理解提示词 |
| `DOUBAO_AUTO` | `auto` | 生活场景图是否自动追加豆包理解；`0` 关闭 |
| `DSH_OCR_SCENE_MIN_TEXT` | `12` | OCR 有效字符数低于该值时判定为生活场景图 |

## 验证

- 重启后打开 `$DSH_HOME/profiles/web/cordis.patch.yml`，确认有 `ocr-provider` 的 `insert` 行。
- 把任意图片拖入 DSH 输入框并发送；模型应能复述图片内容。
- 抓包/日志中 DeepSeek 请求体应包含 `[图片OCR 附件 ...]` / `[图片理解 附件 ...]` / `[豆包识图 附件 ...]` 文本块，而不是 `image_url`。
- 发送 `[豆包识图] 这张图里有什么？`，回答中应包含 `【豆包视觉理解】` 带来的信息。
- 若没有豆包配置，生活场景图会继续只发送本地 OCR，并在 DSH 日志提示如何配置豆包。

## 故障排查

- **发图仍提示 “Model does not support image input”**：确认 `ocr-provider` 是 `- insert:` 写法；重启后插件日志应有 `image input capability advertised`。
- **快速 OCR 质量一般**：这是 RapidOCR 预期水平；文字密集文档请用 `[深度识图]`（需先下载模型）。
- **豆包网页登录超时**：重新运行 `python3 tools/doubao_vision.py login`，用豆包/抖音/飞书 App 扫保存的二维码；有桌面环境时去掉 `DOUBAO_HEADLESS=1` 会直接弹出浏览器窗口。
- **豆包 ask 提取不到回答**：doubao.com 前端可能改版。可改用 Ark API 模式，或设 `DOUBAO_DEBUG_SCREENSHOTS=1` 后查看 profile 目录旁的截图并反馈。
- **隐私**：本地 OCR 只在本机；图片字节只在 Ark / doubao.com 后端需要时发送。

## 第三方致谢

本仓库基于 [dsh-ocr-plugin](https://github.com/CraZY222123/dsh-ocr-plugin)（MIT）增强，并使用了 DeepSeek-OCR-2、RapidOCR、llama.cpp、Playwright 等开源项目。

完整清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 许可

插件本体与脚本：MIT。DeepSeek-OCR-2、RapidOCR、llama.cpp 等第三方项目的许可见其上游仓库。
