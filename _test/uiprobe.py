import ctypes, ctypes.wintypes as w, time, sys
from PIL import Image

u = ctypes.windll.user32
g = ctypes.windll.gdi32

def find_window(title_part="豆包号王"):
    EP = ctypes.WINFUNCTYPE(ctypes.c_bool, w.HWND, w.LPARAM)
    found = []
    def cb(h, l):
        n = u.GetWindowTextLengthW(h)
        if n:
            b = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(h, b, n + 1)
            if title_part in b.value:
                found.append(h)
        return True
    u.EnumWindows(EP(cb), 0)
    return found[0] if found else None

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

def click(h, x, y):
    """x,y 为窗口内坐标"""
    r = w.RECT(); u.GetWindowRect(h, ctypes.byref(r))
    sx, sy = r.left + x, r.top + y
    u.SetForegroundWindow(h)
    time.sleep(0.25)
    u.SetCursorPos(sx, sy)
    time.sleep(0.12)
    u.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
    time.sleep(0.05)
    u.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
    time.sleep(0.4)

if __name__ == "__main__":
    h = find_window()
    if not h:
        sys.exit("window not found")
    u.ShowWindow(h, 9)
    u.SetForegroundWindow(h)
    time.sleep(0.6)
    bx = int(sys.argv[1]); by = int(sys.argv[2])
    out = sys.argv[3]
    click(h, bx, by)
    time.sleep(float(sys.argv[4]) if len(sys.argv) > 4 else 1.2)
    print(shot(h, out), "->", out)
