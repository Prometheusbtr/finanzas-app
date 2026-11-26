// pdf.js document -> positioned text items, per page: [{ items: [{ s, x, y, w, h }] }]. The only part of the
// readers that touches pdf.js. Rotated text (margin notes) is left out; it never holds statement rows.
export const MAX_PAGES = 50;

export async function pdfItems(doc, { maxPages = MAX_PAGES } = {}) {
  if (doc.numPages > maxPages) {
    const e = new Error("too_many_pages");
    e.code = "too_many_pages";
    throw e;
  }
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = [];
    for (const it of tc.items) {
      if (typeof it.str !== "string" || !it.str.trim()) continue;
      const [a, b, c, d, x, y] = it.transform;
      if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0 || d <= 0) continue;
      items.push({ s: it.str, x, y, w: it.width, h: it.height || Math.abs(d) });
    }
    pages.push({ items });
    page.cleanup();
  }
  return pages;
}
