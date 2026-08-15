#!/usr/bin/env bash
# Download the GGUF model files needed by dsh-ocr's deep OCR channel.
#
#   DeepSeek-OCR-2-IQ4_NL.gguf  (model,   ~1.6 GB)  SandLogicTechnologies/DeepSeek-OCR-2-GGUF
#   mmproj-deepseek-ocr-2-q8_0.gguf (mmproj, ~0.5 GB) sabafallah/DeepSeek-OCR-2-GGUF
#
# Files land in $DSH_HOME/models/ocr2/ (override with DSH_OCR2_MODEL_DIR).
# The download base is hf-mirror.com by default (fast in CN networks);
# override with HF_BASE=https://huggingface.co if needed.
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
MODEL_DIR="${DSH_OCR2_MODEL_DIR:-$DSH_HOME/models/ocr2}"
BASE="${HF_BASE:-https://hf-mirror.com}"
MODEL_REPO="${MODEL_REPO:-SandLogicTechnologies/DeepSeek-OCR-2-GGUF}"
MMPROJ_REPO="${MMPROJ_REPO:-sabafallah/DeepSeek-OCR-2-GGUF}"
MODEL_FILE="${DSH_OCR2_MODEL_FILE:-DeepSeek-OCR-2-IQ4_NL.gguf}"
MMPROJ_FILE="${DSH_OCR2_MMPROJ_FILE:-mmproj-deepseek-ocr-2-q8_0.gguf}"

mkdir -p "$MODEL_DIR"

fetch() { # fetch <repo> <file>
  local url="$BASE/$1/resolve/main/$2"
  local out="$MODEL_DIR/$2"
  echo "==> $2"
  echo "    $url"
  if [ -s "$out" ]; then
    echo "    already present, skipping (remove to re-download): $out"
    return 0
  fi
  curl -fL --retry 3 -C - -o "$out" "$url"
  echo "    saved to $out"
}

fetch "$MODEL_REPO" "$MODEL_FILE"
fetch "$MMPROJ_REPO" "$MMPROJ_FILE"

echo
echo "Done. Point the plugin at these files with:"
echo "  DSH_OCR2_MODEL=$MODEL_DIR/$MODEL_FILE"
echo "  DSH_OCR2_MMPROJ=$MODEL_DIR/$MMPROJ_FILE"
echo "(these are already the defaults when DSH_HOME=$DSH_HOME)"
