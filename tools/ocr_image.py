#!/usr/bin/env python3
"""OCR + 程序化图像分析：输入图片路径（PNG/JPEG/WebP/GIF，或插件保存的 .b64 文件），
输出可读文字（带置信度）、尺寸、主色调等信息，供文本模型"识图"。

v3（2026-08-14）：移植 DeepSeek-OCR-2 的版面原理 ——
  * 每行输出附带左上角坐标（格式: 文本@x,y），让文本模型能按语义重组；
  * 多栏文档按"列检测 + 栏内自上而下"重建阅读顺序（OCR-2 类人阅读顺序的几何近似）；
  * 检测到网格对齐的表格时，还原为 | 分隔 的 Markdown 行；
  * 首行输出版面说明（[score] 行格式，可被上游插件透传给模型）。

用法:
    python3.12 tools/ocr_image.py <path> [--top-colors N]
依赖: rapidocr_onnxruntime, onnxruntime, PIL, numpy, cv2 (pip install 安装)
"""
import argparse
import base64
import io
import os
import sys
import tempfile

import numpy as np
from PIL import Image


def load_image_bytes(path):
    """返回 (PIL.Image, 说明文本)。.b64 后缀的文件先 base64 解码为真实图片字节。"""
    if path.endswith(".b64"):
        with open(path, "r", encoding="ascii", errors="ignore") as fh:
            data = fh.read().strip()
        try:
            raw = base64.b64decode(data)
        except Exception as exc:
            raise ValueError(f"base64 解码失败: {exc}") from exc
        img = Image.open(io.BytesIO(raw))
        img.load()
        return img, "base64 解码"
    with Image.open(path) as img:
        img.load()
        return img, "直接读取"


def dominant_colors(img, top_n=5):
    """用 cv2 量化主色调，返回 [(rgb, 占比%), ...]。"""
    try:
        import cv2
    except Exception:
        return []
    arr = np.asarray(img.convert("RGB"))
    small = cv2.resize(arr, (64, 64), interpolation=cv2.INTER_AREA)
    pixels = small.reshape(-1, 3).astype(np.float32)
    k = min(top_n, len(pixels))
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 10, 1.0)
    _, labels, centers = cv2.kmeans(pixels, k, None, criteria, 3, cv2.KMEANS_PP_CENTERS)
    counts = np.bincount(labels.flatten(), minlength=k)
    total = counts.sum()
    order = np.argsort(-counts)
    out = []
    for idx in order:
        r, g, b = (int(round(v)) for v in centers[idx])
        out.append(((r, g, b), round(100.0 * counts[idx] / total, 1)))
    return out


def run_ocr(path):
    """检测 + 自适应识别：分离 det/rec，对小高度文本行放大后再识别。
    对应 DeepEncoder V2 的"全局视图 + 局部裁剪"原则：全局检测找位置，
    局部细节（矮文本）放大补全，显著降低漏字/错字。"""
    import numpy as np
    from rapidocr_onnxruntime import RapidOCR

    engine = RapidOCR()
    img = np.asarray(engine.load_img(path))
    if img.ndim == 2:
        img = np.stack([img] * 3, axis=-1)
    boxes, _ = engine.text_det(img)
    if boxes is None or len(boxes) == 0:
        return []

    def crop_rect(arr, box, pad=2):
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        x1 = max(0, int(min(xs)) - pad)
        y1 = max(0, int(min(ys)) - pad)
        x2 = min(arr.shape[1], int(max(xs)) + pad)
        y2 = min(arr.shape[0], int(max(ys)) + pad)
        return arr[y1:y2, x1:x2]

    crops = []
    for b in boxes:
        c = crop_rect(img, b)
        h = c.shape[0]
        if h < 30:
            # 矮文本放大到 ~48px（rec 训练高度），最高 4x
            factor = max(2, min(4, -(-48 // max(1, h))))
            c = np.asarray(Image.fromarray(c).resize(
                (c.shape[1] * factor, c.shape[0] * factor), Image.LANCZOS))
        crops.append(c)
    results, _ = engine.text_rec(crops)
    out = []
    for box, res in zip(boxes, results):
        text = res[0]
        score = float(res[1])
        out.append((box, text, score))
    return out


def box_metrics(box):
    """文本框 4 角点 -> (x1, y1, x2, y2)。"""
    xs = [p[0] for p in box]
    ys = [p[1] for p in box]
    return min(xs), min(ys), max(xs), max(ys)


def reading_order(lines):
    """把 (box, text, score) 列表按阅读顺序重排：行主序 ——
    先按 y 区间聚类成"行"（row_groups），行按 y 排序、行内按 x 排序。
    这近似 OCR-2 的跨栏逐行阅读：同一高度先读左栏再读右栏。"""
    items = []
    for box, text, score in lines:
        x1, y1, x2, y2 = box_metrics(box)
        items.append({"x1": x1, "y1": y1, "x2": x2, "y2": y2, "text": text, "score": score})
    if not items:
        return []
    ordered = []
    for row in row_groups(items):
        ordered.extend(sorted(row, key=lambda i: (i["x1"], i["y1"])))
    return ordered


def row_groups(items, tol_ratio=0.6):
    """把 y 区间重叠的行聚成组；返回 [ [items], ... ] 按 y 排序。"""
    groups = []
    for it in sorted(items, key=lambda i: i["y1"]):
        placed = False
        for g in groups:
            g_items = g
            g_y1 = min(i["y1"] for i in g_items)
            g_y2 = max(i["y2"] for i in g_items)
            height = max(i["y2"] - i["y1"] for i in g_items) or 1
            ov = min(it["y2"], g_y2) - max(it["y1"], g_y1)
            if ov >= tol_ratio * (it["y2"] - it["y1"]) or ov >= tol_ratio * height:
                g_items.append(it)
                placed = True
                break
        if not placed:
            groups.append([it])
    groups.sort(key=lambda g: min(i["y1"] for i in g))
    return groups


def detect_tables(ordered):
    """网格对齐检测：连续 >=2 行、每行 >=2 个并排框、左缘跨行对齐 -> 表格。
    首行（表头）允许格数不同（作废后回到普通行）；返回 (tables, rest_items)。"""
    if len(ordered) < 4:
        return [], ordered
    rows = row_groups(ordered)
    tables = []
    rest = []
    cur = []
    prev_lefts = None
    for row in rows:
        row_sorted = sorted(row, key=lambda i: i["x1"])
        if len(row_sorted) >= 2:
            lefts = [i["x1"] for i in row_sorted]
            if prev_lefts is not None:
                aligned = (
                    len(prev_lefts) == len(lefts)
                    and all(
                        abs(a - b) <= max(6.0, 0.04 * (i["x2"] - i["x1"]))
                        for a, b, i in zip(prev_lefts, lefts, row_sorted)
                    )
                )
            else:
                aligned = True  # 首行暂定对齐（可能是表头）
            if aligned:
                cur.append(row_sorted)
                prev_lefts = lefts
            else:
                if len(cur) >= 2:
                    tables.append(cur)
                    cur = [row_sorted]
                    prev_lefts = lefts
                else:
                    # 单独首行与后续行格数不同：把首行作废为普通行，从当前行重新起表
                    if cur:
                        rest.append(cur[0])
                    cur = [row_sorted]
                    prev_lefts = lefts
        else:
            if len(cur) >= 2:
                tables.append(cur)
            elif cur:
                rest.append(cur[0])
            cur = []
            prev_lefts = None
            rest.append(row_sorted)
    if len(cur) >= 2:
        tables.append(cur)
    elif cur:
        rest.append(cur[0])
    table_ids = set()
    for t in tables:
        for r in t:
            for i in r:
                table_ids.add(id(i))
    rest_items = [i for i in ordered if id(i) not in table_ids]
    return tables, rest_items


def fmt_line(it):
    return f"[{it['score']:.2f}] {it['text']} @{int(it['x1'])},{int(it['y1'])}"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", help="图片路径或 .b64 文件")
    parser.add_argument("--top-colors", type=int, default=5)
    args = parser.parse_args()

    source = args.path
    tmp = None
    # 支持直接传附件 ID（sha256:<hex>）：解析 dsh 附件库内容寻址路径
    if source.startswith('sha256:'):
        hexid = source[len('sha256:'):]
        store = os.path.join(os.environ.get('DSH_HOME') or os.path.expanduser('~/.dsh'),
                             'attachments', 'v1', 'objects', hexid[:2], hexid)
        print(f'# 附件 ID 解析: {store}')
        source = store

    if not os.path.isfile(source):
        print(f"文件不存在: {source}")
        return 2

    try:
        img, how = load_image_bytes(source)
        print(f"# 文件: {args.path} ({how})")
        print(f"# 尺寸: {img.width} x {img.height}, 模式: {img.mode}, 格式: {img.format or 'unknown'}")
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        colors = dominant_colors(img, args.top_colors)
        if colors:
            pairs = ", ".join(f"rgb{rgb}={pct}%" for rgb, pct in colors)
            print(f"# 主色调: {pairs}")

        # OCR 需要真实图片文件；.b64 输入先解码到临时文件
        if args.path.endswith(".b64"):
            fd, tmp = tempfile.mkstemp(suffix=".png")
            os.close(fd)
            img.save(tmp, format="PNG")
            source = tmp

        lines = run_ocr(source)
        if not lines:
            print("# OCR: 未识别到文字")
            return 0
        print(f"# OCR: 识别到 {len(lines)} 条文本")

        ordered = reading_order(lines)
        tables, rest = detect_tables(ordered)

        print("[1.00] 【版面说明】各行末尾 @x,y 为文本框左上角坐标；文本已按阅读顺序重排（多栏先左后右、栏内自上而下）；表格已还原为竖线分隔的 Markdown 行。")

        # 按阅读顺序原位输出：表格行在首次遇到时整行输出
        table_ids = set()
        row_of = {}
        for t in tables:
            for r in t:
                for i in r:
                    table_ids.add(id(i))
                    row_of[id(i)] = r
        emitted = set()
        for it in ordered:
            if id(it) in table_ids:
                if id(it) in emitted:
                    continue
                row = row_of[id(it)]
                cells = " | ".join(i["text"] for i in sorted(row, key=lambda i: i["x1"]))
                y0 = min(i["y1"] for i in row)
                x0 = min(i["x1"] for i in row)
                score = max(i["score"] for i in row)
                print(f"[{score:.2f}] | {cells} | @{int(x0)},{int(y0)}")
                for m in row:
                    emitted.add(id(m))
            else:
                print(fmt_line(it))
        return 0
    except Exception as exc:
        print(f"分析失败: {exc}")
        return 1
    finally:
        if tmp is not None and os.path.isfile(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


if __name__ == "__main__":
    sys.exit(main())
