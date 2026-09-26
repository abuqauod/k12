/**
 * A small RFC 4180 CSV reader for imports: quoted fields with commas,
 * doubled quotes and line breaks, CRLF or LF, a UTF-8 BOM, and comma or
 * semicolon separators (Excel in Arabic/European locales saves with ";").
 */

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '')
  const firstLine = src.split(/\r?\n/, 1)[0] ?? ''
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ','
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
      continue
    }
    if (c === '"' && field === '') quoted = true
    else if (c === sep) {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  // Blank lines (a trailing newline, spacer rows) carry nothing.
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/** Header text to a canonical key: lower case, no spaces, dashes or underscores. */
export const headerKey = (h: string) => h.trim().toLowerCase().replace(/[\s_\-./]+/g, '')

/** A cell as a CSV field (for templates and error files). */
export const csvField = (v: string) => (/[",\n\r;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
