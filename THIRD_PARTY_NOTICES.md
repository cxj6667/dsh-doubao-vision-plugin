# Third-Party Notices

This project builds on the following open-source projects and services.

## dsh-ocr-plugin

- Repository: https://github.com/CraZY222123/dsh-ocr-plugin
- Author: CraZY222123
- License: MIT
- Use: Base project. This repository is an enhanced fork that adds Doubao vision understanding and self-contained image admission.

## DeepSeek-OCR-2

- Model: https://huggingface.co/deepseek-ai/DeepSeek-OCR-2
- Developer: DeepSeek AI
- License: MIT
- Use: Optional deep OCR channel. This repository does not redistribute model weights; `scripts/download-models.sh` downloads GGUF files at runtime.

## DeepSeek-OCR-2 GGUF conversions

- https://huggingface.co/SandLogicTechnologies/DeepSeek-OCR-2-GGUF
- https://huggingface.co/sabafallah/DeepSeek-OCR-2-GGUF
- Use: Optional deep OCR channel. Please check each repository for its own license before redistribution.

## RapidOCR

- Repository: https://github.com/RapidAI/RapidOCR
- License: Apache-2.0
- Use: Fast local OCR channel through `rapidocr_onnxruntime`.

## llama.cpp

- Repository: https://github.com/ggml-org/llama.cpp
- License: MIT
- Use: `llama-mtmd-cli` runs the optional DeepSeek-OCR-2 GGUF model.

## Playwright

- Repository: https://github.com/microsoft/playwright
- License: Apache-2.0
- Use: Doubao web-account login and vision Q&A automation.

## Other Python dependencies

- onnxruntime: MIT
- numpy: BSD-3-Clause
- opencv-python / opencv-contrib-python: Apache-2.0
- Pillow: MIT-CMU / PIL Software License

## Doubao / Volcengine Ark

- Service: doubao.com / console.volcengine.com
- Use: Optional cloud vision model called only when you configure or log in.
- This project stores Doubao login state locally only and never publishes account data.
