import { useState } from 'react'
import { api } from '../../lib/apiClient'
import { authorizedFetch } from '../../lib/http'
import { loadSyncSettings } from '../../lib/sync'
import { saveBlob } from '../../lib/reportsApi'
import { useApp } from '../../state/AppContext'
import { useAuth } from '../../auth/AuthContext'
import { useI18n } from '../../i18n/I18nContext'
import type { TranslationKey } from '../../i18n/translations'

/**
 * Settings → Import data (backlog): students (with a parent per row) or
 * employees from a CSV. Nothing is written until the preview is clean
 * enough and the member presses Import; rows with problems are skipped
 * and listed by line.
 */

type Kind = 'students' | 'employees'
const KIND_SCOPE: Record<Kind, string> = { students: 'students.create', employees: 'hr.employee.update' }
/** The preview table shows this many rows. */
const SHOWN = 200

interface Preview {
  columns: string[]
  unknownColumns: string[]
  total: number
  valid: number
  rows: { line: number; values: Record<string, string>; errors: string[] }[]
}
interface Result {
  created: { line: number; id: string; number: string | null }[]
  failed: { line: number; errors: string[] }[]
  warnings: { line: number; warning: string }[]
  parentsCreated: number
  parentsLinked: number
}

export function ImportSection() {
  const { t, n } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { branches, activeBranchId } = useApp()
  const kinds = (Object.keys(KIND_SCOPE) as Kind[]).filter((k) => can(KIND_SCOPE[k]))
  const [kind, setKind] = useState<Kind>(kinds[0] ?? 'students')
  const [picked, setBranchId] = useState('')
  // The branches load after the first render: fall back to the active one.
  const branchId = picked || activeBranchId || branches[0]?.id || ''
  const [file, setFile] = useState<{ name: string; text: string } | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const problem = (code: string) => {
    const key = `import.err.${code}` as TranslationKey
    return t(key) === key ? code : t(key)
  }
  const reset = () => {
    setPreview(null)
    setResult(null)
    setError(null)
  }

  const template = async () => {
    const base = loadSyncSettings().baseUrl.trim().replace(/\/+$/, '')
    const res = await authorizedFetch(`${base}/imports/${kind}/template`, { method: 'GET' }, getAccessToken)
    if (res.ok) saveBlob(await res.blob(), `${kind}-import-template.csv`)
  }
  const pick = async (f: File | undefined) => {
    reset()
    if (!f) return setFile(null)
    setFile({ name: f.name, text: await f.text() })
  }
  const run = async (step: 'preview' | 'commit') => {
    if (!file) return
    setBusy(true)
    setError(null)
    const res = await api<Preview | Result>(getAccessToken, 'POST', `/imports/${kind}/${step}`, { csv: file.text, branchId })
    setBusy(false)
    if (res.kind !== 'ok') {
      const missing = (res.details?.missing as string[] | undefined)?.join(', ')
      return setError(`${problem(res.error)}${missing ? `: ${missing}` : ''}`)
    }
    if (step === 'preview') setPreview(res.data as Preview)
    else {
      setResult(res.data as Result)
      setPreview(null)
    }
  }
  const problemsCsv = () => {
    if (!preview) return
    const bad = preview.rows.filter((r) => r.errors.length)
    const cols = preview.columns
    const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
    const lines = [
      ['line', ...cols, 'problems'].join(','),
      ...bad.map((r) => [String(r.line), ...cols.map((c) => cell(r.values[c] ?? '')), cell(r.errors.map(problem).join('; '))].join(',')),
    ]
    saveBlob(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), `${kind}-import-problems.csv`)
  }

  if (kinds.length === 0) return <div className="empty-state">{t('import.noAccess')}</div>
  return (
    <section className="card" aria-labelledby="import-title">
      <h2 id="import-title" className="card__title">
        {t('settings.section.import')}
      </h2>
      <p className="card__hint">{t('import.hint')}</p>
      <div className="inline-form">
        <label className="field field--inline">
          <span>{t('import.kind')}</span>
          <select
            className="select input--sm"
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as Kind)
              reset()
            }}
          >
            {kinds.map((k) => (
              <option key={k} value={k}>
                {t(`import.kind.${k}` as TranslationKey)}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--inline">
          <span>{t('rep.f.branch')}</span>
          <select
            className="select input--sm"
            value={branchId}
            onChange={(e) => {
              setBranchId(e.target.value)
              reset()
            }}
          >
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <small className="card__hint">{kind === 'students' ? t('import.branchStudents') : t('import.branchEmployees')}</small>
        <button type="button" className="btn btn--sm btn--ghost" onClick={() => void template()}>
          {t('import.template')}
        </button>
      </div>
      <div className="inline-form">
        <input type="file" accept=".csv,text/csv" aria-label={t('import.file')} onChange={(e) => void pick(e.target.files?.[0])} />
        <button type="button" className="btn btn--sm" disabled={!file || busy} onClick={() => void run('preview')}>
          {t('import.check')}
        </button>
      </div>
      {error && <p className="login__error">{error}</p>}

      {preview && (
        <>
          <p className={`notice${preview.valid < preview.total ? ' notice--warn' : ''}`}>
            {t('import.summary', { valid: n(preview.valid), total: n(preview.total) })}
            {preview.unknownColumns.length > 0 && ` ${t('import.ignored', { columns: preview.unknownColumns.join(', ') })}`}
          </p>
          <div className="inline-form">
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={busy || preview.valid === 0}
              onClick={() => void run('commit')}
            >
              {busy ? t('rep.preparing') : t('import.commit', { n: n(preview.valid) })}
            </button>
            {preview.valid < preview.total && (
              <button type="button" className="btn btn--sm btn--ghost" onClick={problemsCsv}>
                {t('import.problemsFile')}
              </button>
            )}
          </div>
          <div className="table-scroll report-table">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  {preview.columns.map((c) => (
                    <th key={c}>{t(`import.col.${c}` as TranslationKey)}</th>
                  ))}
                  <th>{t('import.problems')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.slice(0, SHOWN).map((r) => (
                  <tr key={r.line} className={r.errors.length ? 'row--error' : undefined}>
                    <td className="mono">{r.line}</td>
                    {preview.columns.map((c) => (
                      <td key={c} className="bidi">
                        {r.values[c]}
                      </td>
                    ))}
                    <td className="import-problems">{r.errors.length ? r.errors.map(problem).join('; ') : '✓'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rows.length > SHOWN && <p className="card__hint">{t('import.more', { n: n(preview.rows.length - SHOWN) })}</p>}
        </>
      )}

      {result && (
        <div className="stack-form">
          <p className="notice">
            {t('import.done', { n: n(result.created.length) })}
            {kind === 'students' &&
              (result.parentsCreated || result.parentsLinked) > 0 &&
              ` ${t('import.parents', { created: n(result.parentsCreated), linked: n(result.parentsLinked) })}`}
          </p>
          {result.failed.length > 0 && (
            <div className="notice notice--warn">
              <b>{t('import.skipped', { n: n(result.failed.length) })}</b>
              <ul className="import-list">
                {result.failed.slice(0, 50).map((f) => (
                  <li key={f.line}>
                    {t('import.line', { n: String(f.line) })}: {f.errors.map(problem).join('; ')}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.warnings.length > 0 && (
            <ul className="import-list card__hint">
              {result.warnings.slice(0, 50).map((w, i) => (
                <li key={i}>
                  {t('import.line', { n: String(w.line) })}: {problem(w.warning)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
