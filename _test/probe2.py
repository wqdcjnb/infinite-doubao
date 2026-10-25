import ctypes, ctypes.wintypes as w, time, sys, subprocess
from PIL import Image

u = ctypes.windll.user32
g = ctypes.windll.gdi32

EXE = "无限豆包.exe"


def main_pid():
    out = subprocess.run(["tasklist", "/FI", f"IMAGENAME eq {EXE}", "/FO", "CSV", "/NH"],
                         capture_output=True, text=True, encoding="gbk", errors="ignore").stdout
    pids = []
    for line in out.splitlines():
        parts = [p.strip('"') for p in line.split('","')]
        if len(parts) >= 2 and parts[1].isdigit():
            pids.append(int(parts[1]))
    return sorted(pids)


def window_of(pids):
    EP = ctypes.WINFUNCTYPE(ctypes.c_bool, w.HWND, w.LPARAM)
    hits = []

    def cb(h, l):
        if not u.IsWindowVisible(h):
            return True
        pid = w.DWORD()
        u.GetWindowThreadProcessId(h, ctypes.byref(pid))
        if pid.value in pids:
            n = u.GetWindowTextLengthW(h)
            if n > 0:
                r = w.RECT()
                u.GetWindowRect(h, ctypes.byref(r))
                if (r.right - r.left) > 600:
                    hits.append((h, r.right - r.left, r.bottom - r.top))
        return True

    u.EnumWindows(EP(cb), 0)
    hits.sort(key=lambda t: -(t[1] * t[2]))
    return hits[0][0] if hits else None


def shot(h, out):
    r = w.RECT(); u.GetWindowRect(h, ctypes.byref(r))
    W, H = r.right - r.left, r.bottom - r.top
    hdc = u.GetWindowDC(h); mdc = g.CreateCompatibleDC(hdc)
    bmp = g.CreateCompatibleBitmap(hdc, W, H)
    g.SelectObject(mdc, bmp)
    u.PrintWindow(h, mdc, 2)

    class BH(ctypes.Structure):
        _fields_ = [("biSize", w.DWORD), ("biWidth", w.LONG), ("biHeight", w.LONG),
                    ("biPlanes", w.WORD), ("biBitCount", w.WORD), ("biCompression", w.DWORD),
                    ("biSizeImage", w.DWORD), ("biXPelsPerMeter", w.LONG), ("biYPelsPerMeter", w.LONG),
                    ("biClrUsed", w.DWORD), ("biClrImportant", w.DWORD)]

    bi = BH(); bi.biSize = ctypes.sizeof(bi); bi.biWidth = W; bi.biHeight = -H
    bi.biPlanes = 1; bi.biBitCount = 32
    buf = ctypes.create_string_buffer(W * H * 4)
    g.GetDIBits(mdc, bmp, 0, H, buf, ctypes.byref(bi), 0)
    Image.frombuffer("RGBA", (W, H), buf, "raw", "BGRA", 0, 1).convert("RGB").save(out)
    g.DeleteObject(bmp); g.DeleteDC(mdc); u.ReleaseDC(h, hdc)
    return W, H


def click(h, x, y, wait=1.0):
    r = w.RECT(); u.GetWindowRect(h, ctypes.byref(r))
    u.SetForegroundWindow(h); time.sleep(0.3)
    u.SetCursorPos(r.left + x, r.top + y); time.sleep(0.15)
    u.mouse_event(0x0002, 0, 0, 0, 0); time.sleep(0.06)
    u.mouse_event(0x0004, 0, 0, 0, 0)
    time.sleep(wait)


def focus(h):
    u.ShowWindow(h, 9)
    u.SetForegroundWindow(h)
    time.sleep(0.6)


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "shot"
    out = sys.argv[2] if len(sys.argv) > 2 else r"D:\Project\DolaMod\_test\probe.png"
    h = window_of(main_pid())
    if not h:
        sys.exit("no window")
    focus(h)
    if mode == "click" and len(sys.argv) > 4:
        click(h, int(sys.argv[3]), int(sys.argv[4]), float(sys.argv[5]) if len(sys.argv) > 5 else 1.5)
    print(shot(h, out), "->", out)
