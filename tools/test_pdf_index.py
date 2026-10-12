"""PDF 索引真实合成验收；需要测试开发依赖 pypdf，不读取个人图纸。"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject

sys.dont_write_bytecode = True
HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location('pdf_index', HERE/'index_pdf.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def make_text_pdf(path, texts):
    writer = PdfWriter()
    for text in texts:
        page = writer.add_blank_page(width=1600, height=1000)
        font = DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
        page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
        stream = DecodedStreamObject()
        escaped = text.replace('\\','\\\\').replace('(','\\(').replace(')','\\)')
        stream.set_data(f'BT /F1 30 Tf 40 850 Td ({escaped}) Tj ET'.encode('ascii'))
        page[NameObject('/Contents')] = writer._add_object(stream)
    with path.open('wb') as handle:writer.write(handle)
    writer.close()


def make_scan_pdf(path):
    image = Image.new('RGB',(1600,1000),'white')
    draw = ImageDraw.Draw(image)
    font_path = Path(os.environ.get('SystemRoot',r'C:\Windows'))/'Fonts/msyh.ttc'
    font = ImageFont.truetype(str(font_path),48)
    for index,line in enumerate(['钢架结构图','图号 26-10.29-03','比例 1:20','尺寸 500mm','R50','技术要求：焊接牢固']):
        draw.text((90,60+index*130),line,font=font,fill='black')
    draw.rectangle((800,200,1450,700),outline='black',width=4)
    image.save(path,'PDF',resolution=120)
    image.close()


class PdfIndexTests(unittest.TestCase):
    def setUp(self):
        parent=HERE.parent/'.test-tmp'
        parent.mkdir(exist_ok=True)
        self.temp=tempfile.TemporaryDirectory(prefix='pdf-index-',dir=parent)
        self.root=Path(self.temp.name)
    def tearDown(self):self.temp.cleanup()
    def invoke(self,source,**options):
        before=hashlib.sha256(source.read_bytes()).hexdigest()
        completed=subprocess.run([sys.executable,str(HERE/'index_pdf.py'),'--input',str(source.resolve()),'--options',json.dumps({'cacheDir':str(self.root/'cache'),**options})],capture_output=True,encoding='utf-8',timeout=180)
        self.assertEqual(completed.returncode,0,completed.stderr)
        self.assertEqual(len(completed.stdout.strip().splitlines()),1)
        result=json.loads(completed.stdout)
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),before)
        if (self.root/'cache').exists():self.assertFalse(list((self.root/'cache').iterdir()))
        return result
    def test_native_pages_dimensions_and_limits(self):
        source=self.root/'尺寸 中文 路径.pdf'
        make_text_pdf(source,['DRAWING SCALE 1:20 R50 500mm','SECOND PAGE 1200mm','THIRD PAGE'])
        result=self.invoke(source,ocrEnabled=False,maxPages=2)
        self.assertEqual(result['totalPages'],3)
        self.assertEqual(result['indexedPages'],2)
        self.assertTrue(result['truncated'])
        self.assertEqual(result['status'],'partial')
        self.assertIn('1200mm',result['text'])
        self.assertNotIn('THIRD PAGE',result['text'])
        self.assertEqual(result['pages'][1]['page'],2)
        self.assertEqual(result['pages'][0]['source'],'text')
        self.assertIn('500mm',result['pages'][0]['dimensions'])
    def test_dimensions_not_arbitrary_numbers(self):
        self.assertEqual(module.dimensions('Invoice 2026 number 70000'),[])
        self.assertIn('Φ20',module.dimensions('孔径 Φ20；R50；500毫米；20×30'))
        self.assertIn('R50',module.dimensions('R50'))
    @unittest.skipUnless(os.name=='nt','Windows 本地 OCR 验收')
    def test_real_windows_ocr_scan_readonly(self):
        source=self.root/'扫描 图纸 中文.pdf'
        make_scan_pdf(source)
        result=self.invoke(source,ocrEnabled=True)
        self.assertGreater(result['ocrPages'],0,result)
        self.assertEqual(result['pages'][0]['source'],'ocr')
        self.assertIn('500',result['text'])
        self.assertIn('钢架',result['text'])
    def test_ocr_off_does_not_claim_scan_extracted(self):
        source=self.root/'扫描件.pdf'
        make_scan_pdf(source)
        result=self.invoke(source,ocrEnabled=False)
        self.assertEqual(result['ocrPages'],0)
        self.assertEqual(result['status'],'no_text')
        self.assertTrue(result['pages'][0]['needsOcr'])
    def test_ocr_page_payload_respects_total_text_budget(self):
        source=self.root/'OCR预算.pdf';make_text_pdf(source,[''])
        before=hashlib.sha256(source.read_bytes()).hexdigest()
        with patch.object(module,'MAX_CHARS',100),patch.object(module,'run_ocr',return_value={'available':True,'pages':[{'page':1,'text':'A'*200}]}):
            result=module.index_pdf(source.resolve(),{'ocrEnabled':True,'cacheDir':str(self.root/'cache')})
        self.assertLessEqual(sum(len(page['text']) for page in result['pages']),100)
        self.assertLessEqual(len(result['text']),100)
        self.assertTrue(result['truncated'])
        self.assertEqual(result['status'],'partial')
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),before)
        self.assertFalse(list((self.root/'cache').iterdir()))
    def test_corrupt_pdf_explicit_failure(self):
        source=self.root/'坏文件.pdf';source.write_bytes(b'not a pdf')
        result=self.invoke(source,ocrEnabled=False)
        self.assertEqual(result['status'],'error')
        self.assertTrue(result['error'])
    def test_blank_page_remains_no_text(self):
        source=self.root/'空白.pdf';make_text_pdf(source,[''])
        result=self.invoke(source,ocrEnabled=False)
        self.assertEqual(result['status'],'no_text')
        self.assertEqual(result['text'],'')


if __name__=='__main__':unittest.main(verbosity=2)
