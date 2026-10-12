"""图纸工作台 V0.3.1 的独立只读预览进程。

仅向指定 PNG 缓存写入，不启动 CAD，不修改源文件。stdout 始终只有一行 JSON。
"""

from __future__ import annotations

import argparse
import contextlib
import ctypes
from ctypes import wintypes
import json
import math
import os
from pathlib import Path
import sys
import tempfile


VERSION = "0.3.1"
MAX_FILE_BYTES = 256 * 1024 * 1024
MAX_IMAGE_EDGE = 900
MAX_TEXT_PAGES = 8
MAX_TEXT_CHARS = 12000


def result(status="error", *, text="", pages=None, preview=False, error=None):
    data = {
        "ok": status in ("ready", "no_text"),
        "status": status,
        "text": text,
        "pages": pages,
        "preview": preview,
    }
    if error:
        data["error"] = str(error)
    return data


def save_png(image, output: Path):
    """先完整写出临时 PNG，再替换本程序的缓存，避免半张缓存。"""
    output.parent.mkdir(parents=True, exist_ok=True)
    image.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE))
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=".preview-", suffix=".png", dir=output.parent, delete=False
        ) as handle:
            temporary = Path(handle.name)
            image.save(handle, format="PNG")
        os.replace(temporary, output)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink(missing_ok=True)


def preview_pdf(source: Path, output: Path, text_limit: int):
    import pypdfium2 as pdfium

    data = result()
    document = None
    try:
        # 显式 rb；PDFium 文档关闭后再关闭源句柄。
        with source.open("rb") as handle:
            try:
                document = pdfium.PdfDocument(handle, autoclose=False)
                data["pages"] = len(document)
                if not len(document):
                    raise ValueError("PDF 没有页面")
                parts = []
                remaining = text_limit
                for index in range(min(len(document), MAX_TEXT_PAGES)):
                    page = document.get_page(index)
                    try:
                        if index == 0:
                            width, height = page.get_size()
                            if not all(math.isfinite(v) and v > 0 for v in (width, height)):
                                raise ValueError("PDF 首页尺寸无效")
                            scale = min(1.0, MAX_IMAGE_EDGE / max(width, height))
                            bitmap = page.render(scale=scale)
                            try:
                                image = bitmap.to_pil().copy()
                                try:
                                    save_png(image, output)
                                finally:
                                    image.close()
                            finally:
                                bitmap.close()
                            data["preview"] = True
                        if remaining > 0:
                            textpage = page.get_textpage()
                            try:
                                page_text = textpage.get_text_bounded()
                            finally:
                                textpage.close()
                            page_text = page_text.replace("\r\n", "\n").replace("\r", "\n")
                            page_text = page_text.replace("\x00", "").strip()
                            if page_text:
                                separator = "\n\n" if parts else ""
                                piece = (separator + page_text)[:remaining]
                                parts.append(piece)
                                remaining -= len(piece)
                    finally:
                        page.close()
                    if remaining == 0:
                        break
                data["text"] = "".join(parts)
                data["status"] = "ready" if data["text"].strip() else "no_text"
                data["ok"] = True
            finally:
                if document is not None:
                    document.close()
    except Exception as exc:
        data["status"] = "error"
        data["ok"] = False
        data["error"] = f"PDF 读取或渲染失败：{exc}"
    return data


def preview_dwg(source: Path, output: Path):
    """只获取 Windows 注册处理器提供的真实缩略图，禁止图标回退。"""
    if os.name != "nt":
        return result("unsupported", error="DWG 真实缩略图仅支持 Windows Shell")

    from PIL import Image

    class GUID(ctypes.Structure):
        _fields_ = [
            ("Data1", wintypes.DWORD),
            ("Data2", wintypes.WORD),
            ("Data3", wintypes.WORD),
            ("Data4", ctypes.c_ubyte * 8),
        ]

    class SIZE(ctypes.Structure):
        _fields_ = [("cx", wintypes.LONG), ("cy", wintypes.LONG)]

    class BITMAP(ctypes.Structure):
        _fields_ = [
            ("bmType", wintypes.LONG),
            ("bmWidth", wintypes.LONG),
            ("bmHeight", wintypes.LONG),
            ("bmWidthBytes", wintypes.LONG),
            ("bmPlanes", wintypes.WORD),
            ("bmBitsPixel", wintypes.WORD),
            ("bmBits", ctypes.c_void_p),
        ]

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ("biSize", wintypes.DWORD),
            ("biWidth", wintypes.LONG),
            ("biHeight", wintypes.LONG),
            ("biPlanes", wintypes.WORD),
            ("biBitCount", wintypes.WORD),
            ("biCompression", wintypes.DWORD),
            ("biSizeImage", wintypes.DWORD),
            ("biXPelsPerMeter", wintypes.LONG),
            ("biYPelsPerMeter", wintypes.LONG),
            ("biClrUsed", wintypes.DWORD),
            ("biClrImportant", wintypes.DWORD),
        ]

    ole32 = ctypes.WinDLL("ole32")
    shell32 = ctypes.WinDLL("shell32")
    gdi32 = ctypes.WinDLL("gdi32")
    hresult = ctypes.c_long
    ole32.CoInitializeEx.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    ole32.CoInitializeEx.restype = hresult
    ole32.CoUninitialize.argtypes = []
    ole32.CoUninitialize.restype = None
    ole32.CLSIDFromString.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(GUID)]
    ole32.CLSIDFromString.restype = hresult
    shell32.SHCreateItemFromParsingName.argtypes = [
        wintypes.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(GUID),
        ctypes.POINTER(ctypes.c_void_p),
    ]
    shell32.SHCreateItemFromParsingName.restype = hresult
    gdi32.GetObjectW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p]
    gdi32.GetObjectW.restype = ctypes.c_int
    gdi32.CreateCompatibleDC.argtypes = [ctypes.c_void_p]
    gdi32.CreateCompatibleDC.restype = ctypes.c_void_p
    gdi32.GetDIBits.argtypes = [
        ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT, wintypes.UINT,
        ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT,
    ]
    gdi32.GetDIBits.restype = ctypes.c_int
    gdi32.DeleteObject.argtypes = [ctypes.c_void_p]
    gdi32.DeleteObject.restype = wintypes.BOOL
    gdi32.DeleteDC.argtypes = [ctypes.c_void_p]
    gdi32.DeleteDC.restype = wintypes.BOOL

    factory = ctypes.c_void_p()
    bitmap_handle = ctypes.c_void_p()
    dc = None
    initialized = False
    try:
        # 单独 CLI 进程的 STA，不附着任何正在运行的 CAD。
        init_hr = ole32.CoInitializeEx(None, 2)
        if init_hr not in (0, 1, -2147417850):  # RPC_E_CHANGED_MODE
            raise OSError(f"COM 初始化失败 0x{init_hr & 0xffffffff:08X}")
        initialized = init_hr in (0, 1)
        iid = GUID()
        hr = ole32.CLSIDFromString(
            "{BCC18B79-BA16-442F-80C4-8A59C30C463B}", ctypes.byref(iid)
        )
        if hr < 0:
            raise OSError(f"缩略图接口标识无效 0x{hr & 0xffffffff:08X}")
        hr = shell32.SHCreateItemFromParsingName(
            str(source), None, ctypes.byref(iid), ctypes.byref(factory)
        )
        if hr < 0:
            raise OSError(f"无法取得 DWG Shell 接口 0x{hr & 0xffffffff:08X}")
        vtable = ctypes.cast(
            factory, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))
        ).contents
        get_image = ctypes.WINFUNCTYPE(
            hresult, ctypes.c_void_p, SIZE, wintypes.DWORD,
            ctypes.POINTER(ctypes.c_void_p),
        )(vtable[3])
        # SIIGBF_THUMBNAILONLY=0x08：没有真实缩略图必须失败，不能回退文件图标。
        hr = get_image(factory, SIZE(MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), 0x08,
                       ctypes.byref(bitmap_handle))
        if hr < 0 or not bitmap_handle.value:
            return result(
                "unsupported",
                error=f"DWG 没有可用的真实缩略图或处理器不可用 (0x{hr & 0xffffffff:08X})",
            )
        native_bitmap = BITMAP()
        if not gdi32.GetObjectW(bitmap_handle, ctypes.sizeof(native_bitmap),
                               ctypes.byref(native_bitmap)):
            raise OSError("无法读取缩略图位图信息")
        width, height = native_bitmap.bmWidth, abs(native_bitmap.bmHeight)
        if width <= 0 or height <= 0 or width * height > 16_000_000:
            raise ValueError("系统返回的缩略图尺寸异常")
        header = BITMAPINFOHEADER()
        header.biSize = ctypes.sizeof(header)
        header.biWidth = width
        header.biHeight = -height
        header.biPlanes = 1
        header.biBitCount = 32
        buffer = ctypes.create_string_buffer(width * height * 4)
        dc = gdi32.CreateCompatibleDC(None)
        if not dc:
            raise OSError("无法建立缩略图读取上下文")
        if gdi32.GetDIBits(dc, bitmap_handle, 0, height, buffer,
                          ctypes.byref(header), 0) != height:
            raise OSError("无法读取缩略图像素")
        image = Image.frombytes("RGBA", (width, height), buffer.raw, "raw", "BGRA")
        try:
            alpha = image.getchannel("A")
            try:
                alpha_empty = alpha.getextrema() == (0, 0)
            finally:
                alpha.close()
            if alpha_empty:
                image.putalpha(255)  # 非透明 GDI 位图的 alpha 常为全零。
            save_png(image, output)
        finally:
            image.close()
        return result("ready", preview=True)
    except Exception as exc:
        return result("unsupported", error=f"DWG 真实缩略图不可用：{exc}")
    finally:
        if dc:
            gdi32.DeleteDC(dc)
        if bitmap_handle.value:
            gdi32.DeleteObject(bitmap_handle)
        if factory.value:
            vtable = ctypes.cast(
                factory, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))
            ).contents
            release = ctypes.WINFUNCTYPE(wintypes.ULONG, ctypes.c_void_p)(vtable[2])
            release(factory)
        if initialized:
            ole32.CoUninitialize()


def preview_file(input_path: str, output_path: str, text_limit=MAX_TEXT_CHARS):
    try:
        source = Path(input_path)
        if not source.is_absolute():
            return result(error="input 必须是绝对路径")
        source = source.resolve(strict=True)
        if not source.is_file():
            return result(error="input 不是普通文件")
        output = Path(output_path).resolve(strict=False)
        if source == output or (output.exists() and os.path.samefile(source, output)):
            return result(error="output 不能与源文件相同")
        if source.stat().st_size > MAX_FILE_BYTES:
            return result("unsupported", error="skipped: 文件超过 256MB 只读预览上限")
        text_limit = min(MAX_TEXT_CHARS, max(1, int(text_limit)))
        suffix = source.suffix.lower()
        if suffix == ".pdf":
            return preview_pdf(source, output, text_limit)
        if suffix == ".dwg":
            return preview_dwg(source, output)
        return result("unsupported", error=f"暂不支持 {suffix or '无扩展名'} 的内容预览")
    except Exception as exc:
        return result(error=f"文件无法读取：{exc}")


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise ValueError(message)


def main():
    try:
        parser = JsonArgumentParser(description=__doc__, add_help=False)
        parser.add_argument("--input", required=True)
        parser.add_argument("--output", required=True)
        parser.add_argument("--text-limit", type=int, default=MAX_TEXT_CHARS)
        args = parser.parse_args()
        with contextlib.redirect_stdout(sys.stderr):
            data = preview_file(args.input, args.output, args.text_limit)
    except Exception as exc:
        data = result(error=f"参数或预览处理失败：{exc}")
    # ensure_ascii 保证在 Windows 任意控制台编码下仍是可解析的 UTF-8/ASCII JSON。
    print(json.dumps(data, ensure_ascii=True, separators=(",", ":")))


if __name__ == "__main__":
    main()
