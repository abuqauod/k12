import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { useApp } from '../state/AppContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'
import { formatMinorUnits, parseMinorUnits } from '../domain/finance'
import { useLookup } from '../lib/useLookup'
import { PersonPicker, type PickedPerson } from '../components/ops/PersonPicker'
import {
  canteenSummary,
  getWallet,
  listProducts,
  lookupCard,
  refundSale,
  saveProduct,
  sell,
  topUp,
  type CardLookup,
  type Product,
  type WalletTx,
} from '../lib/canteenApi'

/**
 * SAMS 11.4 — the canteen: the till (scan the ID card, tap products, the
 * wallet is charged), students' wallets at the office (top-up, statement,
 * same-day refunds), the products, and the day's takings.
 */

type Tab = 'till' | 'wallets' | 'products' | 'today'

function canteenError(
  t: (k: TranslationKey, p?: Record<string, string | number>) => string,
  code: string,
  extra?: Record<string, unknown>,
) {
  const key = `canteen.error.${code}` as TranslationKey
  const text = t(key, { product: String(extra?.product ?? ''), left: formatMinorUnits(Number(extra?.leftToday ?? 0)) })
  return text === key ? t('canteen.error.generic') : text
}

export function CanteenPage() {
  const { t } = useI18n()
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const tabs: Tab[] = can('canteen.manage') ? ['till', 'wallets', 'products', 'today'] : ['till']
  const tab = (tabs.includes(params.get('tab') as Tab) ? params.get('tab') : 'till') as Tab
  return (
    <div className="page ops-page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('canteen.title')}</h1>
          <p className="page__subtitle">{t('canteen.subtitle')}</p>
        </div>
      </header>
      {tabs.length > 1 && (
        <div className="tabs" role="tablist" aria-label={t('canteen.title')}>
          {tabs.map((x) => (
            <button
              key={x}
              type="button"
              role="tab"
              aria-selected={tab === x}
              className="tabs__tab"
              onClick={() => setParams({ tab: x }, { replace: true })}
            >
              {t(`canteen.tab.${x}` as TranslationKey)}
            </button>
          ))}
        </div>
      )}
      {tab === 'till' && <Till />}
      {tab === 'wallets' && <Wallets />}
      {tab === 'products' && <Products />}
      {tab === 'today' && <Today />}
    </div>
  )
}

function Till() {
  const { t, lang } = useI18n()
  const { getAccessToken } = useAuth()
  const { activeBranchId } = useApp()
  const categories = useLookup('canteenCategory')
  const [products, setProducts] = useState<Product[]>([])
  const [card, setCard] = useState('')
  const [who, setWho] = useState<CardLookup | null>(null)
  const [basket, setBasket] = useState<Record<string, number>>({})
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void listProducts(getAccessToken, { branchId: activeBranchId ?? undefined }).then(
      (r) => r.kind === 'ok' && setProducts(r.data.products),
    )
  }, [getAccessToken, activeBranchId])

  const total = useMemo(
    () => Object.entries(basket).reduce((s, [id, q]) => s + (products.find((p) => p.id === id)?.price ?? 0) * q, 0),
    [basket, products],
  )
  const scan = async () => {
    if (!card.trim()) return
    const r = await lookupCard(getAccessToken, card.trim())
    if (r.kind !== 'ok') {
      setWho(null)
      return setMsg({ ok: false, text: canteenError(t, r.error) })
    }
    setWho(r.data)
    setMsg(null)
  }
  const charge = async () => {
    if (!who) return
    const items = Object.entries(basket)
      .filter(([, q]) => q > 0)
      .map(([productId, qty]) => ({ productId, qty }))
    if (items.length === 0) return
    const r = await sell(getAccessToken, { card: who.studentNumber, items })
    if (r.kind !== 'ok') return setMsg({ ok: false, text: canteenError(t, r.error, r.details) })
    setMsg({
      ok: true,
      text: t('canteen.sold', { total: formatMinorUnits(r.data.total), balance: formatMinorUnits(r.data.balanceAfter), name: r.data.name }),
    })
    setBasket({})
    setWho(null)
    setCard('')
  }
  const byCategory = useMemo(() => {
    const groups = new Map<string, Product[]>()
    for (const p of products) groups.set(p.categoryCode ?? '', [...(groups.get(p.categoryCode ?? '') ?? []), p])
    return [...groups.entries()]
  }, [products])

  return (
    <div className="card-row">
      <section className="card">
        <h2 className="card__title">{t('canteen.till.student')}</h2>
        <div className="inline-form">
          <input
            className="input"
            style={{ flex: 1 }}
            autoFocus
            placeholder={t('canteen.till.scan')}
            aria-label={t('canteen.till.scan')}
            value={card}
            onChange={(e) => setCard(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void scan()}
          />
          <button type="button" className="btn" onClick={() => void scan()}>
            {t('canteen.till.find')}
          </button>
        </div>
        {who && (
          <div className="till-who">
            <b>{who.name}</b> <span className="mono card__hint">{who.studentNumber}</span>
            <div className="till-who__balance mono">{formatMinorUnits(who.balance)}</div>
            {who.leftToday !== null && (
              <small className="card__hint">{t('canteen.till.leftToday', { left: formatMinorUnits(who.leftToday) })}</small>
            )}
            {who.blockedCategories.length > 0 && (
              <small className="card__hint">
                {' '}
                · {t('canteen.till.blocked', { list: who.blockedCategories.map((c) => categories.label(c)).join(', ') })}
              </small>
            )}
          </div>
        )}
        <div className="till-basket">
          {Object.entries(basket)
            .filter(([, q]) => q > 0)
            .map(([id, q]) => {
              const p = products.find((x) => x.id === id)
              return (
                <div key={id} className="stat-row">
                  <span>
                    {q} × {(lang === 'ar' && p?.nameAr) || p?.name}
                  </span>
                  <span className="row-actions">
                    <span className="mono">{formatMinorUnits((p?.price ?? 0) * q)}</span>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={() => setBasket((b) => ({ ...b, [id]: Math.max(0, (b[id] ?? 0) - 1) }))}
                    >
                      −
                    </button>
                  </span>
                </div>
              )
            })}
          <div className="stat-row till-total">
            <b>{t('canteen.till.total')}</b>
            <b className="mono">{formatMinorUnits(total)}</b>
          </div>
        </div>
        <button type="button" className="btn btn--primary till-charge" disabled={!who || total === 0} onClick={() => void charge()}>
          {t('canteen.till.charge')}
        </button>
        {msg && <p className={msg.ok ? 'notice' : 'notice notice--warn'}>{msg.text}</p>}
      </section>
      <section className="card">
        <h2 className="card__title">{t('canteen.till.products')}</h2>
        {products.length === 0 && <div className="empty-state">{t('canteen.noProducts')}</div>}
        {byCategory.map(([cat, list]) => (
          <div key={cat || 'none'}>
            {cat && <h3 className="card__subtitle">{categories.label(cat)}</h3>}
            <div className="till-grid">
              {list.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="till-product"
                  onClick={() => setBasket((b) => ({ ...b, [p.id]: (b[p.id] ?? 0) + 1 }))}
                >
                  <span>{(lang === 'ar' && p.nameAr) || p.name}</span>
                  <b className="mono">{formatMinorUnits(p.price)}</b>
                </button>
              ))}
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}

export function Statement({ rows, onRefund }: { rows: WalletTx[]; onRefund?: (id: string) => void }) {
  const { t, lang } = useI18n()
  if (rows.length === 0) return <div className="empty-state">{t('canteen.noTransactions')}</div>
  const today = new Date().toISOString().slice(0, 10)
  return (
    <div className="table-scroll">
      <table className="table">
        <thead>
          <tr>
            <th>{t('canteen.col.when')}</th>
            <th>{t('canteen.col.what')}</th>
            <th className="num">{t('canteen.col.amount')}</th>
            <th className="num">{t('canteen.col.balance')}</th>
            {onRefund && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={r.voided ? 'row--muted' : undefined}>
              <td className="mono">
                {new Date(r.createdAt).toLocaleString(lang === 'ar' ? 'ar' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })}
              </td>
              <td>
                {t(`canteen.tx.${r.type}` as TranslationKey)}
                {r.items.length > 0 && <small className="card__hint"> · {r.items.map((i) => `${i.qty}× ${i.name}`).join(', ')}</small>}
                {r.voided && <small className="card__hint"> · {t('canteen.refunded')}</small>}
              </td>
              <td className={`num mono${r.amount < 0 ? '' : ' text-ok'}`}>
                {r.amount > 0 ? '+' : ''}
                {formatMinorUnits(r.amount)}
              </td>
              <td className="num mono">{formatMinorUnits(r.balanceAfter)}</td>
              {onRefund && (
                <td>
                  {r.type === 'purchase' && !r.voided && r.createdAt.slice(0, 10) === today && (
                    <button type="button" className="link-btn" onClick={() => onRefund(r.id)}>
                      {t('canteen.refund')}
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Wallets() {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const { activeBranchId } = useApp()
  const methods = useLookup('paymentMethod')
  const [who, setWho] = useState<PickedPerson | null>(null)
  const [wallet, setWallet] = useState<Awaited<ReturnType<typeof getWallet>> | null>(null)
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState('cash')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    if (!who) return setWallet(null)
    setWallet(await getWallet(getAccessToken, who.id))
  }, [getAccessToken, who])
  useEffect(() => {
    void load()
  }, [load])

  const add = async () => {
    const minor = parseMinorUnits(amount)
    if (!who || minor === null || minor <= 0) return
    const r = await topUp(getAccessToken, who.id, { amount: minor, method, reference: null })
    if (r.kind !== 'ok') return setMsg({ ok: false, text: canteenError(t, r.error) })
    setMsg({ ok: true, text: t('canteen.toppedUp', { balance: formatMinorUnits(r.data.balanceAfter) }) })
    setAmount('')
    await load()
  }
  const refund = async (id: string) => {
    const r = await refundSale(getAccessToken, id)
    if (r.kind !== 'ok') return setMsg({ ok: false, text: canteenError(t, r.error) })
    await load()
  }
  const w = wallet?.kind === 'ok' ? wallet.data : null

  return (
    <section className="card">
      <h2 className="card__title">{t('canteen.tab.wallets')}</h2>
      {who ? (
        <div className="stat-row">
          <b>{who.label}</b>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setWho(null)}>
            {t('lib.desk.change')}
          </button>
        </div>
      ) : (
        <PersonPicker types={['student']} branchId={activeBranchId ?? undefined} onPick={setWho} />
      )}
      {w && (
        <>
          <div className="till-who">
            <div className="till-who__balance mono">{formatMinorUnits(w.balance)}</div>
            {w.dailyLimit !== null && (
              <small className="card__hint">{t('canteen.dailyLimitIs', { limit: formatMinorUnits(w.dailyLimit) })}</small>
            )}
          </div>
          <div className="inline-form">
            <input
              className="input input--sm mono"
              inputMode="decimal"
              dir="ltr"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label={t('canteen.col.amount')}
            />
            <select
              className="select input--sm"
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              aria-label={t('canteen.method')}
            >
              {methods.active
                .filter((m) => m.code !== 'online')
                .map((m) => (
                  <option key={m.code} value={m.code}>
                    {methods.label(m.code)}
                  </option>
                ))}
            </select>
            <button type="button" className="btn btn--primary btn--sm" onClick={() => void add()}>
              {t('canteen.topUp')}
            </button>
          </div>
          {msg && <p className={msg.ok ? 'notice' : 'notice notice--warn'}>{msg.text}</p>}
          <Statement rows={w.transactions} onRefund={(id) => void refund(id)} />
        </>
      )}
    </section>
  )
}

function Products() {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const { activeBranchId, branches } = useApp()
  const categories = useLookup('canteenCategory')
  const [rows, setRows] = useState<Product[]>([])
  const [draft, setDraft] = useState({ name: '', nameAr: '', price: '', categoryCode: '' })
  const [error, setError] = useState<string | null>(null)
  const branchId = activeBranchId || branches[0]?.id || ''

  const load = useCallback(async () => {
    const r = await listProducts(getAccessToken, { branchId: branchId || undefined, all: true })
    setRows(r.kind === 'ok' ? r.data.products : [])
  }, [getAccessToken, branchId])
  useEffect(() => {
    void load()
  }, [load])

  const add = async () => {
    const price = parseMinorUnits(draft.price)
    if (!draft.name.trim() || price === null) return
    const r = await saveProduct(getAccessToken, {
      branchId,
      name: draft.name.trim(),
      nameAr: draft.nameAr.trim() || null,
      price,
      categoryCode: draft.categoryCode || null,
      active: true,
    })
    if (r.kind !== 'ok') return setError(canteenError(t, r.error))
    setDraft({ name: '', nameAr: '', price: '', categoryCode: '' })
    setError(null)
    await load()
  }
  const toggle = async (p: Product) => {
    await saveProduct(
      getAccessToken,
      { branchId: p.branchId, name: p.name, nameAr: p.nameAr, price: p.price, categoryCode: p.categoryCode, active: !p.active },
      p.id,
    )
    await load()
  }

  return (
    <section className="card">
      <h2 className="card__title">{t('canteen.tab.products')}</h2>
      <div className="inline-form">
        <input
          className="input input--sm"
          placeholder={t('canteen.product.name')}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
        <input
          className="input input--sm"
          dir="rtl"
          placeholder={t('canteen.product.nameAr')}
          value={draft.nameAr}
          onChange={(e) => setDraft({ ...draft, nameAr: e.target.value })}
        />
        <input
          className="input input--sm mono grade-input"
          inputMode="decimal"
          dir="ltr"
          placeholder="0.00"
          value={draft.price}
          onChange={(e) => setDraft({ ...draft, price: e.target.value })}
        />
        <select
          className="select input--sm"
          value={draft.categoryCode}
          onChange={(e) => setDraft({ ...draft, categoryCode: e.target.value })}
          aria-label={t('canteen.product.category')}
        >
          <option value="">{t('canteen.product.noCategory')}</option>
          {categories.active.map((c) => (
            <option key={c.code} value={c.code}>
              {categories.label(c.code)}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => void add()}>
          {t('canteen.product.add')}
        </button>
      </div>
      {error && <p className="notice notice--warn">{error}</p>}
      <table className="table">
        <tbody>
          {rows.map((p) => (
            <tr key={p.id} className={p.active ? undefined : 'row--muted'}>
              <td>
                {p.name} {p.nameAr && <span className="card__hint">· {p.nameAr}</span>}
              </td>
              <td>{categories.label(p.categoryCode)}</td>
              <td className="num mono">{formatMinorUnits(p.price)}</td>
              <td>
                <button type="button" className="link-btn" onClick={() => void toggle(p)}>
                  {p.active ? t('canteen.product.hide') : t('canteen.product.show')}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function Today() {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const { activeBranchId } = useApp()
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10))
  const [data, setData] = useState<Awaited<ReturnType<typeof canteenSummary>> | null>(null)
  useEffect(() => {
    void canteenSummary(getAccessToken, { branchId: activeBranchId ?? undefined, date }).then(setData)
  }, [getAccessToken, activeBranchId, date])
  const d = data?.kind === 'ok' ? data.data : null
  return (
    <section className="card">
      <div className="card__head">
        <h2 className="card__title">{t('canteen.tab.today')}</h2>
        <input
          className="input input--sm"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          aria-label={t('canteen.col.when')}
        />
      </div>
      {d && (
        <>
          <div className="stat-row">
            <span>{t('canteen.today.sales', { n: d.sales })}</span>
            <b className="mono">{formatMinorUnits(d.salesTotal)}</b>
          </div>
          <div className="stat-row">
            <span>{t('canteen.today.topups')}</span>
            <b className="mono">{formatMinorUnits(d.topups)}</b>
          </div>
          <table className="table">
            <tbody>
              {d.products.map((p) => (
                <tr key={p.name}>
                  <td>{p.name}</td>
                  <td className="num mono">{p.qty}</td>
                  <td className="num mono">{formatMinorUnits(p.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}
