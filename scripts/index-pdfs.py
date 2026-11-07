#!/usr/bin/env python3
"""Alternative PDF extractor. Same issue/page JSON contract as index-pdfs.swift.

Only PDF I/O needs pdfplumber. The geometry/heading functions use the standard
library so they can be regression-tested independently on any Python platform.
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from dataclasses import dataclass
from datetime import date
from functools import cmp_to_key


@dataclass(frozen=True)
class Box:
    x: float
    y: float
    width: float
    height: float

    @property
    def right(self):
        return self.x + self.width

    @property
    def top(self):
        return self.y + self.height

    @property
    def mid_x(self):
        return self.x + self.width / 2

    @property
    def mid_y(self):
        return self.y + self.height / 2


def union_boxes(boxes):
    boxes = list(boxes)
    left, bottom = min(b.x for b in boxes), min(b.y for b in boxes)
    return Box(left, bottom, max(b.right for b in boxes) - left,
               max(b.top for b in boxes) - bottom)


@dataclass(frozen=True)
class PDFLine:
    id: int
    text: str
    box: Box
    size: float


def clean_text(value):
    value = value.encode('utf-8', errors='replace').decode('utf-8')
    value = re.sub(r'(\w)[-\u00ad]\s*\n\s*(\w)',
                   lambda m: m[1] + m[2] if m[1].isalpha() and m[2].isalpha() else m[0], value)
    return re.sub(r'\s+', ' ', value).strip()


NON_ARTICLE_LABELS = {
    'contributors', 'contributing writers', 'newspaper staff', 'publishing information',
    'masthead', 'production', 'production manager', 'reporters', 'photographers',
    'columnists', 'student writers', 'read it in', 'read it in the post', 'the post',
}
NON_ARTICLE_PATTERNS = [re.compile(p) for p in [
    r'^missed\b.*\bdelivery\??$',
    r'^piedmont post (?:news rack|at your door)\b',
    r'^how to (?:get|submit) news (?:in|to) (?:the )?post\b',
    r'^(?:publisher(?:\s*(?:&|and)\s*editor)?|executive editor|city editor|managing editor|editor[- ]in[- ]chief|contributors?|contributing editors?)\s*:',
]]
EXCLUDED = {
    'piedmont post', 'opinion', 'sports', 'local items', 'schools', 'features',
    'arts & entertainment', 'real estate', 'inside', 'our city', 'our news',
    'our paper', 'our post', 'read it in the post', 'advertise in the post',
    'letters - main', 'letters - cont', 'classifieds',
}


def is_non_article_heading(text):
    lower = clean_text(text).lower()
    return lower in NON_ARTICLE_LABELS or any(p.search(lower) for p in NON_ARTICLE_PATTERNS)


def text_of(lines):
    return ' '.join(line.text for line in lines)


def detected_articles(lines, bounds):
    """Port of the Swift layout heuristics; coordinates use bottom-left origin."""
    sizes = sorted(line.size for line in lines if len(line.text) > 18 and 0 < line.size < 16)
    body_size = sizes[len(sizes) // 2] if sizes else 10

    def candidate(line):
        lower = line.text.lower()
        return ((line.size >= max(15, body_size * 1.65) or is_non_article_heading(line.text))
                and line.size < body_size * 4.5 and line.box.y > bounds.height * .035
                and line.box.top < bounds.height * .965 and line.box.x >= 0
                and len(line.text) >= 5 and any(c.isalpha() for c in line.text)
                and lower not in EXCLUDED and 'all city edition' not in lower
                and 'advertise' not in lower and 'piedmont post piedmont post' not in lower
                and not lower.startswith('by ') and 'www.' not in lower and 'http' not in lower)

    def position(a, b):
        if abs(a.box.mid_y - b.box.mid_y) > 3:
            return -1 if a.box.mid_y > b.box.mid_y else 1
        return (a.box.x > b.box.x) - (a.box.x < b.box.x)

    groups = []
    for line in sorted(filter(candidate, lines), key=cmp_to_key(position)):
        if any(other.text == line.text and abs(other.box.mid_y - line.box.mid_y) < 3
               and abs(other.box.x - line.box.x) < 3 for group in groups for other in group):
            continue
        for group in reversed(groups):
            last = group[-1]
            overlap = min(last.box.right, line.box.right) - max(last.box.x, line.box.x)
            distance = last.box.mid_y - line.box.mid_y
            if (abs(last.size - line.size) < 2 and last.size * .6 < distance < last.size * 1.7
                    and overlap > min(last.box.width, line.box.width) * .35):
                group.append(line)
                break
        else:
            groups.append([line])

    blocks = []
    for group in groups:
        box = union_boxes(line.box for line in group)
        size = max(line.size for line in group)
        for block in reversed(blocks):
            if is_non_article_heading(text_of(group)) != is_non_article_heading(text_of(block['title'])):
                continue
            parent_box = union_boxes(line.box for line in block['title'] + block['deck'])
            parent_size = max(line.size for line in block['title'])
            gap = parent_box.y - box.top
            overlap = min(parent_box.right, box.right) - max(parent_box.x, box.x)
            aligned = abs(parent_box.x - box.x) < 12 or abs(parent_box.mid_x - box.mid_x) < 12
            intervening = any(line.size <= body_size * 1.4 and box.top < line.box.mid_y < parent_box.y
                              and box.x <= line.box.mid_x <= box.right for line in lines)
            if (size <= parent_size * .85 and -2 <= gap < parent_size * 1.5
                    and aligned and overlap > min(parent_box.width, box.width) * .6 and not intervening):
                block['deck'].extend(group)
                break
        else:
            blocks.append({'title': group, 'deck': []})

    body = [line for line in lines if line.size <= body_size * 1.35 and len(line.text) > 12
            and bounds.width * .10 < line.box.width < bounds.width * .45]
    columns = []
    for x in sorted(line.box.x for line in body):
        if not columns or x - columns[-1] >= bounds.width * .05:
            columns.append(x)
    columns = columns or [bounds.x]
    headings = []
    for block in blocks:
        box = union_boxes(line.box for line in block['title'] + block['deck'])
        title = text_of(block['title'])
        if len(title) < 8:
            continue
        left = next((x for x in reversed(columns) if x <= box.x + 3), box.x)
        right = next((x - 5 for x in columns if x > box.right - 3), bounds.right)
        headings.append({'title': title, 'box': box, 'left': left, 'right': right,
                         'subtitle': text_of(block['deck']), 'article': not is_non_article_heading(title),
                         'body': []})
    heading_ids = {line.id for block in blocks for line in block['title'] + block['deck']}
    for line in lines:
        if (line.size > body_size * 1.4 or line.id in heading_ids
                or line.text.startswith(('Continued from', 'See ', 'By '))):
            continue
        eligible = [h for h in headings if h['left'] <= line.box.mid_x < h['right']
                    and line.box.mid_y < h['box'].y + 2]
        if eligible:
            min(eligible, key=lambda h: h['box'].y - line.box.mid_y)['body'].append(line)
    articles = []
    for h in headings:
        if not h['article']:
            continue
        text = clean_text('\n'.join([h['subtitle']] + [line.text for line in sorted(h['body'], key=lambda line: line.id)]))
        if len(text) >= 100:
            articles.append({'title': h['title'], 'text': text, 'source': 'detected'})
    return articles


def lines_from_page(page):
    """Build column-aware lines from PDF content-flow words, retaining font sizes.

    PDF engines have different reading orders/metrics. Large horizontal gaps
    split runs so adjacent newspaper columns do not become a single body line.
    """
    words = page.dedupe_chars(tolerance=1).extract_words(
        use_text_flow=True, extra_attrs=['size'], return_chars=True, expand_ligatures=True)
    groups = []
    for word in words:
        box = Box(float(word['x0']) - page.bbox[0], page.height - (float(word['bottom']) - page.bbox[1]),
                  float(word['x1']) - float(word['x0']), float(word['bottom']) - float(word['top']))
        size = max((float(c['size']) for c in word.get('chars', [])), default=float(word.get('size', box.height)))
        if groups:
            previous = groups[-1][-1]
            gap = box.x - previous['box'].right
            if (abs(box.mid_y - previous['box'].mid_y) <= max(2, min(size, previous['size']) * .2)
                    and -1 <= gap <= max(12, min(size, previous['size']) * 1.5)):
                groups[-1].append({'text': word['text'], 'box': box, 'size': size})
                continue
        groups.append([{'text': word['text'], 'box': box, 'size': size}])
    return [PDFLine(i, clean_text(' '.join(w['text'] for w in group)),
                    union_boxes(w['box'] for w in group), max(w['size'] for w in group))
            for i, group in enumerate(groups) if clean_text(' '.join(w['text'] for w in group))]


MONTHS = {name.lower(): i for i, name in enumerate([
    'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'], 1)}


def issue_date(hint, cover_text):
    if hint != '-':
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', hint):
            raise ValueError('Date hint must be YYYY-MM-DD or -')
        return date.fromisoformat(hint).isoformat()
    match = re.search(r'(' + '|'.join(MONTHS) + r')\s+(\d{1,2}),?\s+((?:19|20)\d{2})', cover_text, re.I)
    if match:
        return date(int(match[3]), MONTHS[match[1].lower()], int(match[2])).isoformat()
    raise ValueError('Cannot determine issue date; add a date to the PDF link manifest')


def extract_issue(input_path, source_url, hint):
    try:
        import pdfplumber
    except ImportError as error:
        raise RuntimeError('Python parser requires pdfplumber. Install with: python -m pip install -r requirements-python.txt') from error
    pages = []
    with pdfplumber.open(input_path) as pdf:
        if not pdf.pages:
            raise ValueError('PDF is empty')
        date_value = issue_date(hint, pdf.pages[0].extract_text() or '')
        for number, page in enumerate(pdf.pages, 1):
            try:
                lines = lines_from_page(page)
                text = clean_text('\n'.join(line.text for line in lines))
                record = {'date': date_value, 'file': source_url, 'sourceUrl': source_url,
                          'page': number, 'text': text}
                articles = detected_articles(lines, Box(0, 0, page.width, page.height))
                if articles:
                    record['articles'] = articles
                pages.append(record)
            finally:
                page.close()
    if not any(page['text'] for page in pages):
        raise ValueError('PDF has no extractable text; OCR is required')
    return {'issue': {'date': date_value, 'file': source_url, 'sourceUrl': source_url, 'pages': len(pages)}, 'pages': pages}


def atomic_json(output_path, value):
    output = Path(output_path)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=output.parent, prefix=output.name + '.', delete=False) as file:
            temporary = file.name
            json.dump(value, file, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
            file.write('\n')
        os.replace(temporary, output)
        temporary = None
    finally:
        if temporary is not None:
            os.unlink(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--extract-one', action='store_true', required=True)
    parser.add_argument('input')
    parser.add_argument('output')
    parser.add_argument('source_url')
    parser.add_argument('date_hint')
    args = parser.parse_args()
    try:
        result = extract_issue(args.input, args.source_url, args.date_hint)
        atomic_json(args.output, result)
        print('Extracted {} pages'.format(len(result['pages'])))
        return 0
    except Exception as error:
        print('Extraction failed: {}'.format(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
