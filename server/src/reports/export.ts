import type { Lang } from './common.js'
import type { Cell, Column, ReportTable } from './types.js'
import { zip } from './zip.js'

/**
 * SAMS 7.3: one report table out as CSV, Excel (.xlsx) or a print page
 * (the browser saves it as PDF, with Arabic shaped correctly — which a
 * hand-written PDF could not promise). Every format shows the same rows
 * and the same totals; money is written in major units with two decimals.
 */

export interface ExportDoc {
  title: string
  /** "Branch: Main", "From: 2026-09-01"… shown above the table. */
  meta: { label: string; value: string }[]
  schoolName: string
  generatedAt: Date
  lang: Lang
  table: ReportTable
  truncated: boolean
}

const TEXT = {
  generated: { en: 'Generated', ar: 'تاريخ الإنشاء' },
  rows: { en: 'Rows', ar: 'عدد الصفوف' },
  truncated: {
    en: 'Only the first rows are included; narrow the filters to see the rest.',
    ar: 'تم تضمين الصفوف الأولى فقط؛ ضيّق عوامل التصفية لرؤية الباقي.',
  },
  empty: { en: 'Nothing matches these filters.', ar: 'لا توجد نتائج مطابقة.' },
}

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** 123456 → "1,234.56". */
export function formatMoney(minor: number): string {
  const abs = Math.abs(Math.round(minor))
  return `${minor < 0 ? '-' : ''}${group(String(Math.floor(abs / 100)))}.${String(abs % 100).padStart(2, '0')}`
}

export function formatCell(value: Cell, type: Column['type']): string {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'number') {
    if (type === 'money') return formatMoney(value)
    if (type === 'percent') return `${(value * 100).toFixed(1)}%`
    return String(value)
  }
  return value
}

const fileSafe = (s: string) =>
  s
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, '-')
    .toLowerCase()

export const exportFileName = (key: string, from: string | null, to: string | null, ext: string) =>
  `${fileSafe(key.replace('.', '-'))}${from ? `_${from}` : ''}${to && to !== from ? `_${to}` : ''}.${ext}`

// ------------------------------------------------------------------ CSV --

/** Excel opens UTF-8 CSV correctly only when it starts with a BOM. */
const BOM = '﻿'

function csvCell(text: string): string {
  // A leading =, +, - or @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(text) && !/^-?\d[\d,.]*%?$/.test(text) ? `'${text}` : text
  return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function toCsv(doc: ExportDoc): Buffer {
  const { columns, rows, totals } = doc.table
  const plain = (value: Cell, type: Column['type']) =>
    // CSV money stays machine-readable: no thousands separator.
    typeof value === 'number' && type === 'money' ? (value / 100).toFixed(2) : formatCell(value, type)
  const lines = [columns.map((c) => csvCell(c.label[doc.lang])).join(',')]
  for (const row of [...rows, ...(totals ? [totals] : [])]) {
    lines.push(columns.map((c) => csvCell(plain(row[c.key] ?? null, c.type))).join(','))
  }
  return Buffer.from(BOM + lines.join('\r\n') + '\r\n', 'utf8')
}

// ----------------------------------------------------------------- XLSX --

const xml = (s: string) =>
  s
    // Characters XML 1.0 cannot carry at all.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const colName = (i: number): string => (i < 26 ? String.fromCharCode(65 + i) : colName(Math.floor(i / 26) - 1) + colName(i % 26))

/** Style indexes in styles.xml below. */
const S = { plain: 0, header: 1, money: 2, percent: 3, totalMoney: 4, totalPercent: 5, title: 6, total: 7, meta: 8 }

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts>
<fonts count="4"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font><font><sz val="10"/><color rgb="FF666666"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEF1F6"/></patternFill></fill></fills>
<borders count="2"><border/><border><top style="thin"><color rgb="FF999999"/></top></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="165" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`

function xlsxCell(ref: string, value: Cell, type: Column['type'], total: boolean): string {
  if (value === null || value === undefined || value === '') return total ? `<c r="${ref}" s="${S.total}"/>` : ''
  if (typeof value === 'number') {
    const v = type === 'money' ? value / 100 : value
    const s =
      type === 'money' ? (total ? S.totalMoney : S.money) : type === 'percent' ? (total ? S.totalPercent : S.percent) : total ? S.total : S.plain
    return `<c r="${ref}" s="${s}"><v>${Number.isFinite(v) ? v : 0}</v></c>`
  }
  return `<c r="${ref}" t="inlineStr" s="${total ? S.total : S.plain}"><is><t xml:space="preserve">${xml(value)}</t></is></c>`
}

const inline = (ref: string, text: string, style: number) =>
  `<c r="${ref}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xml(text)}</t></is></c>`

export function toXlsx(doc: ExportDoc): Buffer {
  const { columns, rows, totals } = doc.table
  const HEADER_ROW = 4
  const sheetRows: string[] = [
    `<row r="1">${inline('A1', doc.title, S.title)}</row>`,
    `<row r="2">${inline('A2', [doc.schoolName, ...doc.meta.map((m) => `${m.label}: ${m.value}`)].filter(Boolean).join(' · '), S.meta)}</row>`,
    `<row r="${HEADER_ROW}">${columns.map((c, i) => inline(`${colName(i)}${HEADER_ROW}`, c.label[doc.lang], S.header)).join('')}</row>`,
  ]
  rows.forEach((row, n) => {
    const r = HEADER_ROW + 1 + n
    sheetRows.push(`<row r="${r}">${columns.map((c, i) => xlsxCell(`${colName(i)}${r}`, row[c.key] ?? null, c.type, false)).join('')}</row>`)
  })
  const lastData = HEADER_ROW + rows.length
  if (totals) {
    const r = lastData + 1
    sheetRows.push(`<row r="${r}">${columns.map((c, i) => xlsxCell(`${colName(i)}${r}`, totals[c.key] ?? null, c.type, true)).join('')}</row>`)
  }
  const widths = columns.map((c) => {
    const longest = Math.max(
      c.label[doc.lang].length,
      ...rows.slice(0, 500).map((r) => formatCell(r[c.key] ?? null, c.type).length),
    )
    return Math.min(50, Math.max(10, longest + 2))
  })
  const lastCol = colName(Math.max(0, columns.length - 1))
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"${doc.lang === 'ar' ? ' rightToLeft="1"' : ''}><pane ySplit="${HEADER_ROW}" topLeftCell="A${HEADER_ROW + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>
<sheetData>${sheetRows.join('')}</sheetData>
${rows.length > 0 ? `<autoFilter ref="A${HEADER_ROW}:${lastCol}${lastData}"/>` : ''}
</worksheet>`
  const sheetName = xml(doc.title.replace(/[\\/:*?[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31).trim() || 'Report')
  return zip([
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets>
${rows.length > 0 ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${sheetName.replace(/'/g, "''")}'!$A$${HEADER_ROW}:$${lastCol}$${lastData}</definedName></definedNames>` : ''}
</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
    { name: 'xl/styles.xml', data: STYLES },
  ])
}

// ---------------------------------------------------------- print / PDF --

const html = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** A self-contained page laid out for A4; it opens the print dialog when
 * `autoPrint`, where "Save as PDF" gives the PDF. */
export function toPrintHtml(doc: ExportDoc, autoPrint: boolean): string {
  const { columns, rows, totals } = doc.table
  const dir = doc.lang === 'ar' ? 'rtl' : 'ltr'
  const numeric = (c: Column) => c.type !== 'text' && c.type !== 'date'
  const cell = (c: Column, v: Cell, tag: 'td' | 'th' = 'td') =>
    `<${tag}${numeric(c) ? ' class="n"' : ''}>${html(formatCell(v ?? null, c.type))}</${tag}>`
  const generated = doc.generatedAt.toISOString().slice(0, 16).replace('T', ' ')
  return `<!doctype html>
<html lang="${doc.lang}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${html(doc.title)}</title>
<style>
  @page { size: A4 ${columns.length > 7 ? 'landscape' : 'portrait'}; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font: 11px/1.4 "Segoe UI", "Noto Sans", "Noto Naskh Arabic", Tahoma, Arial, sans-serif; color: #111; margin: 16px; background: #fff; }
  header { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; border-bottom: 2px solid #111; padding-bottom: 6px; margin-bottom: 8px; }
  h1 { font-size: 17px; margin: 0; }
  .school { font-weight: 600; }
  .meta { color: #444; margin: 0 0 10px; display: flex; flex-wrap: wrap; gap: 4px 16px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid #ddd; padding: 3px 6px; text-align: start; vertical-align: top; }
  thead th { background: #eef1f6; border-bottom: 1px solid #999; font-weight: 600; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  tfoot td { font-weight: 700; border-top: 2px solid #111; border-bottom: none; }
  .n { text-align: end; font-variant-numeric: tabular-nums; white-space: nowrap; }
  td { unicode-bidi: plaintext; }
  .note { color: #a15c00; margin-top: 8px; }
  .empty { color: #666; padding: 24px 0; }
  footer { color: #666; margin-top: 10px; font-size: 10px; }
  @media screen { body { max-width: 1200px; margin: 24px auto; padding: 0 16px; } }
</style>
</head>
<body>
<header><h1>${html(doc.title)}</h1><span class="school">${html(doc.schoolName)}</span></header>
<p class="meta">${doc.meta.map((m) => `<span><b>${html(m.label)}:</b> ${html(m.value)}</span>`).join('')}</p>
${
  rows.length === 0
    ? `<p class="empty">${TEXT.empty[doc.lang]}</p>`
    : `<table>
<thead><tr>${columns.map((c) => cell(c, c.label[doc.lang], 'th')).join('')}</tr></thead>
<tbody>
${rows.map((r) => `<tr>${columns.map((c) => cell(c, r[c.key] ?? null)).join('')}</tr>`).join('\n')}
</tbody>
${totals ? `<tfoot><tr>${columns.map((c) => cell(c, totals[c.key] ?? null)).join('')}</tr></tfoot>` : ''}
</table>`
}
${doc.truncated ? `<p class="note">${TEXT.truncated[doc.lang]}</p>` : ''}
<footer>${TEXT.generated[doc.lang]}: ${generated} UTC · ${TEXT.rows[doc.lang]}: ${rows.length}</footer>
${autoPrint ? '<script>window.addEventListener("load", function () { setTimeout(function () { window.print() }, 150) })</script>' : ''}
</body>
</html>`
}

export const MIME = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  html: 'text/html; charset=utf-8',
} as const
