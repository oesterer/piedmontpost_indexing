import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('alternative_pdf_parser', ROOT / 'scripts/index-pdfs.py')
parser = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = parser
spec.loader.exec_module(parser)
HAS_PDFPLUMBER = importlib.util.find_spec('pdfplumber') is not None


def line(i, text, x, y, width, size):
    return parser.PDFLine(i, text, parser.Box(x, y, width, size), size)


class GeometryTests(unittest.TestCase):
    def test_title_subtitle_and_body_stay_together(self):
        body = 'Viviane Oesterer leads the Highlanders. ' * 8
        lines = [line(0, 'Athletes of the Week:', 475.5, 1061, 195.8, 25.8),
                 line(1, 'Viviane Oesterer, Vaha Mafi', 475.5, 1033.5, 257.5, 25.8),
                 line(2, 'Honorable Mention:', 475.5, 1014.3, 124.9, 18),
                 line(3, 'Ella Ruthven, Henry Stein', 475.5, 992.3, 158.9, 18),
                 line(4, body, 475.5, 720, 135, 10)]
        articles = parser.detected_articles(lines, parser.Box(0, 0, 792, 1224))
        self.assertEqual(len(articles), 1)
        self.assertEqual(articles[0]['title'], 'Athletes of the Week: Viviane Oesterer, Vaha Mafi')
        self.assertIn('Honorable Mention: Ella Ruthven, Henry Stein', articles[0]['text'])
        self.assertEqual(articles[0]['source'], 'detected')

    def test_independent_headings_do_not_become_subtitles(self):
        body = 'Community newspaper content. ' * 10
        lines = [line(0, 'First independent headline', 35, 900, 250, 26),
                 line(1, body, 35, 880, 135, 10),
                 line(2, 'Second independent headline', 35, 850, 250, 18),
                 line(3, body, 35, 820, 135, 10)]
        articles = parser.detected_articles(lines, parser.Box(0, 0, 792, 1224))
        self.assertEqual(len(articles), 2)

    def test_service_and_staff_boundaries_do_not_become_article_titles(self):
        body = 'The council discussed local community news. ' * 8
        lines = [line(0, 'A community news story', 45.5, 900, 260, 24),
                 line(1, body, 45.5, 875, 260, 10),
                 line(2, 'Missed Piedmont Post Delivery?', 61.1, 526.1, 228.8, 19.35),
                 line(3, 'Contact the newspaper for delivery assistance. ' * 4, 72.5, 500, 206, 10),
                 line(4, 'Publisher & Editor: Gray Cathrall', 110.4, 356.4, 130.3, 10.8),
                 line(5, 'Executive Editor: Misha Edel', 119.2, 343.4, 112.6, 10.8),
                 line(6, 'City Editor: Jay Russell', 131.4, 330.4, 88.1, 10.8),
                 line(7, 'REPORTERS', 48, 274.5, 46.2, 7.8),
                 line(8, 'Jake Lannon and other contributors', 48, 265.5, 135, 7.8)]
        for sample in [lines, lines[:2] + lines[4:]]:
            articles = parser.detected_articles(sample, parser.Box(0, 0, 792, 1224))
            self.assertEqual([a['title'] for a in articles], ['A community news story'])
            self.assertNotIn('Misha Edel', articles[0]['text'])
            self.assertNotIn('delivery assistance', articles[0]['text'])

    def test_cleanup_and_dates(self):
        self.assertEqual(parser.clean_text('  High-\nlanders\t\n Café  '), 'Highlanders Café')
        self.assertEqual(parser.clean_text('A\ud800B'), 'A?B')
        self.assertEqual(parser.issue_date('-', 'Wednesday, October 21, 2026'), '2026-10-21')
        self.assertEqual(parser.issue_date('-', 'October 21 2026'), '2026-10-21')
        self.assertEqual(parser.issue_date('2024-02-29', ''), '2024-02-29')
        for hint, text in [('2026-02-30', ''), ('2026-2-3', ''), ('-', 'No issue date')]:
            with self.assertRaises(ValueError):
                parser.issue_date(hint, text)

    def test_word_lines_keep_columns_separate_and_convert_coordinates(self):
        class Page:
            width, height, bbox = 792, 1224, (0, 0, 792, 1224)
            def dedupe_chars(self, **kwargs):
                return self
            def extract_words(self, **kwargs):
                return [dict(text=text, x0=x, x1=x + width, top=100, bottom=110, size=10,
                             chars=[{'size': 10}])
                        for text, x, width in [('Left', 35, 20), ('column', 58, 30), ('Right', 475, 25)]]
        lines = parser.lines_from_page(Page())
        self.assertEqual([l.text for l in lines], ['Left column', 'Right'])
        self.assertEqual(lines[0].box.y, 1114)
        self.assertEqual(lines[0].size, 10)

    def test_atomic_output_is_valid_json_and_failed_serialization_preserves_old_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'issue.json'
            parser.atomic_json(output, {'text': 'Café'})
            self.assertEqual(json.loads(output.read_text())['text'], 'Café')
            with self.assertRaises(TypeError):
                parser.atomic_json(output, {'invalid': object()})
            self.assertEqual(json.loads(output.read_text()), {'text': 'Café'})
            self.assertEqual(len(list(Path(temporary).iterdir())), 1)

    def test_issue_schema_and_blank_pages_with_pdf_io_adapter(self):
        class Page:
            width, height = 792, 1224
            def __init__(self, text):
                self.text, self.closed = text, False
            def extract_text(self):
                return 'October 21, 2026'
            def close(self):
                self.closed = True
        pages = [Page('Misha Edel in the staff listing'), Page('')]
        class PDF:
            def __enter__(self):
                self.pages = pages
                return self
            def __exit__(self, *args):
                return False
        module = types.SimpleNamespace(open=lambda path: PDF())
        with patch.dict(sys.modules, {'pdfplumber': module}), patch.object(parser, 'lines_from_page',
                side_effect=lambda page: [line(0, page.text, 35, 700, 135, 10)] if page.text else []):
            result = parser.extract_issue('fixture.pdf', 'https://example.org/issue.pdf', '-')
        self.assertEqual(result['issue']['pages'], 2)
        self.assertEqual(result['issue']['date'], '2026-10-21')
        self.assertEqual([p['page'] for p in result['pages']], [1, 2])
        self.assertEqual(result['pages'][1]['text'], '')
        self.assertNotIn('articles', result['pages'][0])
        self.assertTrue(all(p.closed for p in pages))


def minimal_pdf(text):
    # Valid one-page PDF, including byte offsets. No PDF creation dependency.
    content = ('BT /F1 10 Tf 35 700 Td (' + text + ') Tj ET').encode('ascii') if text else b'q Q'
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
               b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 1224] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
               b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
               b'<< /Length ' + str(len(content)).encode() + b' >>\nstream\n' + content + b'\nendstream']
    data, offsets = bytearray(b'%PDF-1.4\n'), [0]
    for i, obj in enumerate(objects, 1):
        offsets.append(len(data)); data.extend(str(i).encode() + b' 0 obj\n' + obj + b'\nendobj\n')
    xref = len(data)
    data.extend(b'xref\n0 6\n0000000000 65535 f \n')
    for offset in offsets[1:]:
        data.extend(('{:010d} 00000 n \n'.format(offset)).encode())
    data.extend(('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n'.format(xref)).encode())
    return data


@unittest.skipUnless(HAS_PDFPLUMBER, 'Install requirements-python.txt to run real PDF integration tests')
class PDFIntegrationTests(unittest.TestCase):
    def test_real_pdf_text_and_date(self):
        with tempfile.TemporaryDirectory() as temporary:
            pdf = Path(temporary) / 'sample.pdf'
            pdf.write_bytes(minimal_pdf('October 21, 2026 Misha Edel'))
            result = parser.extract_issue(pdf, 'https://example.org/issue.pdf', '-')
            self.assertEqual(result['issue']['pages'], 1)
            self.assertIn('Misha Edel', result['pages'][0]['text'])
            self.assertEqual(result['issue']['date'], '2026-10-21')

    def test_image_or_blank_pdf_needs_ocr(self):
        with tempfile.TemporaryDirectory() as temporary:
            pdf = Path(temporary) / 'blank.pdf'; pdf.write_bytes(minimal_pdf(''))
            with self.assertRaisesRegex(ValueError, 'OCR is required'):
                parser.extract_issue(pdf, 'https://example.org/issue.pdf', '2026-10-21')

    @unittest.skipUnless((ROOT / '10-21-26 Post v2 - Web.pdf').exists(), 'Optional local newspaper sample is not in Git')
    def test_october_21_contributor_page(self):
        result = parser.extract_issue(ROOT / '10-21-26 Post v2 - Web.pdf', 'https://example.org/issue.pdf', '2026-10-21')
        self.assertEqual(result['issue']['pages'], 28)
        page = result['pages'][1]
        self.assertIn('Misha Edel', page['text'])
        self.assertFalse(any('Misha Edel' in a['text'] for a in page.get('articles', [])))
        self.assertTrue(any('Math detracking' in a['title'] for a in page.get('articles', [])))


if __name__ == '__main__':
    unittest.main(verbosity=2)
