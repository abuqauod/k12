import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import {
  ACCEPTED_TYPES,
  MAX_DOCUMENT_BYTES,
  archiveDocument,
  documentFileUrl,
  listDocuments,
  listVersions,
  uploadDocument,
  verifyDocument,
  type DocumentOwnerType,
  type SchoolDocument,
} from '../lib/documentsApi'
import { listLookups, lookupLabel, type LookupItem } from '../lib/settingsApi'
import { ReasonDialog } from './ReasonDialog'

const ERRORS: Record<string, TranslationKey> = {
  FILE_TOO_LARGE: 'docs.error.tooLarge',
  UNSUPPORTED_FILE_TYPE: 'docs.error.type',
  EMPTY_FILE: 'docs.error.empty',
  INVALID_CATEGORY: 'docs.error.category',
  NOT_CURRENT_VERSION: 'docs.error.stale',
  ARCHIVED: 'docs.error.archived',
  NOTE_REQUIRED: 'docs.error.note',
  FORBIDDEN: 'docs.error.forbidden',
  BRANCH_FORBIDDEN: 'docs.error.forbidden',
}

function formatSize(bytes: number, n: (value: number) => string): string {
  if (bytes < 1024) return `${n(bytes)} B`
  if (bytes < 1024 * 1024) return `${n(Math.round(bytes / 1024))} KB`
  return `${n(Math.round((bytes / 1024 / 1024) * 10) / 10)} MB`
}

const TONE = { unverified: 'warn', verified: 'ok', rejected: 'bad' } as const

/**
 * Documents attached to one student or parent (SAMS 2.1): upload, preview,
 * verify, replace with a new version, history, archive. Each action is
 * shown only with the scope the API enforces for it.
 */
/** Besides documents.upload, the staff who raise a kind of record collect
 * its papers (mirrors the server's OWNER_UPLOAD_SCOPE). */
const OWNER_UPLOAD_SCOPE: Partial<Record<DocumentOwnerType, string>> = {
  application: 'admissions.manage',
  scholarship: 'finance.scholarship.request',
  expense: 'finance.expense.create',
  employee: 'hr.employee.update',
}

export function DocumentsPanel({ ownerType, ownerId }: { ownerType: DocumentOwnerType; ownerId: string }) {
  const { t, n, lang } = useI18n()
  const { getAccessToken, can } = useAuth()
  const ownScope = OWNER_UPLOAD_SCOPE[ownerType]
  const canUpload = can('documents.upload') || (ownScope !== undefined && can(ownScope))
  const [docs, setDocs] = useState<SchoolDocument[] | null>(null)
  const [categories, setCategories] = useState<LookupItem[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [preview, setPreview] = useState<SchoolDocument | null>(null)
  const [archiving, setArchiving] = useState<SchoolDocument | null>(null)
  const [rejecting, setRejecting] = useState<SchoolDocument | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const replaceInput = useRef<HTMLInputElement>(null)
  const replaceTarget = useRef<SchoolDocument | null>(null)

  const showError = (code: string) => setError(t(ERRORS[code] ?? 'docs.error.generic'))

  const load = useCallback(async () => {
    const res = await listDocuments(getAccessToken, ownerType, ownerId, showArchived)
    if (res.kind === 'ok') setDocs(res.data)
    else {
      setDocs([])
      setError(t(ERRORS[res.error] ?? 'docs.error.generic'))
    }
  }, [getAccessToken, ownerType, ownerId, showArchived, t])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void listLookups(getAccessToken, 'documentCategory', true).then((res) => {
      if (res.kind === 'ok') setCategories(res.data)
    })
  }, [getAccessToken])

  const categoryName = (code: string) => lookupLabel(categories, code, lang)

  const open = async (doc: SchoolDocument, download: boolean) => {
    const res = await documentFileUrl(getAccessToken, doc.id, download)
    if (res.kind !== 'ok') return showError(res.error)
    if (download) window.location.assign(res.data)
    else window.open(res.data, '_blank', 'noopener')
  }

  const verify = async (doc: SchoolDocument, status: 'verified' | 'rejected' | 'unverified', note?: string) => {
    setBusyId(doc.id)
    const res = await verifyDocument(getAccessToken, doc.id, { status, note })
    setBusyId(null)
    if (res.kind !== 'ok') {
      showError(res.error)
      return t(ERRORS[res.error] ?? 'docs.error.generic')
    }
    await load()
    return null
  }

  const onReplacePicked = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    const target = replaceTarget.current
    event.target.value = ''
    if (!file || !target) return
    if (file.size > MAX_DOCUMENT_BYTES) return showError('FILE_TOO_LARGE')
    setBusyId(target.id)
    const res = await uploadDocument(getAccessToken, file, { replaces: target.id })
    setBusyId(null)
    if (res.kind !== 'ok') return showError(res.error)
    setError(null)
    await load()
  }

  return (
    <section className="docs" aria-labelledby={`docs-${ownerId}`}>
      <div className="page__actions" style={{ marginBottom: 8 }}>
        <h3 id={`docs-${ownerId}`} className="card__subtitle" style={{ margin: 0, flex: 1 }}>
          {t('docs.title')} {docs && `(${n(docs.filter((d) => !d.archivedAt).length)})`}
        </h3>
        <label className="docs__toggle">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          {t('docs.showArchived')}
        </label>
        {canUpload && (
          <button type="button" className="btn btn--sm" onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
            {t('docs.upload')}
          </button>
        )}
      </div>

      {error && (
        <p className="login__error" role="alert">
          {error}
        </p>
      )}

      {adding && (
        <UploadForm
          categories={categories.filter((c) => c.active)}
          categoryName={categoryName}
          onCancel={() => setAdding(false)}
          onUpload={async (file, category, expiresAt) => {
            const res = await uploadDocument(getAccessToken, file, { ownerType, ownerId, category, expiresAt })
            if (res.kind !== 'ok') return t(ERRORS[res.error] ?? 'docs.error.generic')
            setAdding(false)
            setError(null)
            await load()
            return null
          }}
        />
      )}

      {docs === null ? (
        <div className="skeleton" style={{ height: 48 }} />
      ) : docs.length === 0 ? (
        <div className="empty-state">{t('docs.empty')}</div>
      ) : (
        <ul className="docs__list">
          {docs.map((doc) => {
            const status = doc.verification.status
            const current = !doc.archivedAt
            return (
              <li key={doc.id} className={`docs__item${doc.archivedAt ? ' docs__item--archived' : ''}`} aria-busy={busyId === doc.id || undefined}>
                <span className="docs__icon" aria-hidden="true">
                  {doc.mime === 'application/pdf' ? 'PDF' : 'IMG'}
                </span>
                <span className="docs__main">
                  <span className="docs__name">
                    <button type="button" className="link-btn" onClick={() => setPreview(doc)}>
                      {doc.fileName}
                    </button>
                    {doc.version > 1 && <span className="chip">v{n(doc.version)}</span>}
                  </span>
                  <span className="docs__meta">
                    {categoryName(doc.categoryCode)} · {formatSize(doc.size, n)} ·{' '}
                    {t('docs.uploadedBy', {
                      name: doc.uploadedByName ?? '—',
                      date: new Date(doc.createdAt).toLocaleDateString(lang),
                    })}
                  </span>
                  <span className="docs__chips">
                    <span className={`chip chip--${TONE[status]}`}>{t(`docs.status.${status}` as TranslationKey)}</span>
                    {doc.expiresAt && (
                      <span className={`chip${doc.expired ? ' chip--bad' : ''}`}>
                        {t(doc.expired ? 'docs.expired' : 'docs.expires', { date: doc.expiresAt })}
                      </span>
                    )}
                    {doc.archivedAt && <span className="chip">{t('docs.archived')}</span>}
                    {status === 'rejected' && doc.verification.note && (
                      <span className="docs__note">“{doc.verification.note}”</span>
                    )}
                  </span>
                </span>
                <span className="docs__actions">
                  <button type="button" className="btn btn--sm" onClick={() => setPreview(doc)}>
                    {t('docs.view')}
                  </button>
                  <button type="button" className="btn btn--sm" onClick={() => void open(doc, true)}>
                    {t('docs.download')}
                  </button>
                  {current && can('documents.verify') && status !== 'verified' && (
                    <button type="button" className="btn btn--sm" disabled={busyId === doc.id} onClick={() => void verify(doc, 'verified')}>
                      {t('docs.verify')}
                    </button>
                  )}
                  {current && can('documents.verify') && status !== 'rejected' && (
                    <button type="button" className="btn btn--sm" disabled={busyId === doc.id} onClick={() => setRejecting(doc)}>
                      {t('docs.reject')}
                    </button>
                  )}
                  {current && canUpload && (
                    <button
                      type="button"
                      className="btn btn--sm"
                      disabled={busyId === doc.id}
                      onClick={() => {
                        replaceTarget.current = doc
                        replaceInput.current?.click()
                      }}
                    >
                      {t('docs.newVersion')}
                    </button>
                  )}
                  {current && can('documents.delete') && (
                    <button type="button" className="btn btn--sm" onClick={() => setArchiving(doc)}>
                      {t('docs.archive')}
                    </button>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}

      <input ref={replaceInput} type="file" accept={ACCEPTED_TYPES} hidden onChange={(e) => void onReplacePicked(e)} />

      {preview && (
        <PreviewDialog
          doc={preview}
          categoryName={categoryName}
          onClose={() => setPreview(null)}
          onDownload={(doc) => void open(doc, true)}
        />
      )}

      {archiving && (
        <ReasonDialog
          title={t('docs.archiveTitle', { name: archiving.fileName })}
          confirmLabel={t('docs.archive')}
          onClose={() => setArchiving(null)}
          onConfirm={async (reason) => {
            const res = await archiveDocument(getAccessToken, archiving.id, reason)
            if (res.kind !== 'ok') return t(ERRORS[res.error] ?? 'docs.error.generic')
            setArchiving(null)
            await load()
            return null
          }}
        />
      )}

      {rejecting && (
        <ReasonDialog
          title={t('docs.rejectTitle', { name: rejecting.fileName })}
          confirmLabel={t('docs.reject')}
          onClose={() => setRejecting(null)}
          onConfirm={async (note) => {
            const failure = await verify(rejecting, 'rejected', note)
            if (!failure) setRejecting(null)
            return failure
          }}
        />
      )}
    </section>
  )
}

function UploadForm({
  categories,
  categoryName,
  onUpload,
  onCancel,
}: {
  categories: LookupItem[]
  categoryName: (code: string) => string
  onUpload: (file: File, category: string, expiresAt?: string) => Promise<string | null>
  onCancel: () => void
}) {
  const { t, n } = useI18n()
  const [file, setFile] = useState<File | null>(null)
  const [category, setCategory] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chosen = category || categories[0]?.code || ''
  const tooBig = file !== null && file.size > MAX_DOCUMENT_BYTES

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!file || !chosen || tooBig) return
    setBusy(true)
    setError(await onUpload(file, chosen, expiresAt || undefined))
    setBusy(false)
  }

  return (
    <form className="docs__form" onSubmit={(e) => void submit(e)}>
      <label className="field">
        <span className="field__label">{t('docs.category')}</span>
        <select className="select" value={chosen} onChange={(e) => setCategory(e.target.value)} required>
          {categories.map((c) => (
            <option key={c.code} value={c.code}>
              {categoryName(c.code)}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span className="field__label">{t('docs.expiry')}</span>
        <input className="input" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
      </label>
      <label className="field docs__file">
        <span className="field__label">{t('docs.file')}</span>
        <input type="file" accept={ACCEPTED_TYPES} required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <span className="card__hint">{t('docs.fileHint', { mb: n(MAX_DOCUMENT_BYTES / 1024 / 1024) })}</span>
      </label>
      {(error || tooBig) && (
        <p className="login__error" role="alert">
          {tooBig ? t('docs.error.tooLarge') : error}
        </p>
      )}
      <div className="page__actions docs__form-actions">
        <button type="button" className="btn btn--sm" onClick={onCancel} disabled={busy}>
          {t('docs.cancel')}
        </button>
        <button type="submit" className="btn btn--sm btn--primary" disabled={busy || !file || tooBig}>
          {busy ? t('docs.uploading') : t('docs.upload')}
        </button>
      </div>
    </form>
  )
}

/** Shows one version inline (image or PDF) with the document's history. */
function PreviewDialog({
  doc,
  categoryName,
  onClose,
  onDownload,
}: {
  doc: SchoolDocument
  categoryName: (code: string) => string
  onClose: () => void
  onDownload: (doc: SchoolDocument) => void
}) {
  const { t, n, lang } = useI18n()
  const { getAccessToken } = useAuth()
  const [shown, setShown] = useState(doc)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [versions, setVersions] = useState<SchoolDocument[]>([])

  useEffect(() => {
    let live = true
    setUrl(null)
    setFailed(false)
    void documentFileUrl(getAccessToken, shown.id).then((res) => {
      if (!live) return
      if (res.kind === 'ok') setUrl(res.data)
      else setFailed(true)
    })
    return () => {
      live = false
    }
  }, [getAccessToken, shown.id])

  useEffect(() => {
    void listVersions(getAccessToken, doc.id).then((res) => {
      if (res.kind === 'ok') setVersions(res.data)
    })
  }, [getAccessToken, doc.id])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="doc-preview-title"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dialog__panel docs__preview">
        <div className="dialog__head">
          <strong id="doc-preview-title">
            {shown.fileName} · {categoryName(shown.categoryCode)}
          </strong>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={t('docs.close')}>
            ×
          </button>
        </div>
        <div className="dialog__body docs__preview-body">
          <div className="docs__viewer">
            {failed ? (
              <div className="empty-state">{t('docs.error.generic')}</div>
            ) : !url ? (
              <div className="skeleton" style={{ height: '100%' }} />
            ) : shown.mime === 'application/pdf' ? (
              <iframe src={url} title={shown.fileName} />
            ) : (
              <img src={url} alt={shown.fileName} />
            )}
          </div>
          {versions.length > 1 && (
            <div>
              <h3 className="card__subtitle" style={{ marginTop: 0 }}>
                {t('docs.history')}
              </h3>
              <ol className="docs__versions">
                {versions.map((v) => (
                  <li key={v.id}>
                    <button
                      type="button"
                      className="link-btn"
                      aria-current={v.id === shown.id || undefined}
                      onClick={() => setShown(v)}
                    >
                      v{n(v.version)} · {v.fileName}
                    </button>
                    <span className="docs__meta">
                      {new Date(v.createdAt).toLocaleDateString(lang)} · {v.uploadedByName ?? '—'} ·{' '}
                      {t(`docs.status.${v.verification.status}` as TranslationKey)}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
        <div className="dialog__foot">
          <button type="button" className="btn btn--sm" onClick={() => onDownload(shown)}>
            {t('docs.download')}
          </button>
        </div>
      </div>
    </div>
  )
}
