# -*- coding: utf-8 -*-
"""
素材遮脸（人脸打码）

用法（由 Electron 主进程调用，也可单独跑）：
    python face_mask.py --files a.jpg b.mp4 --mode mosaic --strength 18 --pad 0.18

模式：
    mosaic  马赛克（像素块）
    blur    高斯模糊
    dot     圆点阵（打点）
    black   纯色遮挡

输出：
    图片 -> 原目录 xxx_masked.<ext>
    视频 -> 原目录 xxx_masked.mp4（音频直通拷贝，画面重编码）

进度按 JSON 行输出到 stdout：
    {"event":"progress","file":"...","percent":12.3,"faces":2}
    {"event":"done","file":"...","out":"...","faces":N}
    {"event":"error","file":"...","message":"..."}
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

import cv2
import numpy as np

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".flv", ".ts"}


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class Detector:
    """YuNet 检测器：检测尺度限制在 960 宽以内，保证 4K 素材也能跑到实时级别。"""

    def __init__(self, model_path, score=0.6):
        self.model = model_path
        self.score = score
        # 从内存加载模型，支持 Windows 安装目录中的中文名称。
        model = np.fromfile(model_path, dtype=np.uint8)
        self.det = cv2.FaceDetectorYN.create("onnx", model, np.empty(0, dtype=np.uint8), (320, 320), score, 0.3, 5000)

    def detect(self, frame_bgr):
        h, w = frame_bgr.shape[:2]
        scale = 1.0
        small = frame_bgr
        if w > 960:
            scale = 960.0 / w
            small = cv2.resize(frame_bgr, (960, int(h * scale)), interpolation=cv2.INTER_AREA)
        sh, sw = small.shape[:2]
        self.det.setInputSize((sw, sh))
        _, faces = self.det.detect(small)
        out = []
        if faces is None:
            return out
        for f in faces:
            if float(f[-1]) < self.score:
                continue
            x, y, ww, hh = [float(v) for v in f[:4]]
            out.append((x / scale, y / scale, ww / scale, hh / scale))
        return out


def expand(box, pad, w, h):
    x, y, bw, bh = box
    cx, cy = x + bw / 2.0, y + bh / 2.0
    bw *= 1.0 + pad * 2
    bh *= 1.0 + pad * 2
    x0 = max(0, int(round(cx - bw / 2)))
    y0 = max(0, int(round(cy - bh / 2)))
    x1 = min(w, int(round(cx + bw / 2)))
    y1 = min(h, int(round(cy + bh / 2)))
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, y0, x1, y1


def mosaic(roi, strength):
    h, w = roi.shape[:2]
    block = max(2, int(strength))
    small = cv2.resize(roi, (max(1, w // block), max(1, h // block)), interpolation=cv2.INTER_LINEAR)
    return cv2.resize(small, (w, h), interpolation=cv2.INTER_NEAREST)


def blur_roi(roi, strength):
    k = max(3, int(strength) | 1)
    k = min(k, 199)
    return cv2.GaussianBlur(roi, (k, k), 0)


def dots(roi, strength):
    h, w = roi.shape[:2]
    step = max(4, int(strength))
    radius = max(2, int(step * 0.52))
    # 底层先做轻马赛克：点与点之间透出来的像素是模糊的，不会漏出真实五官
    out = mosaic(roi, max(2, step // 3))
    base = mosaic(roi, max(2, step // 2))
    for yy in range(0, h, step):
        for xx in range(0, w, step):
            color = base[min(h - 1, yy + step // 2), min(w - 1, xx + step // 2)].tolist()
            cv2.circle(out, (xx + step // 2, yy + step // 2), radius, color, -1, lineType=cv2.LINE_AA)
    return out


def apply_mask(frame, boxes, mode, strength, pad):
    h, w = frame.shape[:2]
    faces = 0
    for box in boxes:
        rect = expand(box, pad, w, h)
        if not rect:
            continue
        faces += 1
        x0, y0, x1, y1 = rect
        roi = frame[y0:y1, x0:x1]
        if roi.size == 0:
            continue
        if mode == "mosaic":
            frame[y0:y1, x0:x1] = mosaic(roi, strength)
        elif mode == "blur":
            frame[y0:y1, x0:x1] = blur_roi(roi, strength)
        elif mode == "dot":
            frame[y0:y1, x0:x1] = dots(roi, strength)
        elif mode == "black":
            # 取脸上平均值压暗成纯色，避免死黑显得突兀
            avg = roi.reshape(-1, 3).mean(axis=0)
            frame[y0:y1, x0:x1] = np.clip(avg * 0.25, 0, 255).astype(np.uint8)
        else:
            frame[y0:y1, x0:x1] = mosaic(roi, strength)
    return frame, faces


def out_path(src, out_dir, ext=None):
    d = out_dir or os.path.dirname(os.path.abspath(src))
    os.makedirs(d, exist_ok=True)
    base, old = os.path.splitext(os.path.basename(src))
    suffix = ext or old
    return os.path.join(d, f"{base}_masked{suffix}")


def handle_image(det, path, args):
    data = np.fromfile(path, dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if img is None:
        emit({"event": "error", "file": path, "message": "图片读取失败"})
        return None
    boxes = det.detect(img)
    out_img, faces = apply_mask(img, boxes, args.mode, args.strength, args.pad)
    dst = out_path(path, args.out_dir)
    ext = os.path.splitext(dst)[1] or ".png"
    ok, buf = cv2.imencode(ext, out_img, [int(cv2.IMWRITE_JPEG_QUALITY), 95] if ext.lower() in (".jpg", ".jpeg") else [])
    if not ok:
        emit({"event": "error", "file": path, "message": "图片编码失败"})
        return None
    buf.tofile(dst)
    if args.no_keep and os.path.abspath(dst) != os.path.abspath(path):
        try:
            os.remove(path)
        except Exception:
            pass
    emit({"event": "done", "file": path, "out": dst, "faces": faces, "kind": "image"})
    return {"file": path, "out": dst, "faces": faces}


def video_meta(path):
    cap = cv2.VideoCapture(path)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0) or 25.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    cap.release()
    if not w or not h:
        # 有些容器 OpenCV 读不到尺寸，退回 ffprobe
        try:
            r = subprocess.run(
                [args.ffprobe, "-v", "error", "-select_streams", "v:0",
                 "-show_entries", "stream=width,height,r_frame_rate", "-of", "json", path],
                capture_output=True, text=True, timeout=30)
            j = json.loads(r.stdout or "{}")
            st = (j.get("streams") or [{}])[0]
            w = int(st.get("width") or 0)
            h = int(st.get("height") or 0)
            num, den = (st.get("r_frame_rate") or "25/1").split("/")
            fps = float(num) / float(den or 1)
        except Exception:
            pass
    return w, h, fps, total


def handle_video(det, path, args):
    w, h, fps, total = video_meta(path)
    if not w or not h:
        emit({"event": "error", "file": path, "message": "视频尺寸读取失败，可能不是有效视频"})
        return None

    dst = out_path(path, args.out_dir, ".mp4")
    dec_cmd = [args.ffmpeg, "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    enc_cmd = [
        args.ffmpeg, "-v", "error", "-y",
        "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", f"{fps}", "-i", "-",
        "-i", path,
        "-map", "0:v:0", "-map", "1:a:0?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        "-c:a", "copy", "-shortest", dst,
    ]

    dec = subprocess.Popen(dec_cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    enc = subprocess.Popen(enc_cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
    frame_bytes = w * h * 3
    idx = 0
    faces_total = 0
    last = []
    try:
        while True:
            buf = dec.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                break
            frame = np.frombuffer(buf, np.uint8).reshape((h, w, 3)).copy()
            # 每 2 帧检测一次：人脸位置在连续帧里几乎不动，省一半算力且观感无差
            if idx % 2 == 0:
                boxes = det.detect(frame)
                last = boxes
            else:
                boxes = last
            frame, n = apply_mask(frame, boxes, args.mode, args.strength, args.pad)
            faces_total += n
            enc.stdin.write(frame.tobytes())
            idx += 1
            if idx % 5 == 0:
                pct = (idx / total * 100.0) if total else 0.0
                emit({"event": "progress", "file": path, "percent": round(min(pct, 99.0), 1), "faces": len(boxes)})
    finally:
        try:
            enc.stdin.close()
        except Exception:
            pass
        err = b""
        try:
            err = enc.stderr.read() or b""
        except Exception:
            pass
        try:
            dec.kill()
        except Exception:
            pass
        rc = enc.wait()

    if rc != 0 or not os.path.exists(dst) or os.path.getsize(dst) < 1024:
        emit({"event": "error", "file": path, "message": "ffmpeg 编码失败: " + err.decode("utf-8", "ignore")[-400:]})
        return None

    if args.no_keep and os.path.abspath(dst) != os.path.abspath(path):
        try:
            os.remove(path)
        except Exception:
            pass
    emit({"event": "done", "file": path, "out": dst, "faces": faces_total, "frames": idx, "kind": "video"})
    return {"file": path, "out": dst, "faces": faces_total, "frames": idx}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--files", nargs="+", required=True)
    ap.add_argument("--mode", default="mosaic", choices=["mosaic", "blur", "dot", "black"])
    ap.add_argument("--strength", type=int, default=18)
    ap.add_argument("--pad", type=float, default=0.18)
    ap.add_argument("--model", required=True)
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--ffprobe", default="ffprobe")
    ap.add_argument("--out-dir", default="")
    ap.add_argument("--no-keep", action="store_true")
    ap.add_argument("--json-progress", action="store_true")
    ap.add_argument("--score", type=float, default=0.6)
    args = ap.parse_args()

    if not os.path.exists(args.model):
        emit({"event": "error", "file": "", "message": "模型文件不存在: " + args.model})
        sys.exit(2)

    det = Detector(args.model, args.score)
    ok = 0
    fail = 0
    for path in args.files:
        if not os.path.exists(path):
            emit({"event": "error", "file": path, "message": "文件不存在"})
            fail += 1
            continue
        ext = os.path.splitext(path)[1].lower()
        try:
            if ext in IMAGE_EXT:
                res = handle_image(det, path, args)
            elif ext in VIDEO_EXT:
                res = handle_video(det, path, args)
            else:
                emit({"event": "error", "file": path, "message": "不支持的格式 " + ext})
                res = None
            if res:
                ok += 1
            else:
                fail += 1
        except Exception as exc:  # noqa: BLE001
            emit({"event": "error", "file": path, "message": str(exc)})
            fail += 1

    emit({"event": "summary", "ok": ok, "fail": fail})
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
