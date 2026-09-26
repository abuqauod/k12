import type { AssessmentPlanDoc, GradeBand, GradingSettingsDoc, MarkDoc, TenantContext } from '../db.js'

/**
 * SAMS 11.2 — marks to results. A term result per subject is the weighted
 * average of the assessments that have a score (an absent/blank one leaves
 * the weights of the rest to carry it); a year result is the terms' results
 * weighted by the plan's term weights. Letters come from the school's scale.
 */

// The usual Jordanian bands: 50 passes ("acceptable"), below it fails.
export const DEFAULT_BANDS: GradeBand[] = [
  { min: 90, code: 'A', label: 'Excellent', labelAr: 'ممتاز' },
  { min: 80, code: 'B', label: 'Very good', labelAr: 'جيد جدًا' },
  { min: 70, code: 'C', label: 'Good', labelAr: 'جيد' },
  { min: 60, code: 'D', label: 'Fair', labelAr: 'متوسط' },
  { min: 50, code: 'E', label: 'Pass', labelAr: 'مقبول' },
  { min: 0, code: 'F', label: 'Fail', labelAr: 'راسب' },
]

export async function loadGrading(ctx: TenantContext, tenantId: string): Promise<GradingSettingsDoc> {
  return (
    (await ctx.gradingSettings.findOne({ _id: tenantId })) ?? {
      _id: tenantId,
      tenantId,
      bands: DEFAULT_BANDS,
      passMark: 50,
      updatedAt: new Date(0),
      updatedBy: null,
    }
  )
}

/** The band a percentage falls in (bands sorted high to low). */
export function bandOf(bands: GradeBand[], percent: number): GradeBand | null {
  return [...bands].sort((a, b) => b.min - a.min).find((b) => percent >= b.min) ?? null
}

const round1 = (n: number) => Math.round(n * 10) / 10

/** A subject's result in one term from its marks, or null with none. */
export function termPercent(plan: AssessmentPlanDoc, termId: string, marks: Pick<MarkDoc, 'assessmentId' | 'score'>[]): number | null {
  const term = plan.terms.find((t) => t.termId === termId)
  if (!term) return null
  const byAssessment = new Map(marks.map((m) => [m.assessmentId, m.score]))
  let weighted = 0
  let weights = 0
  for (const a of term.assessments) {
    const score = byAssessment.get(a.id)
    if (score === undefined || score === null || a.maxScore <= 0 || a.weight <= 0) continue
    weighted += (score / a.maxScore) * a.weight
    weights += a.weight
  }
  return weights > 0 ? round1((weighted / weights) * 100) : null
}

/** A subject's year result from its term results. */
export function yearPercent(plan: AssessmentPlanDoc, perTerm: Map<string, number | null>): number | null {
  let weighted = 0
  let weights = 0
  for (const t of plan.terms) {
    const p = perTerm.get(t.termId)
    if (p === null || p === undefined || t.weight <= 0) continue
    weighted += p * t.weight
    weights += t.weight
  }
  return weights > 0 ? round1(weighted / weights) : null
}

export interface StudentResult {
  studentId: string
  subjects: Record<string, { percent: number | null; band: GradeBand | null; passed: boolean | null }>
  average: number | null
  band: GradeBand | null
  /** 1 = highest average in the class; ties share a rank. */
  rank: number | null
  failed: number
}

/**
 * Every student's results for one term (`termId`) or the whole year
 * (`termId = 'year'`), over the plan's subjects.
 */
export function results(
  plan: AssessmentPlanDoc,
  grading: GradingSettingsDoc,
  studentIds: string[],
  marks: MarkDoc[],
  termId: string,
): StudentResult[] {
  const byKey = new Map<string, MarkDoc[]>()
  for (const m of marks) {
    const key = `${m.studentId}:${m.subjectCode}:${m.termId}`
    const list = byKey.get(key)
    if (list) list.push(m)
    else byKey.set(key, [m])
  }
  const out: StudentResult[] = studentIds.map((studentId) => {
    const subjects: StudentResult['subjects'] = {}
    const percents: number[] = []
    let failed = 0
    for (const code of plan.subjects) {
      let percent: number | null
      if (termId === 'year') {
        const perTerm = new Map(plan.terms.map((t) => [t.termId, termPercent(plan, t.termId, byKey.get(`${studentId}:${code}:${t.termId}`) ?? [])]))
        percent = yearPercent(plan, perTerm)
      } else {
        percent = termPercent(plan, termId, byKey.get(`${studentId}:${code}:${termId}`) ?? [])
      }
      const passed = percent === null ? null : percent >= grading.passMark
      if (passed === false) failed++
      if (percent !== null) percents.push(percent)
      subjects[code] = { percent, band: percent === null ? null : bandOf(grading.bands, percent), passed }
    }
    const average = percents.length ? round1(percents.reduce((a, b) => a + b, 0) / percents.length) : null
    return { studentId, subjects, average, band: average === null ? null : bandOf(grading.bands, average), rank: null, failed }
  })
  const ranked = out.filter((r) => r.average !== null).sort((a, b) => b.average! - a.average!)
  ranked.forEach((r, i) => {
    r.rank = i > 0 && ranked[i - 1]!.average === r.average ? ranked[i - 1]!.rank : i + 1
  })
  return out
}

const html = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export interface CardData {
  studentName: string
  studentNameAr: string | null
  studentNumber: string
  className: string
  result: StudentResult
  subjects: { code: string; label: string }[]
  attendance: { present: number; absent: number; late: number; excused: number } | null
  comment: string | null
}

const TEXT = {
  en: {
    card: 'Report card',
    student: 'Student',
    number: 'No.',
    cls: 'Class',
    subject: 'Subject',
    result: 'Result',
    grade: 'Grade',
    average: 'Average',
    rank: 'Rank in class',
    attendance: 'Attendance',
    present: 'present',
    absent: 'absent',
    late: 'late',
    excused: 'excused',
    comment: 'Class teacher’s remark',
    signature: 'Principal',
    none: 'No results to print.',
    pass: 'Pass mark',
  },
  ar: {
    card: 'الشهادة المدرسية',
    student: 'الطالب',
    number: 'الرقم',
    cls: 'الصف',
    subject: 'المادة',
    result: 'النتيجة',
    grade: 'التقدير',
    average: 'المعدل',
    rank: 'الترتيب في الصف',
    attendance: 'الحضور',
    present: 'حضور',
    absent: 'غياب',
    late: 'تأخر',
    excused: 'غياب بعذر',
    comment: 'ملاحظة مربي الصف',
    signature: 'مدير المدرسة',
    none: 'لا توجد نتائج للطباعة.',
    pass: 'علامة النجاح',
  },
}

/** Printable report cards, one per A4 page, in English or Arabic. */
export function reportCardsPage(
  cards: CardData[],
  o: { school: string; schoolAr: string | null; period: string; year: string; lang: 'en' | 'ar'; passMark: number; autoPrint: boolean },
): string {
  const T = TEXT[o.lang]
  const ar = o.lang === 'ar'
  const school = (ar && o.schoolAr) || o.school
  const pct = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)}%`)
  const band = (b: GradeBand | null) => (b ? `${b.code} · ${ar ? b.labelAr : b.label}` : '—')
  const body = cards
    .map((c) => {
      const rows = c.subjects
        .map((s) => {
          const r = c.result.subjects[s.code]
          const fail = r?.passed === false ? ' class="fail"' : ''
          return `<tr${fail}><td>${html(s.label)}</td><td class="num">${pct(r?.percent ?? null)}</td><td>${html(band(r?.band ?? null))}</td></tr>`
        })
        .join('')
      const att = c.attendance
        ? `<p><b>${T.attendance}:</b> ${c.attendance.present} ${T.present} · ${c.attendance.absent} ${T.absent} · ${c.attendance.late} ${T.late} · ${c.attendance.excused} ${T.excused}</p>`
        : ''
      return `<section class="card">
<header><div><h1>${html(school)}</h1><p>${T.card} — ${html(o.period)} · ${html(o.year)}</p></div></header>
<dl><div><dt>${T.student}</dt><dd>${html((ar && c.studentNameAr) || c.studentName)}</dd></div>
<div><dt>${T.number}</dt><dd class="mono">${html(c.studentNumber)}</dd></div><div><dt>${T.cls}</dt><dd>${html(c.className)}</dd></div></dl>
<table><thead><tr><th>${T.subject}</th><th class="num">${T.result}</th><th>${T.grade}</th></tr></thead><tbody>${rows}</tbody>
<tfoot><tr><th>${T.average}</th><th class="num">${pct(c.result.average)}</th><th>${html(band(c.result.band))}</th></tr></tfoot></table>
<p><b>${T.rank}:</b> ${c.result.rank ?? '—'} · <b>${T.pass}:</b> ${o.passMark}%</p>${att}
${c.comment ? `<div class="remark"><b>${T.comment}</b><p>${html(c.comment)}</p></div>` : ''}
<footer><span>${T.signature}: ____________________</span></footer>
</section>`
    })
    .join('')
  return `<!doctype html><html lang="${o.lang}" dir="${ar ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${T.card} — ${html(o.period)}</title>
<style>
@page{size:A4;margin:14mm}body{font-family:"Segoe UI",Tahoma,"Noto Naskh Arabic",Arial,sans-serif;color:#1c1d2b;margin:0}
.card{page-break-after:always;max-width:180mm;margin:0 auto;padding:6mm 0}.card:last-child{page-break-after:auto}
header{border-bottom:2px solid #3b2a8f;padding-bottom:4mm;margin-bottom:5mm}h1{font-size:20px;margin:0}header p{margin:2px 0 0;color:#555}
dl{display:flex;gap:10mm;margin:0 0 5mm}dt{font-size:11px;color:#666}dd{margin:0;font-weight:600}
table{width:100%;border-collapse:collapse;margin-bottom:4mm}th,td{border:1px solid #ccc;padding:6px 8px;text-align:start;font-size:13px}
thead th,tfoot th{background:#f1eff9}.num{text-align:end;font-variant-numeric:tabular-nums}.mono{font-family:ui-monospace,monospace}
tr.fail td{color:#a3122a}.remark{border:1px solid #ddd;border-radius:6px;padding:3mm;margin-top:4mm}.remark p{margin:2mm 0 0;white-space:pre-wrap}
footer{margin-top:14mm;display:flex;justify-content:flex-end;font-size:13px}p{font-size:13px}
@media screen{body{background:#f4f4f8}.card{background:#fff;margin:12px auto;padding:14mm;box-shadow:0 1px 6px rgba(0,0,0,.08)}}
</style></head><body>${body || `<p>${T.none}</p>`}${o.autoPrint ? '<script>addEventListener("load",()=>setTimeout(()=>print(),300))</script>' : ''}</body></html>`
}
