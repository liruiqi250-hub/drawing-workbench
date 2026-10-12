"""使用合成文件验证预览模块；不读取用户图纸，不启动 CAD。"""

import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

from PIL import Image
from pypdf import PdfWriter
from pypdf.generic import (
    ArrayObject, DecodedStreamObject, DictionaryObject, NameObject,
)


MODULE_PATH = Path(__file__).with_name("preview_file.py")
spec = importlib.util.spec_from_file_location("preview_file", MODULE_PATH)
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def make_pdf(path, page_texts, *, width=1600, height=1000):
    writer = PdfWriter()
    for text in page_texts:
        page = writer.add_blank_page(width=width, height=height)
        if text:
            font = DictionaryObject({
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            })
            page[NameObject("/Resources")] = DictionaryObject({
                NameObject("/Font"): DictionaryObject({
                    NameObject("/F1"): writer._add_object(font),
                }),
                NameObject("/ProcSet"): ArrayObject([NameObject("/PDF"), NameObject("/Text")]),
            })
            stream = DecodedStreamObject()
            # ASCII fixture 文本来自测试自身，非用户资料。
            escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            stream.set_data(f"BT /F1 24 Tf 40 800 Td ({escaped}) Tj ET".encode("ascii"))
            page[NameObject("/Contents")] = writer._add_object(stream)
    with path.open("wb") as handle:
        writer.write(handle)
    writer.close()


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="图纸预览 中文 空格 ")
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def invoke(self, source, output, text_limit=12000):
        completed = subprocess.run(
            [sys.executable, str(MODULE_PATH), "--input", str(source),
             "--output", str(output), "--text-limit", str(text_limit)],
            capture_output=True, text=True, encoding="utf-8", timeout=30,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(len(completed.stdout.strip().splitlines()), 1)
        return json.loads(completed.stdout)

    def assert_png(self, path):
        with Image.open(path) as image:
            self.assertEqual(image.format, "PNG")
            self.assertLessEqual(max(image.size), 900)
            image.load()

    def test_text_pdf_real_preview_readonly_chinese_path(self):
        source = self.root / "机械 图纸 中文.pdf"
        output = self.root / "预览 缓存" / "首页.png"
        make_pdf(source, ["CAD fixture searchable text 2026", "SECOND PAGE"])
        before = digest(source)
        data = self.invoke(source, output)
        self.assertTrue(data["ok"])
        self.assertEqual(data["status"], "ready")
        self.assertEqual(data["pages"], 2)
        self.assertTrue(data["preview"])
        self.assertIn("CAD fixture searchable text 2026", data["text"])
        self.assertIn("SECOND PAGE", data["text"])
        self.assertEqual(digest(source), before)
        self.assert_png(output)
        with Image.open(output) as image:
            self.assertLess(image.convert("RGB").getextrema()[0][0], 255)

    def test_blank_pdf_no_text_but_true_preview(self):
        source, output = self.root / "无文字页.pdf", self.root / "空白.png"
        make_pdf(source, [""])
        before = digest(source)
        data = self.invoke(source, output)
        self.assertTrue(data["ok"])
        self.assertEqual(data["status"], "no_text")
        self.assertEqual(data["text"], "")
        self.assertTrue(data["preview"])
        self.assertEqual(digest(source), before)
        self.assert_png(output)

    def test_page_and_character_limits(self):
        source, output = self.root / "九页.pdf", self.root / "九页.png"
        make_pdf(source, [f"PAGE_{index}" for index in range(1, 10)])
        data = self.invoke(source, output)
        self.assertEqual(data["pages"], 9)
        self.assertIn("PAGE_8", data["text"])
        self.assertNotIn("PAGE_9", data["text"])
        limited = self.invoke(source, output, 5)
        self.assertEqual(len(limited["text"]), 5)

    def test_corrupt_missing_unsupported_and_same_output(self):
        output = self.root / "缓存.png"
        corrupt = self.root / "坏文件.pdf"
        corrupt.write_bytes(b"this is not a PDF")
        self.assertEqual(self.invoke(corrupt, output)["status"], "error")
        self.assertFalse(output.exists())
        self.assertEqual(self.invoke(self.root / "不存在.pdf", output)["status"], "error")
        dxf = self.root / "示例.dxf"
        dxf.write_text("fixture", encoding="utf-8")
        before = digest(dxf)
        self.assertEqual(self.invoke(dxf, output)["status"], "unsupported")
        self.assertEqual(self.invoke(dxf, dxf)["status"], "error")
        self.assertEqual(digest(dxf), before)

    def test_oversized_source_is_skipped_without_reading(self):
        source = self.root / "过大.pdf"
        with source.open("wb") as handle:
            handle.truncate(preview.MAX_FILE_BYTES + 1)
        data = self.invoke(source, self.root / "过大.png")
        self.assertEqual(data["status"], "unsupported")
        self.assertIn("skipped:", data["error"])
        self.assertFalse(data["preview"])

    def test_invalid_dwg_never_returns_file_icon(self):
        source, output = self.root / "假图纸.dwg", self.root / "假图纸.png"
        source.write_bytes(b"fixture that is not a drawing")
        before = digest(source)
        data = self.invoke(source, output)
        self.assertEqual(data["status"], "unsupported")
        self.assertFalse(data["preview"])
        self.assertFalse(output.exists())
        self.assertEqual(digest(source), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
