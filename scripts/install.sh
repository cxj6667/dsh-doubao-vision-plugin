#!/usr/bin/env bash
# Install the enhanced dsh-ocr plugin into a DeepSeek Harness profile.
#
# The plugin now handles the image-to-text conversion itself:
#   - it advertises image input for the configured providers
#   - it wraps the provider adapter stream and replaces image blocks with
#     native OCR + optional Doubao vision text before serialization
# Therefore no local patch to dsh-llm-deepseek is required for dsh >= 0.1.0-rc.6.
#
# Usage:
#   ./scripts/install.sh [--profile web] [--app-root /path/to/deepseek-harness]
#   DSH_HOME=/custom/.dsh ./scripts/install.sh
#
# After install: set DSH_OCR_* / DSH_OCR2_* / DOUBAO_* env vars (see README),
# then restart the harness.  Removing the ocr-provider rows from
# cordis.patch.yml disables the plugin.
set -euo pipefail

PROFILE=""
APP_ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="$2"; shift 2 ;;
    --app-root) APP_ROOT="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_DIR="$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-ocr"

echo "==> DSH_HOME=$DSH_HOME"

# 1) copy package into the profile's flat node_modules
mkdir -p "$DSH_HOME/profiles/node_modules/@deepseek-ai"
rm -rf "$PKG_DIR"
mkdir -p "$PKG_DIR"
cp -R "$REPO_DIR/package.json" "$REPO_DIR/lib" "$REPO_DIR/tools" "$REPO_DIR/scripts" "$REPO_DIR/docs" "$PKG_DIR/"
echo "==> package copied to $PKG_DIR"

# 2) locate / append the cordis.patch.yml insert row
if [ -n "$PROFILE" ]; then
  PATCH="$DSH_HOME/profiles/$PROFILE/cordis.patch.yml"
else
  PATCH="$(find "$DSH_HOME/profiles" -name cordis.patch.yml -type f 2>/dev/null | head -1 || true)"
  [ -z "$PATCH" ] && PATCH="$DSH_HOME/profiles/web/cordis.patch.yml"
fi
mkdir -p "$(dirname "$PATCH")"
if [ -f "$PATCH" ] && grep -q 'id: ocr-provider' "$PATCH"; then
  echo "==> already patched: $PATCH"
else
  {
    [ -f "$PATCH" ] && cat "$PATCH"
    printf '\n# dsh-ocr: local OCR (rapidocr fast + DeepSeek-OCR-2 deep) and Doubao vision for life-scene images\n- insert:\n    - id: ocr-provider\n      name: '\''@deepseek-ai/dsh-ocr'\''\n'
  } > "$PATCH.tmp"
  mv "$PATCH.tmp" "$PATCH"
  echo "==> patched: $PATCH"
fi

# 3) optional symlink into the deployment's node_modules
if [ -n "$APP_ROOT" ]; then
  mkdir -p "$APP_ROOT/node_modules/@deepseek-ai"
  ln -sfn "$PKG_DIR" "$APP_ROOT/node_modules/@deepseek-ai/dsh-ocr"
  echo "==> symlinked into $APP_ROOT/node_modules/@deepseek-ai/dsh-ocr"
fi

echo
echo "==> Post-install checklist:"
echo "  - python3 with rapidocr_onnxruntime:  $(command -v python3 >/dev/null && (python3 -c 'import rapidocr_onnxruntime' 2>/dev/null && echo OK || echo 'MISSING (pip install rapidocr_onnxruntime onnxruntime pillow numpy opencv-python)') || echo 'python3 not found')"
echo "  - llama-mtmd-cli on PATH or set DSH_OCR2_BIN (only needed for the [深度识图] channel)"
echo "  - models in \$DSH_HOME/models/ocr2/ (run ./scripts/download-models.sh)"
echo "  - Doubao life-scene vision (optional):"
echo "      export DOUBAO_ARK_API_KEY=...            # recommended, Volcengine Ark"
echo "      python3 tools/doubao_vision.py login     # alternative: login to doubao.com web account"
echo "  - restart the harness, then drag/drop an image into the chat composer."
