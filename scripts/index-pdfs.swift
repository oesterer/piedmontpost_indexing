import Foundation
import PDFKit
import AppKit
struct PDFLine {
 let id: Int
 let text: String
 let box: CGRect
 let size: CGFloat
}
func cleanText(_ value: String) -> String {
 // PDFKit can return NSStrings containing malformed UTF-16. Materialize a
 // native, repaired UTF-8 string before regex processing or JSON serialization.
 let repaired = String(decoding: Array(value.utf8), as: UTF8.self)
 return repaired.replacingOccurrences(of: "([\\p{L}])[-\u{00AD}]\\s*\\n\\s*([\\p{L}])", with: "$1$2", options: .regularExpression).replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression).trimmingCharacters(in: .whitespacesAndNewlines)
}
func detectedArticles(_ page: PDFPage) -> [[String: Any]] {
 let bounds = page.bounds(for: .mediaBox)
 guard let selection = page.selection(for: bounds) else { return [] }
 let lines: [PDFLine] = selection.selectionsByLine().enumerated().compactMap { id, selection in
  let text = cleanText(selection.string ?? "")
  if text.isEmpty { return nil }
  var size: CGFloat = 0
  if let attributed = selection.attributedString {
   attributed.enumerateAttribute(NSAttributedString.Key("NSFont"), in: NSRange(location: 0, length: attributed.length)) { value, _, _ in
    if let font = value as? NSFont { size = max(size, font.pointSize) }
   }
  }
  return PDFLine(id: id, text: text, box: selection.bounds(for: page), size: size)
 }
 return detectedArticles(lines: lines, bounds: bounds)
}
func detectedArticles(lines: [PDFLine], bounds: CGRect) -> [[String: Any]] {
 let sizes = lines.filter { $0.text.count > 18 && $0.size > 0 && $0.size < 16 }.map { $0.size }.sorted()
 let bodySize: CGFloat = sizes.isEmpty ? 10 : sizes[sizes.count/2]
 let excluded: Set<String> = ["piedmont post", "opinion", "sports", "local items", "schools", "features", "arts & entertainment", "real estate", "inside", "our city", "our news", "our paper", "our post", "read it in the post", "advertise in the post", "letters - main", "letters - cont", "classifieds"]
 let candidates = lines.filter { line in
  let lower = line.text.lowercased()
  return line.size >= max(15, bodySize*1.65) && line.size < bodySize*4.5 && line.box.minY > bounds.height*0.035 && line.box.maxY < bounds.height*0.965 && line.box.minX >= 0 && line.text.count >= 5 && line.text.rangeOfCharacter(from: .letters) != nil && !excluded.contains(lower) && !lower.contains("all city edition") && !lower.contains("advertise") && !lower.contains("piedmont post piedmont post") && !lower.hasPrefix("by ") && !lower.contains("www.") && !lower.contains("http")
 }.sorted { a,b in abs(a.box.midY-b.box.midY) > 3 ? a.box.midY > b.box.midY : a.box.minX < b.box.minX }
 var groups: [[PDFLine]] = []
 for candidate in candidates {
  if groups.contains(where: { $0.contains(where: { $0.text == candidate.text && abs($0.box.midY-candidate.box.midY)<3 && abs($0.box.minX-candidate.box.minX)<3 }) }) { continue }
  if let index = groups.indices.last(where: { index in
   guard let last = groups[index].last else { return false }
   let overlap = min(last.box.maxX,candidate.box.maxX)-max(last.box.minX,candidate.box.minX)
   let distance = last.box.midY-candidate.box.midY
   return abs(last.size-candidate.size)<2 && distance>last.size*0.6 && distance<last.size*1.7 && overlap>min(last.box.width,candidate.box.width)*0.35
  }) { groups[index].append(candidate) } else { groups.append([candidate]) }
 }
 // Keep a smaller, adjacent deck with its main headline. Otherwise the
 // nearest-heading body assignment gives all article text to the subtitle.
 var blocks: [(title: [PDFLine], deck: [PDFLine])] = []
 for group in groups {
  let box = group.reduce(CGRect.null) { $0.union($1.box) }
  let size = group.map { $0.size }.max() ?? 0
  if let index = blocks.indices.last(where: { index in
   let parent = blocks[index]
   let parentBox = (parent.title + parent.deck).reduce(CGRect.null) { $0.union($1.box) }
   let parentSize = parent.title.map { $0.size }.max() ?? 0
   let gap = parentBox.minY - box.maxY
   let overlap = min(parentBox.maxX, box.maxX) - max(parentBox.minX, box.minX)
   let aligned = abs(parentBox.minX-box.minX)<12 || abs(parentBox.midX-box.midX)<12
   let interveningBody = lines.contains { line in
    line.size <= bodySize*1.4 && line.box.midY > box.maxY && line.box.midY < parentBox.minY && line.box.midX >= box.minX && line.box.midX <= box.maxX
   }
   return size <= parentSize*0.85 && gap >= -2 && gap < parentSize*1.5 && aligned && overlap > min(parentBox.width,box.width)*0.6 && !interveningBody
  }) { blocks[index].deck.append(contentsOf: group) }
  else { blocks.append((title: group, deck: [])) }
 }
 // Infer text-column margins from repeated positions of ordinary body lines.
 let body = lines.filter { $0.size <= bodySize*1.35 && $0.text.count>12 && $0.box.width>bounds.width*0.10 && $0.box.width<bounds.width*0.45 }
 var columns: [CGFloat] = []
 for x in body.map({ $0.box.minX }).sorted() {
  if let last = columns.last, x-last < bounds.width*0.05 { continue }
  columns.append(x)
 }
 if columns.isEmpty { columns = [bounds.minX] }
 struct Heading { let title: String; let box: CGRect; let left: CGFloat; let right: CGFloat; let subtitle: String }
 let headings: [Heading] = blocks.compactMap { block in
  let group = block.title
  let box = (group + block.deck).reduce(CGRect.null) { $0.union($1.box) }
  let title = group.map { $0.text }.joined(separator: " ")
  if title.count < 8 { return nil }
  let left = columns.last(where: { $0 <= box.minX+3 }) ?? box.minX
  let right = columns.first(where: { $0 > box.maxX-3 }).map { $0-5 } ?? bounds.maxX
  return Heading(title: title, box: box, left: left, right: right, subtitle: block.deck.map { $0.text }.joined(separator: " "))
 }
 var bodies = Array(repeating: [PDFLine](), count: headings.count)
 for line in lines where line.size <= bodySize*1.4 {
  if line.text.hasPrefix("Continued from") || line.text.hasPrefix("See ") || line.text.hasPrefix("By ") { continue }
  let eligible = headings.indices.filter { index in
   let h = headings[index]
   return line.box.midX>=h.left && line.box.midX<h.right && line.box.midY<h.box.minY+2
  }
  if let index = eligible.min(by: { headings[$0].box.minY-line.box.midY < headings[$1].box.minY-line.box.midY }) { bodies[index].append(line) }
 }
 return headings.indices.compactMap { index in
  let body = bodies[index].sorted { $0.id<$1.id }
  let text = cleanText(([headings[index].subtitle] + body.map { $0.text }).joined(separator: "\n"))
  // Short display slogans and most advertising blocks have little accompanying text.
  if text.count<100 { return nil }
  return ["title": headings[index].title, "text": text, "source": "detected"]
 }
}

// Single-issue mode for the incremental website indexer. No PDF copies or images.
if CommandLine.arguments.dropFirst().first == "--extract-one" {
 do {
  guard CommandLine.arguments.count == 6 else { throw NSError(domain: "Indexer", code: 1, userInfo: [NSLocalizedDescriptionKey: "Usage: --extract-one INPUT OUTPUT SOURCE_URL DATE_OR_DASH"]) }
  let args = CommandLine.arguments
  guard let pdf = PDFDocument(url: URL(fileURLWithPath: args[2])), pdf.pageCount > 0, !pdf.isLocked else { throw NSError(domain: "Indexer", code: 2, userInfo: [NSLocalizedDescriptionKey: "PDF is invalid, empty or encrypted"]) }
  var date = args[5] == "-" ? "" : args[5]
  if date.isEmpty {
   let text = pdf.page(at: 0)?.string ?? ""
   let pattern = "(?i)(January|February|March|April|May|June|July|August|September|October|November|December)\\s+(\\d{1,2}),?\\s+((?:19|20)\\d{2})"
   let regex = try NSRegularExpression(pattern: pattern)
   if let match = regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)), let range = Range(match.range, in: text) {
    let formatter = DateFormatter(); formatter.locale = Locale(identifier: "en_US_POSIX"); formatter.timeZone = TimeZone(secondsFromGMT: 0); formatter.dateFormat = "MMMM d, yyyy"
    let value = String(text[range]); let normalized = value.contains(",") ? value : value.replacingOccurrences(of: "(\\d) (\\d{4})$", with: "$1, $2", options: .regularExpression)
    if let parsed = formatter.date(from: normalized) { formatter.dateFormat = "yyyy-MM-dd"; date = formatter.string(from: parsed) }
   }
  }
  guard date.range(of: "^\\d{4}-\\d{2}-\\d{2}$", options: .regularExpression) != nil else { throw NSError(domain: "Indexer", code: 3, userInfo: [NSLocalizedDescriptionKey: "Cannot determine issue date; add a date to the PDF link manifest"]) }
  var records = [[String: Any]]()
  var textPages = 0
  for i in 0..<pdf.pageCount {
   guard let page = pdf.page(at: i) else { continue }
   let text = cleanText(page.string ?? "")
   if !text.isEmpty { textPages += 1 }
   var record: [String: Any] = ["date": date, "file": args[4], "sourceUrl": args[4], "page": i+1, "text": text]
   let articles = detectedArticles(page)
   if !articles.isEmpty { record["articles"] = articles }
   records.append(record)
  }
  guard textPages > 0 else { throw NSError(domain: "Indexer", code: 4, userInfo: [NSLocalizedDescriptionKey: "PDF has no extractable text; OCR is required"]) }
  let issue: [String: Any] = ["date": date, "file": args[4], "sourceUrl": args[4], "pages": pdf.pageCount]
  let data = try JSONSerialization.data(withJSONObject: ["issue": issue, "pages": records], options: [.sortedKeys])
  try data.write(to: URL(fileURLWithPath: args[3]), options: .atomic)
  print("Extracted \(records.count) pages")
  exit(0)
 } catch {
  fputs("Extraction failed: \(error.localizedDescription)\n", stderr)
  exit(1)
 }
}

fputs("Use --extract-one INPUT OUTPUT SOURCE_URL DATE_OR_DASH\n", stderr)
exit(1)
