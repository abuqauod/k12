import { withTenant } from '../db.js'
import { schoolName } from '../notifications/messages.js'
import type { RunResult } from './catalog.js'
import { tx, type Lang } from './common.js'
import type { ExportDoc } from './export.js'

/** SAMS 7.3: what a run covered, in words, for the top of an export. */

const L = {
  branch: tx('Branch', 'الفرع'),
  allBranches: tx('All branches', 'جميع الفروع'),
  year: tx('Academic year', 'السنة الدراسية'),
  from: tx('From', 'من'),
  to: tx('To', 'إلى'),
  grade: tx('Grade', 'المرحلة'),
  class: tx('Class', 'الصف'),
  status: tx('Status', 'الحالة'),
  asOf: tx('As of', 'حتى تاريخ'),
}

export async function describeRun(tenantId: string, run: RunResult, lang: Lang, today: string) {
  const f = run.definition.filters
  const out: { label: string; value: string }[] = []
  await withTenant(tenantId, async (ctx) => {
    if (f.includes('branch')) {
      const ids = run.branchIds
      const names = ids ? (await ctx.branches.find({ _id: { $in: ids } }).toArray()).map((b) => b.name) : []
      out.push({ label: L.branch[lang], value: ids ? names.join(', ') : L.allBranches[lang] })
    }
    const applied = run.applied
    if (applied.academicYearId) {
      const y = await ctx.academicYears.findOne({ _id: applied.academicYearId })
      out.push({ label: L.year[lang], value: y?.name ?? applied.academicYearId })
    }
    if (run.from) out.push({ label: L.from[lang], value: run.from })
    if (run.to) out.push({ label: L.to[lang], value: run.to })
    if (applied.gradeLevel) out.push({ label: L.grade[lang], value: applied.gradeLevel })
    if (applied.classId) {
      const c = await ctx.classes.findOne({ _id: applied.classId })
      out.push({ label: L.class[lang], value: c ? `${c.gradeLevel} ${c.name}`.trim() : applied.classId })
    }
    if (applied.status) {
      const s = run.definition.statuses?.find((x) => x.value === applied.status)
      out.push({ label: L.status[lang], value: s?.label[lang] ?? applied.status })
    }
  })
  if (!run.definition.filters.includes('dates')) out.push({ label: L.asOf[lang], value: today })
  return out
}

export async function exportDoc(tenantId: string, run: RunResult, lang: Lang, today: string): Promise<ExportDoc> {
  return {
    title: run.title,
    meta: await describeRun(tenantId, run, lang, today),
    schoolName: await schoolName(tenantId),
    generatedAt: new Date(),
    lang,
    table: run.table,
    truncated: run.truncated,
  }
}
