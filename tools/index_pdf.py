"""V0.5.5 PDF 只读索引：逐页文字、尺寸及 Windows 本地 OCR。

源文件仅 rb 打开。临时渲染和 OCR 清单只写 cacheDir，退出时清理。
stdout 为单行 JSON；不联网、不修改 PDF、不启动 CAD。
"""
from __future__ import annotations

import argparse
import contextlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unicodedata

MAX_BYTES = 256 * 1024 * 1024
MAX_CHARS = 200000
MAX_PAGE_CHARS = 20000
MAX_OCR_EDGE = 2400


def dimensions(text):
    value = unicodedata.normalize('NFKC', text)
    pattern = r'(?<![A-Za-z0-9_.])(?:[ΦφϕØø⌀∅]\s*\d+(?:\.\d+)?(?:\s*(?:mm|毫米))?|R\s*\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:mm|cm|毫米|厘米|米|°)|\d+(?:\.\d+)?\s*[×xX]\s*\d+(?:\.\d+)?(?:\s*[×xX]\s*\d+(?:\.\d+)?)?)'
    return list(dict.fromkeys(m.group(0).strip() for m in re.finditer(pattern, value, re.I)))[:150]


def object_counts(page):
    import pypdfium2 as pdfium
    paths = images = 0
    # Bound walking time for pathological CAD exports with millions of objects.
    for index, obj in enumerate(page.get_objects(max_depth=4)):
        if index >= 10000:
            break
        paths += obj.type == pdfium.raw.FPDF_PAGEOBJ_PATH
        images += obj.type == pdfium.raw.FPDF_PAGEOBJ_IMAGE
    return int(paths), int(images)


def run_ocr(manifest, timeout):
    if os.name != 'nt':
        return {'available': False, 'error': '本地 OCR 需要 Windows 10/11 的文字识别组件。'}
    powershell = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    proc = subprocess.run([str(powershell), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(Path(__file__).with_name('windows_ocr.ps1')), '-InputManifest', str(manifest)], capture_output=True, timeout=max(1, timeout), creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    try:
        return json.loads(proc.stdout.decode('utf-8-sig').strip())
    except (ValueError, UnicodeError):
        return {'available': False, 'error': 'Windows 本地 OCR 未返回有效结果。'}


def index_pdf(input_path, options):
    import pypdfium2 as pdfium
    source = Path(input_path)
    if not source.is_absolute():
        raise ValueError('PDF 路径必须是绝对路径。')
    source = source.resolve(strict=True)
    if not source.is_file() or source.suffix.lower() != '.pdf':
        raise ValueError('文件不是 PDF。')
    if source.stat().st_size > MAX_BYTES:
        raise ValueError('PDF 超过 256MB 本地索引上限，仍保留文件名搜索。')
    max_pages = min(100, max(1, int(options.get('maxPages', 30))))
    ocr_max = min(30, max(1, int(options.get('ocrMaxPages', 10))))
    cache = Path(options.get('cacheDir') or tempfile.gettempdir()).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    # Never permit caller-supplied caches to replace the source path.
    if cache == source:
        raise ValueError('OCR 缓存目录不能是源 PDF。')
    start = time.monotonic()
    pages, ocr_jobs, errors = [], [], []
    total_chars = 0
    result = {'status': 'no_text', 'text': '', 'pages': pages, 'totalPages': 0, 'indexedPages': 0, 'truncated': False, 'ocrPages': 0, 'error': ''}
    with tempfile.TemporaryDirectory(prefix='pdf-ocr-', dir=cache) as scratch:
        with source.open('rb') as handle:
            document = pdfium.PdfDocument(handle, autoclose=False)
            try:
                result['totalPages'] = len(document)
                if not len(document):
                    raise ValueError('PDF 没有页面。')
                result['truncated'] = len(document) > max_pages
                for index in range(min(len(document), max_pages)):
                    if time.monotonic() - start > 100 or total_chars >= MAX_CHARS:
                        result['truncated'] = True
                        break
                    page = document.get_page(index)
                    try:
                        textpage = page.get_textpage()
                        try:
                            text = textpage.get_text_bounded().replace('\x00', '').strip()
                        finally:
                            textpage.close()
                        if len(text) > MAX_PAGE_CHARS:
                            result['truncated'] = True
                            text = text[:MAX_PAGE_CHARS]
                        text = text[:MAX_CHARS - total_chars]
                        total_chars += len(text)
                        paths, images = object_counts(page)
                        item = {'page': index + 1, 'text': text, 'source': 'text' if text else 'none', 'dimensions': dimensions(text), 'vectorPathCount': paths, 'imageCount': images}
                        pages.append(item)
                        # Raster scans and outlined CAD labels need image recognition.
                        needs_ocr = len(re.sub(r'\s', '', text)) < 80 or (not item['dimensions'] and paths >= 100)
                        item['needsOcr'] = needs_ocr
                        if options.get('ocrEnabled', True) and needs_ocr:
                            if len(ocr_jobs) >= ocr_max:
                                item['ocrError'] = '超过本次 OCR 页数上限。'
                                result['truncated'] = True
                                continue
                            width, height = page.get_size()
                            if not all(math.isfinite(v) and v > 0 for v in [width, height]):
                                item['ocrError'] = '页面尺寸无效。'
                                continue
                            scale = min(2.5, MAX_OCR_EDGE / max(width, height))
                            bitmap = page.render(scale=scale)
                            try:
                                image = bitmap.to_pil()
                                try:
                                    dest = Path(scratch) / f'page-{index + 1}.png'
                                    image.save(dest)
                                finally:
                                    image.close()
                            finally:
                                bitmap.close()
                            ocr_jobs.append({'page': index + 1, 'path': str(dest)})
                    except Exception as exc:
                        if pages and pages[-1]['page'] == index + 1:
                            pages[-1]['error'] = str(exc)[:300]
                        else:
                            pages.append({'page': index + 1, 'text': '', 'source': 'none', 'dimensions': [], 'error': str(exc)[:300]})
                        errors.append(f'第 {index + 1} 页读取失败。')
                    finally:
                        page.close()
            finally:
                document.close()
        if ocr_jobs:
            manifest = Path(scratch) / 'manifest.json'
            manifest.write_text(json.dumps(ocr_jobs, ensure_ascii=True), encoding='utf-8')
            try:
                recognized = run_ocr(manifest, min(100, 165 - (time.monotonic() - start)))
            except subprocess.TimeoutExpired:
                recognized = {'available': False, 'error': '本地 OCR 超时，可减少每次 OCR 页数后重试。'}
            by_page = {p['page']: p for p in recognized.get('pages', [])}
            for item in pages:
                if not any(job['page'] == item['page'] for job in ocr_jobs):
                    continue
                ocr = by_page.get(item['page'], {})
                if ocr.get('text', '').strip():
                    # Preserve native text alongside OCR; distinguish source for review.
                    # Windows Chinese OCR often separates every Han character.
                    recognized_text = re.sub(r'(?<=[\u3400-\u9fff])[^\S\n]+(?=[\u3400-\u9fff])', '', ocr['text'].strip())[:MAX_PAGE_CHARS]
                    item['text'] = (item['text'] + '\n' + recognized_text).strip()[:MAX_PAGE_CHARS]
                    item['source'] = 'ocr'
                    item['dimensions'] = dimensions(item['text'])
                    result['ocrPages'] += 1
                else:
                    item['ocrError'] = ocr.get('error') or recognized.get('error') or '本地 OCR 未识别出文字。'
                    errors.append(f"第 {item['page']} 页：{item['ocrError']}")
        # OCR may add text after the native extraction budget was counted.
        # Bound the page payload too, not only the concatenated search text.
        remaining = MAX_CHARS
        for item in pages:
            body = item.get('text', '')
            if len(body) > remaining:
                item['text'] = body[:remaining]
                item['dimensions'] = dimensions(item['text'])
                result['truncated'] = True
            remaining -= len(item.get('text', ''))
        combined = '\n\n'.join(f"[第 {item['page']} 页]\n{item['text']}" for item in pages if item.get('text'))
        if len(combined) > MAX_CHARS:
            combined = combined[:MAX_CHARS]
            result['truncated'] = True
        result['text'] = combined
        result['indexedPages'] = sum(bool(item.get('text')) for item in pages)
        result['error'] = '；'.join(dict.fromkeys(errors))[:1000]
        result['status'] = 'partial' if (errors or result['truncated']) else 'ready' if combined else 'no_text'
    return result


def main():
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument('--input', required=True)
        parser.add_argument('--options', default='{}')
        args = parser.parse_args()
        options = json.loads(args.options)
        if not isinstance(options, dict):
            raise ValueError('PDF 索引选项必须是对象。')
        with contextlib.redirect_stdout(sys.stderr):
            result = index_pdf(args.input, options)
    except Exception as exc:
        result = {'status': 'error', 'text': '', 'pages': [], 'totalPages': 0, 'indexedPages': 0, 'truncated': False, 'ocrPages': 0, 'error': str(exc)[:1000]}
    print(json.dumps(result, ensure_ascii=True, separators=(',', ':')))


if __name__ == '__main__':
    main()
