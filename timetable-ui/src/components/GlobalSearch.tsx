import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { globalSearch } from '../lib/searchApi'
import type { SearchResult, SearchResultType } from '../lib/searchApi'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

const MIN_QUERY_LENGTH = 2
const DEBOUNCE_MS = 300

const GROUP_ORDER: SearchResultType[] = ['student', 'parent', 'enrollment', 'invoice', 'payment', 'class', 'bus', 'stop']
const GROUP_KEY: Record<SearchResultType, TranslationKey> = {
  student: 'nav.students',
  parent: 'nav.parents',
  class: 'nav.classes',
  bus: 'search.group.buses',
  stop: 'search.group.stops',
  enrollment: 'search.group.enrollments',
  invoice: 'search.group.invoices',
  payment: 'search.group.payments',
}

function resultPath(result: SearchResult): string {
  switch (result.type) {
    case 'student':
      return `/students?student=${encodeURIComponent(result.id)}`
    case 'parent':
      return `/parents?parent=${encodeURIComponent(result.id)}`
    case 'class':
      return `/classes?class=${encodeURIComponent(result.id)}`
    case 'bus':
      return `/routes?bus=${encodeURIComponent(result.id)}`
    case 'stop':
      return `/routes?stop=${encodeURIComponent(result.id)}`
    case 'enrollment':
      return `/students?student=${encodeURIComponent(result.id)}`
    // A payment result carries its invoice's id.
    case 'invoice':
    case 'payment':
      return `/finance?invoice=${encodeURIComponent(result.id)}`
  }
}

interface Props {
  onClose: () => void
}

export function GlobalSearch({ onClose }: Props) {
  const { t } = useI18n()
  const { activeBranchId } = useApp()
  const { getAccessToken } = useAuth()
  const navigate = useNavigate()

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const trimmed = query.trim()
    setActiveIndex(0)
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([])
      setError(false)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    const timer = setTimeout(() => {
      void globalSearch(getAccessToken, { q: trimmed, branchId: activeBranchId ?? undefined }).then((result) => {
        if (cancelled) return
        setLoading(false)
        if (result.kind === 'ok') {
          setResults(result.data)
          setError(false)
        } else {
          setResults([])
          setError(true)
        }
      })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, activeBranchId, getAccessToken])

  const grouped = useMemo(() => {
    const byType = new Map<SearchResultType, SearchResult[]>()
    for (const result of results) {
      const list = byType.get(result.type) ?? []
      list.push(result)
      byType.set(result.type, list)
    }
    return GROUP_ORDER.filter((type) => byType.has(type)).map((type) => ({
      type,
      items: byType.get(type)!,
    }))
  }, [results])

  const goTo = (result: SearchResult) => {
    navigate(resultPath(result))
    onClose()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => Math.min(current + 1, results.length - 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => Math.max(current - 1, 0))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const active = results[activeIndex]
      if (active) goTo(active)
    }
  }

  let flatIndex = -1

  return (
    <div
      className="dialog"
      role="dialog"
      aria-modal="true"
      aria-label={t('search.trigger')}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dialog__panel" style={{ maxWidth: 560, maxHeight: '70vh' }}>
        <div className="dialog__head">
          <input
            ref={inputRef}
            className="input"
            style={{ flex: 1 }}
            type="text"
            value={query}
            placeholder={t('search.placeholder')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
            {t('dialog.close')}
          </button>
        </div>
        <div className="dialog__body" style={{ display: 'grid', gap: 14 }}>
          {query.trim().length < MIN_QUERY_LENGTH ? (
            <p className="card__hint">{t('search.minChars')}</p>
          ) : loading ? (
            <p className="card__hint">{t('search.loading')}</p>
          ) : error ? (
            <p className="card__empty">{t('search.error')}</p>
          ) : results.length === 0 ? (
            <p className="card__empty">{t('search.empty', { query: query.trim() })}</p>
          ) : (
            grouped.map((group) => (
              <div key={group.type}>
                <h3 className="card__subtitle">{t(GROUP_KEY[group.type])}</h3>
                <div style={{ display: 'grid', gap: 2 }}>
                  {group.items.map((item) => {
                    flatIndex += 1
                    const isActive = flatIndex === activeIndex
                    return (
                      <button
                        key={`${item.type}-${item.id}`}
                        type="button"
                        className="btn"
                        style={{
                          justifyContent: 'space-between',
                          width: '100%',
                          background: isActive ? 'var(--accent-soft)' : undefined,
                        }}
                        onMouseEnter={() => setActiveIndex(flatIndex)}
                        onClick={() => goTo(item)}
                      >
                        <span>{item.label}</span>
                        {item.meta && <span className="mono">{item.meta}</span>}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
