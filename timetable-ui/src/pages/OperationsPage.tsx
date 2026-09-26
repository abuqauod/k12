import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  assetStep,
  createAsset,
  createBuilding,
  createItem,
  createRoom,
  createSupplier,
  getAsset,
  itemMovements,
  listAssets,
  listFacilities,
  listItems,
  listMaintenance,
  listSuppliers,
  moveStock,
  reportMaintenance,
  updateMaintenance,
  type Asset,
  type Building,
  type InventoryItem,
  type MaintenanceRequest,
  type Room,
  type StockMovement,
  type Supplier,
} from '../lib/opsApi'
import { listEmployees, type Employee } from '../lib/hrApi'
import { useLookup } from '../lib/useLookup'
import { opsError, ASSET_TONE, MAINT_TONE, PRIORITY_TONE } from '../lib/opsUi'
import { formatMinorUnits, parseMinorUnits } from '../domain/finance'
import { DocumentsPanel } from '../components/DocumentsPanel'
import { ReasonDialog } from '../components/ReasonDialog'
import { useApp } from '../state/AppContext'
import { useAuth } from '../auth/AuthContext'
import { useI18n } from '../i18n/I18nContext'
import type { TranslationKey } from '../i18n/translations'

/**
 * Operations (SAMS 5.1–5.3) for the active branch: assets and their
 * lifecycle, stock, buildings and rooms, and maintenance requests.
 */

type Tab = 'assets' | 'inventory' | 'facilities' | 'maintenance'
const TABS: Tab[] = ['assets', 'inventory', 'facilities', 'maintenance']

export function OperationsPage() {
  const { t } = useI18n()
  const [params, setParams] = useSearchParams()
  const tab = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'assets') as Tab
  return (
    <div className="page ops-page">
      <header className="page__head">
        <div>
          <h1 className="page__title">{t('nav.operations')}</h1>
          <p className="page__subtitle">{t('ops.subtitle')}</p>
        </div>
      </header>
      <div className="tabs" role="tablist" aria-label={t('nav.operations')}>
        {TABS.map((x) => (
          <button
            key={x}
            type="button"
            role="tab"
            aria-selected={tab === x}
            className="tabs__tab"
            onClick={() =>
              setParams(
                (p) => {
                  p.set('tab', x)
                  return p
                },
                { replace: true },
              )
            }
          >
            {t(`ops.tab.${x}` as TranslationKey)}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="finance-panel">
        {tab === 'assets' && <AssetsTab />}
        {tab === 'inventory' && <InventoryTab />}
        {tab === 'facilities' && <FacilitiesTab />}
        {tab === 'maintenance' && <MaintenanceTab />}
      </div>
    </div>
  )
}

function useRooms() {
  const { getAccessToken } = useAuth()
  const { activeBranchId } = useApp()
  const [data, setData] = useState<{ buildings: Building[]; rooms: Room[] }>({ buildings: [], rooms: [] })
  const reload = useCallback(async () => {
    const res = await listFacilities(getAccessToken, activeBranchId ?? undefined)
    if (res.kind === 'ok') setData(res.data)
  }, [getAccessToken, activeBranchId])
  useEffect(() => {
    void reload()
  }, [reload])
  return { ...data, reload }
}

// ----------------------------------------------------------------- assets --

function AssetsTab() {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { activeBranchId } = useApp()
  const categories = useLookup('assetCategory')
  const { rooms } = useRooms()
  const [status, setStatus] = useState('')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<Asset[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [f, setF] = useState({
    name: '',
    categoryCode: '',
    roomId: '',
    serialNumber: '',
    purchaseDate: '',
    purchaseCost: '',
    warrantyUntil: '',
  })
  const [error, setError] = useState<string | null>(null)
  const canManage = can('ops.assets.manage')

  const load = useCallback(async () => {
    const res = await listAssets(getAccessToken, { branchId: activeBranchId ?? undefined, status: status || undefined })
    setRows(res.kind === 'ok' ? res.data : [])
  }, [getAccessToken, activeBranchId, status])
  useEffect(() => {
    void load()
  }, [load])

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return (rows ?? []).filter((a) => !needle || [a.assetTag, a.name, a.serialNumber ?? ''].join(' ').toLowerCase().includes(needle))
  }, [rows, q])

  const add = async () => {
    if (!activeBranchId || !f.name.trim()) return setError(t('ops.error.name'))
    const cost = f.purchaseCost.trim() ? parseMinorUnits(f.purchaseCost) : null
    const res = await createAsset(getAccessToken, {
      branchId: activeBranchId,
      name: f.name.trim(),
      categoryCode: f.categoryCode || categories.active[0]?.code,
      roomId: f.roomId || null,
      serialNumber: f.serialNumber.trim() || null,
      purchaseDate: f.purchaseDate || null,
      purchaseCost: cost,
      warrantyUntil: f.warrantyUntil || null,
    })
    if (res.kind !== 'ok') return setError(opsError(t, res.error))
    setAdding(false)
    setError(null)
    setF({ name: '', categoryCode: '', roomId: '', serialNumber: '', purchaseDate: '', purchaseCost: '', warrantyUntil: '' })
    setOpenId(res.data.id)
    await load()
  }

  return (
    <section className="card">
      <div className="card__head">
        <select className="input input--sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('ops.col.status')}>
          <option value="">{t('ops.assets.inUse')}</option>
          {(['in_stock', 'assigned', 'maintenance', 'disposed'] as const).map((s) => (
            <option key={s} value={s}>
              {t(`ops.asset.status.${s}` as TranslationKey)}
            </option>
          ))}
        </select>
        <input
          className="input input--sm"
          style={{ flex: 1, minWidth: 160 }}
          placeholder={t('ops.search')}
          aria-label={t('ops.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {canManage && !adding && (
          <button type="button" className="btn btn--sm btn--primary" disabled={!activeBranchId} onClick={() => setAdding(true)}>
            + {t('ops.asset.new')}
          </button>
        )}
      </div>
      {adding && (
        <div className="inline-form">
          <input
            className="input input--sm"
            placeholder={t('ops.col.name')}
            aria-label={t('ops.col.name')}
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
          />
          <select
            className="input input--sm"
            value={f.categoryCode}
            onChange={(e) => setF({ ...f, categoryCode: e.target.value })}
            aria-label={t('ops.col.category')}
          >
            {categories.active.map((c) => (
              <option key={c.code} value={c.code}>
                {categories.label(c.code)}
              </option>
            ))}
          </select>
          <select
            className="input input--sm"
            value={f.roomId}
            onChange={(e) => setF({ ...f, roomId: e.target.value })}
            aria-label={t('ops.col.room')}
          >
            <option value="">{t('ops.noRoom')}</option>
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <input
            className="input input--sm"
            style={{ maxWidth: 140 }}
            placeholder={t('ops.asset.serial')}
            aria-label={t('ops.asset.serial')}
            value={f.serialNumber}
            onChange={(e) => setF({ ...f, serialNumber: e.target.value })}
          />
          <label className="field field--inline">
            <span>{t('ops.asset.purchased')}</span>
            <input
              type="date"
              className="input input--sm"
              value={f.purchaseDate}
              onChange={(e) => setF({ ...f, purchaseDate: e.target.value })}
            />
          </label>
          <input
            className="input input--sm"
            style={{ maxWidth: 110 }}
            inputMode="decimal"
            placeholder={t('ops.asset.cost')}
            aria-label={t('ops.asset.cost')}
            value={f.purchaseCost}
            onChange={(e) => setF({ ...f, purchaseCost: e.target.value })}
          />
          <label className="field field--inline">
            <span>{t('ops.asset.warranty')}</span>
            <input
              type="date"
              className="input input--sm"
              value={f.warrantyUntil}
              onChange={(e) => setF({ ...f, warrantyUntil: e.target.value })}
            />
          </label>
          <button type="button" className="btn btn--sm btn--primary" onClick={() => void add()}>
            {t('fin.add')}
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAdding(false)}>
            {t('docs.cancel')}
          </button>
        </div>
      )}
      {error && <p className="login__error">{error}</p>}
      {rows === null ? (
        <div className="skeleton" style={{ height: 100 }} />
      ) : shown.length === 0 ? (
        <div className="empty-state">{t('ops.assets.none')}</div>
      ) : (
        <ul className="record-list">
          {shown.map((a) => (
            <li key={a.id} className="record-list__item">
              <div className="record-list__row">
                <button
                  type="button"
                  className="record-list__main"
                  onClick={() => setOpenId(openId === a.id ? null : a.id)}
                  aria-expanded={openId === a.id}
                >
                  <span className="mono">{a.assetTag}</span> · <b>{a.name}</b>
                  <span className="card__hint">
                    {' '}
                    — {categories.label(a.categoryCode)}
                    {a.roomName && ` · ${a.roomName}`}
                    {a.assignedToName && ` · ${t('ops.asset.with', { name: a.assignedToName })}`}
                  </span>
                </button>
                <span className={`chip ${ASSET_TONE[a.status]}`}>{t(`ops.asset.status.${a.status}` as TranslationKey)}</span>
              </div>
              {openId === a.id && <AssetDetail id={a.id} rooms={rooms} canManage={canManage} onChanged={() => void load()} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function AssetDetail({ id, rooms, canManage, onChanged }: { id: string; rooms: Room[]; canManage: boolean; onChanged: () => void }) {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { branches } = useApp()
  const [asset, setAsset] = useState<Asset | null>(null)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [target, setTarget] = useState('')
  const [branch, setBranch] = useState('')
  const [cost, setCost] = useState('')
  const [disposing, setDisposing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await getAsset(getAccessToken, id)
    if (res.kind === 'ok') setAsset(res.data)
  }, [getAccessToken, id])
  useEffect(() => {
    void load()
    if (can('hr.read')) void listEmployees(getAccessToken, { status: 'active' }).then((r) => r.kind === 'ok' && setEmployees(r.data))
  }, [load, getAccessToken, can])

  const run = async (step: Parameters<typeof assetStep>[2], body: Record<string, unknown>) => {
    const res = await assetStep(getAccessToken, id, step, body)
    if (res.kind !== 'ok') return setError(opsError(t, res.error))
    setError(null)
    await load()
    onChanged()
  }

  if (!asset) return <div className="skeleton" style={{ height: 60 }} />
  const live = asset.status !== 'disposed'
  return (
    <div className="record-detail">
      <div className="stat-row">
        <span>{t('ops.asset.serial')}</span>
        <span className="mono">{asset.serialNumber ?? '—'}</span>
      </div>
      <div className="stat-row">
        <span>{t('ops.asset.purchased')}</span>
        <span className="mono">
          {asset.purchaseDate ?? '—'}
          {asset.purchaseCost !== null && ` · ${formatMinorUnits(asset.purchaseCost)}`}
        </span>
      </div>
      <div className="stat-row">
        <span>{t('ops.asset.warranty')}</span>
        <span className="mono">{asset.warrantyUntil ?? '—'}</span>
      </div>
      {canManage && live && (
        <div className="inline-form">
          {asset.status === 'in_stock' && (
            <>
              <select
                className="input input--sm"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                aria-label={t('ops.asset.assign')}
              >
                <option value="">{t('ops.asset.assignTo')}</option>
                <optgroup label={t('ops.col.room')}>
                  {rooms.map((r) => (
                    <option key={r.id} value={`room:${r.id}`}>
                      {r.name}
                    </option>
                  ))}
                </optgroup>
                {employees.length > 0 && (
                  <optgroup label={t('ops.picker.employee')}>
                    {employees.map((e) => (
                      <option key={e.id} value={`employee:${e.id}`}>
                        {e.fullName}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <button
                type="button"
                className="btn btn--sm"
                disabled={!target}
                onClick={() => void run('assign', { type: target.split(':')[0], id: target.split(':')[1] })}
              >
                {t('ops.asset.assign')}
              </button>
            </>
          )}
          {asset.status === 'assigned' && (
            <button type="button" className="btn btn--sm" onClick={() => void run('return', {})}>
              {t('ops.asset.return')}
            </button>
          )}
          {asset.status !== 'maintenance' ? (
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => void run('maintenance', { action: 'start' })}>
              {t('ops.asset.toMaintenance')}
            </button>
          ) : (
            <>
              <input
                className="input input--sm"
                style={{ maxWidth: 110 }}
                inputMode="decimal"
                placeholder={t('ops.asset.cost')}
                aria-label={t('ops.asset.cost')}
                value={cost}
                onChange={(e) => setCost(e.target.value)}
              />
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void run('maintenance', { action: 'end', ...(cost.trim() ? { cost: parseMinorUnits(cost) ?? 0 } : {}) })}
              >
                {t('ops.asset.backFromMaintenance')}
              </button>
            </>
          )}
          {asset.status !== 'assigned' && (
            <>
              <select
                className="input input--sm"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                aria-label={t('ops.asset.transfer')}
              >
                <option value="">{t('ops.asset.transferTo')}</option>
                {branches
                  .filter((b) => b.id !== asset.branchId)
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                disabled={!branch}
                onClick={() => void run('transfer', { branchId: branch })}
              >
                {t('ops.asset.transfer')}
              </button>
            </>
          )}
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setDisposing(true)}>
            {t('ops.asset.dispose')}
          </button>
        </div>
      )}
      {!live && (
        <p className="card__hint">{t('ops.asset.disposedOn', { date: asset.disposedAt ?? '', reason: asset.disposalReason ?? '' })}</p>
      )}
      {error && <p className="login__error">{error}</p>}
      <h4 className="card__subtitle">{t('ops.history')}</h4>
      <ol className="timeline">
        {(asset.history ?? []).map((h) => (
          <li key={h.id} className="timeline__item">
            <span className="mono timeline__date">{h.date}</span>
            <b>{t(`ops.asset.event.${h.type}` as TranslationKey)}</b>
            {(h.note || h.cost !== null) && (
              <span className="card__hint">
                {' '}
                {h.note}
                {h.cost !== null && ` · ${formatMinorUnits(h.cost)}`}
              </span>
            )}
          </li>
        ))}
      </ol>
      <DocumentsPanel ownerType="asset" ownerId={asset.id} />
      {disposing && (
        <ReasonDialog
          title={t('ops.asset.dispose')}
          confirmLabel={t('ops.asset.dispose')}
          onClose={() => setDisposing(false)}
          onConfirm={async (reason) => {
            const res = await assetStep(getAccessToken, id, 'dispose', { reason })
            if (res.kind !== 'ok') return opsError(t, res.error)
            setDisposing(false)
            await load()
            onChanged()
            return null
          }}
        />
      )}
    </div>
  )
}

// -------------------------------------------------------------- inventory --

function InventoryTab() {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { activeBranchId, branches } = useApp()
  const categories = useLookup('inventoryCategory')
  const [rows, setRows] = useState<InventoryItem[] | null>(null)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [lowOnly, setLowOnly] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [f, setF] = useState({ sku: '', name: '', unit: 'pcs', categoryCode: '', reorderLevel: '0' })
  const [supplierName, setSupplierName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const canManage = can('ops.inventory.manage')

  const load = useCallback(async () => {
    const [items, sup] = await Promise.all([
      listItems(getAccessToken, { branchId: activeBranchId ?? undefined, lowStock: lowOnly }),
      listSuppliers(getAccessToken),
    ])
    setRows(items.kind === 'ok' ? items.data : [])
    if (sup.kind === 'ok') setSuppliers(sup.data)
  }, [getAccessToken, activeBranchId, lowOnly])
  useEffect(() => {
    void load()
  }, [load])

  const add = async () => {
    if (!activeBranchId) return
    const res = await createItem(getAccessToken, {
      branchId: activeBranchId,
      sku: f.sku.trim(),
      name: f.name.trim(),
      unit: f.unit.trim() || 'pcs',
      categoryCode: f.categoryCode || categories.active[0]?.code,
      reorderLevel: Number(f.reorderLevel) || 0,
    })
    if (res.kind !== 'ok') return setError(opsError(t, res.error))
    setAdding(false)
    setError(null)
    setF({ sku: '', name: '', unit: 'pcs', categoryCode: '', reorderLevel: '0' })
    await load()
  }
  const addSupplier = async () => {
    if (!supplierName.trim()) return
    const res = await createSupplier(getAccessToken, { name: supplierName.trim() })
    if (res.kind !== 'ok') return setError(opsError(t, res.error))
    setSupplierName('')
    await load()
  }

  return (
    <div className="card-row card-row--wide-first">
      <section className="card">
        <div className="card__head">
          <label className="checkbox-inline">
            <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
            {t('ops.inventory.lowOnly')}
          </label>
          <span style={{ flex: 1 }} />
          {canManage && !adding && (
            <button type="button" className="btn btn--sm btn--primary" disabled={!activeBranchId} onClick={() => setAdding(true)}>
              + {t('ops.inventory.new')}
            </button>
          )}
        </div>
        {adding && (
          <div className="inline-form">
            <input
              className="input input--sm"
              style={{ maxWidth: 110 }}
              placeholder={t('ops.inventory.sku')}
              aria-label={t('ops.inventory.sku')}
              value={f.sku}
              onChange={(e) => setF({ ...f, sku: e.target.value })}
            />
            <input
              className="input input--sm"
              placeholder={t('ops.col.name')}
              aria-label={t('ops.col.name')}
              value={f.name}
              onChange={(e) => setF({ ...f, name: e.target.value })}
            />
            <input
              className="input input--sm"
              style={{ maxWidth: 80 }}
              placeholder={t('ops.inventory.unit')}
              aria-label={t('ops.inventory.unit')}
              value={f.unit}
              onChange={(e) => setF({ ...f, unit: e.target.value })}
            />
            <select
              className="input input--sm"
              value={f.categoryCode}
              onChange={(e) => setF({ ...f, categoryCode: e.target.value })}
              aria-label={t('ops.col.category')}
            >
              {categories.active.map((c) => (
                <option key={c.code} value={c.code}>
                  {categories.label(c.code)}
                </option>
              ))}
            </select>
            <label className="field field--inline">
              <span>{t('ops.inventory.reorder')}</span>
              <input
                className="input input--sm"
                style={{ maxWidth: 70 }}
                inputMode="numeric"
                value={f.reorderLevel}
                onChange={(e) => setF({ ...f, reorderLevel: e.target.value })}
              />
            </label>
            <button type="button" className="btn btn--sm btn--primary" onClick={() => void add()}>
              {t('fin.add')}
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => setAdding(false)}>
              {t('docs.cancel')}
            </button>
          </div>
        )}
        {error && <p className="login__error">{error}</p>}
        {rows === null ? (
          <div className="skeleton" style={{ height: 100 }} />
        ) : rows.length === 0 ? (
          <div className="empty-state">{t('ops.inventory.none')}</div>
        ) : (
          <ul className="record-list">
            {rows.map((i) => (
              <li key={i.id} className="record-list__item">
                <div className="record-list__row">
                  <button
                    type="button"
                    className="record-list__main"
                    onClick={() => setOpenId(openId === i.id ? null : i.id)}
                    aria-expanded={openId === i.id}
                  >
                    <span className="mono">{i.sku}</span> · <b>{i.name}</b>
                    <span className="card__hint"> — {categories.label(i.categoryCode)}</span>
                  </button>
                  <b className="mono">
                    {i.quantity} {i.unit}
                  </b>
                  {i.lowStock && <span className="chip chip--warn">{t('ops.inventory.low')}</span>}
                </div>
                {openId === i.id && (
                  <StockPanel item={i} suppliers={suppliers} branches={branches} canManage={canManage} onChanged={() => void load()} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card">
        <h2 className="card__title">{t('ops.suppliers')}</h2>
        <p className="card__hint">{t('ops.suppliers.hint')}</p>
        {suppliers.map((s) => (
          <div key={s.id} className="stat-row">
            <span>{s.name}</span>
            <span className="card__hint">{s.phone ?? ''}</span>
          </div>
        ))}
        {canManage && (
          <div className="inline-form">
            <input
              className="input input--sm"
              placeholder={t('fin.vendor.name')}
              aria-label={t('fin.vendor.name')}
              value={supplierName}
              onChange={(e) => setSupplierName(e.target.value)}
            />
            <button type="button" className="btn btn--sm" onClick={() => void addSupplier()}>
              {t('fin.add')}
            </button>
          </div>
        )}
      </section>
    </div>
  )
}

function StockPanel({
  item,
  suppliers,
  branches,
  canManage,
  onChanged,
}: {
  item: InventoryItem
  suppliers: Supplier[]
  branches: { id: string; name: string }[]
  canManage: boolean
  onChanged: () => void
}) {
  const { t } = useI18n()
  const { getAccessToken } = useAuth()
  const [moves, setMoves] = useState<StockMovement[]>([])
  const [type, setType] = useState<'receive' | 'issue' | 'adjust' | 'transfer'>('receive')
  const [qty, setQty] = useState('')
  const [extra, setExtra] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [toBranch, setToBranch] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await itemMovements(getAccessToken, item.id)
    if (res.kind === 'ok') setMoves(res.data.movements)
  }, [getAccessToken, item.id])
  useEffect(() => {
    void load()
  }, [load])

  const submit = async () => {
    const quantity = Number(qty)
    if (!Number.isInteger(quantity) || quantity === 0) return setError(t('ops.error.quantity'))
    const body =
      type === 'receive'
        ? { type, quantity, supplierId: supplierId || null, reference: extra.trim() || null }
        : type === 'issue'
          ? { type, quantity, issuedTo: extra.trim() }
          : type === 'adjust'
            ? { type, quantity, note: extra.trim() }
            : { type, quantity, toBranchId: toBranch, note: extra.trim() || null }
    const res = await moveStock(getAccessToken, item.id, body)
    if (res.kind !== 'ok') return setError(opsError(t, res.error))
    setError(null)
    setQty('')
    setExtra('')
    await load()
    onChanged()
  }

  return (
    <div className="record-detail">
      {canManage && item.active && (
        <div className="inline-form">
          <select
            className="input input--sm"
            value={type}
            onChange={(e) => setType(e.target.value as typeof type)}
            aria-label={t('ops.inventory.movement')}
          >
            {(['receive', 'issue', 'adjust', 'transfer'] as const).map((x) => (
              <option key={x} value={x}>
                {t(`ops.stock.${x}` as TranslationKey)}
              </option>
            ))}
          </select>
          <input
            className="input input--sm"
            style={{ maxWidth: 80 }}
            inputMode="numeric"
            placeholder={type === 'adjust' ? '±' : t('ops.inventory.qty')}
            aria-label={t('ops.inventory.qty')}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
          />
          {type === 'receive' && (
            <select
              className="input input--sm"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              aria-label={t('ops.suppliers')}
            >
              <option value="">{t('ops.inventory.noSupplier')}</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          {type === 'transfer' && (
            <select
              className="input input--sm"
              value={toBranch}
              onChange={(e) => setToBranch(e.target.value)}
              aria-label={t('ops.asset.transferTo')}
            >
              <option value="">{t('ops.asset.transferTo')}</option>
              {branches
                .filter((b) => b.id !== item.branchId)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
            </select>
          )}
          <input
            className="input input--sm"
            style={{ flex: 1, minWidth: 140 }}
            placeholder={t(`ops.stock.${type}.extra` as TranslationKey)}
            aria-label={t(`ops.stock.${type}.extra` as TranslationKey)}
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
          />
          <button type="button" className="btn btn--sm btn--primary" onClick={() => void submit()}>
            {t('ops.inventory.record')}
          </button>
        </div>
      )}
      {error && <p className="login__error">{error}</p>}
      <table className="table">
        <tbody>
          {moves.map((m) => (
            <tr key={m.id}>
              <td className="docs__meta">{new Date(m.createdAt).toLocaleDateString()}</td>
              <td>{t(`ops.stock.${m.type}` as TranslationKey)}</td>
              <td className="mono">{m.quantity > 0 ? `+${m.quantity}` : m.quantity}</td>
              <td className="mono">= {m.balance}</td>
              <td className="card__hint">{[m.supplierName, m.issuedTo, m.reference, m.note].filter(Boolean).join(' · ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ------------------------------------------------------------- facilities --

function FacilitiesTab() {
  const { t } = useI18n()
  const { getAccessToken, can } = useAuth()
  const { activeBranchId } = useApp()
  const roomTypes = useLookup('roomType')
  const { buildings, rooms, reload } = useRooms()
  const [building, setBuilding] = useState({ name: '', floors: '' })
  const [room, setRoom] = useState({ buildingId: '', name: '', typeCode: '', capacity: '' })
  const [error, setError] = useState<string | null>(null)
  const canManage = can('ops.facilities.manage')

  const addBuilding = async () => {
    if (!activeBranchId || !building.name.trim()) return
    const res = await createBuilding(getAccessToken, {
      branchId: activeBranchId,
      name: building.name.trim(),
      floors: building.floors ? Number(building.floors) : null,
    })
    if (res.kind !== 'ok') return setError(opsError(t, res.error))
    setBuilding({ name: '', floors: '' })
    await reload()
  }
  const addRoom = async () => {
    const buildingId = room.buildingId || buildings[0]?.id
    if (!buildingId || !room.name.trim()) return
    const res = await createRoom(getAccessToken, {
      buildingId,
      name: room.name.trim(),
      typeCode: room.typeCode || roomTypes.active[0]?.code,
      capacity: room.capacity ? Number(room.capacity) : null,
    })
    if (res.kind !== 'ok') return setError(opsError(t, res.error))
    setRoom({ ...room, name: '', capacity: '' })
    await reload()
  }

  return (
    <>
      {error && <p className="login__error">{error}</p>}
      {buildings.length === 0 && <div className="empty-state">{t('ops.facilities.none')}</div>}
      <div className="card-row">
        {buildings.map((b) => (
          <section key={b.id} className="card">
            <h2 className="card__title">
              {b.name}
              {b.floors && <span className="card__hint"> · {t('ops.facilities.floors', { n: b.floors })}</span>}
            </h2>
            {rooms
              .filter((r) => r.buildingId === b.id)
              .map((r) => (
                <div key={r.id} className="stat-row" style={r.active ? undefined : { opacity: 0.55 }}>
                  <span>
                    {r.name}
                    <span className="card__hint"> · {roomTypes.label(r.typeCode)}</span>
                  </span>
                  <span className="mono">{r.capacity ?? '—'}</span>
                </div>
              ))}
          </section>
        ))}
      </div>
      {canManage && activeBranchId && (
        <section className="card">
          <h2 className="card__title">{t('ops.facilities.add')}</h2>
          <div className="inline-form">
            <input
              className="input input--sm"
              placeholder={t('ops.facilities.building')}
              aria-label={t('ops.facilities.building')}
              value={building.name}
              onChange={(e) => setBuilding({ ...building, name: e.target.value })}
            />
            <input
              className="input input--sm"
              style={{ maxWidth: 90 }}
              inputMode="numeric"
              placeholder={t('ops.facilities.floorsLabel')}
              aria-label={t('ops.facilities.floorsLabel')}
              value={building.floors}
              onChange={(e) => setBuilding({ ...building, floors: e.target.value })}
            />
            <button type="button" className="btn btn--sm" onClick={() => void addBuilding()}>
              {t('ops.facilities.addBuilding')}
            </button>
          </div>
          {buildings.length > 0 && (
            <div className="inline-form">
              <select
                className="input input--sm"
                value={room.buildingId}
                onChange={(e) => setRoom({ ...room, buildingId: e.target.value })}
                aria-label={t('ops.facilities.building')}
              >
                {buildings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              <input
                className="input input--sm"
                placeholder={t('ops.col.room')}
                aria-label={t('ops.col.room')}
                value={room.name}
                onChange={(e) => setRoom({ ...room, name: e.target.value })}
              />
              <select
                className="input input--sm"
                value={room.typeCode}
                onChange={(e) => setRoom({ ...room, typeCode: e.target.value })}
                aria-label={t('ops.col.category')}
              >
                {roomTypes.active.map((c) => (
                  <option key={c.code} value={c.code}>
                    {roomTypes.label(c.code)}
                  </option>
                ))}
              </select>
              <input
                className="input input--sm"
                style={{ maxWidth: 90 }}
                inputMode="numeric"
                placeholder={t('ops.facilities.capacity')}
                aria-label={t('ops.facilities.capacity')}
                value={room.capacity}
                onChange={(e) => setRoom({ ...room, capacity: e.target.value })}
              />
              <button type="button" className="btn btn--sm" onClick={() => void addRoom()}>
                {t('ops.facilities.addRoom')}
              </button>
            </div>
          )}
        </section>
      )}
    </>
  )
}

// ------------------------------------------------------------ maintenance --

function MaintenanceTab() {
  const { t, lang } = useI18n()
  const { getAccessToken, can, user } = useAuth()
  const { activeBranchId } = useApp()
  const { rooms } = useRooms()
  const [status, setStatus] = useState('active')
  const [rows, setRows] = useState<MaintenanceRequest[] | null>(null)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [f, setF] = useState({ title: '', roomId: '', priority: 'normal', description: '' })
  const [resolving, setResolving] = useState<{ id: string; resolution: string; cost: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const manager = can('ops.facilities.manage')

  const load = useCallback(async () => {
    const res = await listMaintenance(getAccessToken, { branchId: activeBranchId ?? undefined, status: status || undefined })
    setRows(res.kind === 'ok' ? res.data : [])
  }, [getAccessToken, activeBranchId, status])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (manager && can('hr.read'))
      void listEmployees(getAccessToken, { branchId: activeBranchId ?? undefined, status: 'active' }).then(
        (r) => r.kind === 'ok' && setEmployees(r.data),
      )
  }, [getAccessToken, activeBranchId, manager, can])

  const report = async () => {
    if (!activeBranchId || f.title.trim().length < 3) return setError(t('ops.error.title'))
    const res = await reportMaintenance(getAccessToken, {
      branchId: activeBranchId,
      title: f.title.trim(),
      roomId: f.roomId || null,
      priority: f.priority,
      description: f.description.trim() || null,
    })
    if (res.kind !== 'ok') return setError(opsError(t, res.error))
    setError(null)
    setF({ title: '', roomId: '', priority: 'normal', description: '' })
    await load()
  }
  const update = async (id: string, body: Record<string, unknown>) => {
    const res = await updateMaintenance(getAccessToken, id, body)
    if (res.kind !== 'ok') return setError(opsError(t, res.error))
    setError(null)
    setResolving(null)
    await load()
  }

  return (
    <>
      {can('ops.maintenance.report') && activeBranchId && (
        <section className="card">
          <h2 className="card__title">{t('ops.maintenance.report')}</h2>
          <div className="inline-form">
            <input
              className="input input--sm"
              style={{ flex: 1, minWidth: 200 }}
              placeholder={t('ops.maintenance.what')}
              aria-label={t('ops.maintenance.what')}
              value={f.title}
              onChange={(e) => setF({ ...f, title: e.target.value })}
            />
            <select
              className="input input--sm"
              value={f.roomId}
              onChange={(e) => setF({ ...f, roomId: e.target.value })}
              aria-label={t('ops.col.room')}
            >
              <option value="">{t('ops.noRoom')}</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <select
              className="input input--sm"
              value={f.priority}
              onChange={(e) => setF({ ...f, priority: e.target.value })}
              aria-label={t('ops.maintenance.priority')}
            >
              {(['low', 'normal', 'high', 'urgent'] as const).map((p) => (
                <option key={p} value={p}>
                  {t(`ops.priority.${p}` as TranslationKey)}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn--sm btn--primary" onClick={() => void report()}>
              {t('ops.maintenance.send')}
            </button>
          </div>
        </section>
      )}
      <section className="card">
        <div className="card__head">
          <select className="input input--sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('ops.col.status')}>
            <option value="active">{t('ops.maintenance.active')}</option>
            {(['open', 'in_progress', 'resolved', 'closed', 'cancelled'] as const).map((s) => (
              <option key={s} value={s}>
                {t(`ops.maint.status.${s}` as TranslationKey)}
              </option>
            ))}
            <option value="">{t('parents.filter.allStatuses')}</option>
          </select>
        </div>
        {error && <p className="login__error">{error}</p>}
        {rows === null ? (
          <div className="skeleton" style={{ height: 100 }} />
        ) : rows.length === 0 ? (
          <div className="empty-state">{t('ops.maintenance.none')}</div>
        ) : (
          <ul className="record-list">
            {rows.map((m) => (
              <li key={m.id} className="record-list__item">
                <div className="record-list__row">
                  <span className="record-list__main" style={{ cursor: 'default' }}>
                    <span className="mono">{m.requestNumber}</span> · <b>{m.title}</b>
                    <span className="card__hint">
                      {' '}
                      —{' '}
                      {[
                        m.roomName,
                        m.assetName,
                        m.assignedToName && t('ops.maintenance.assignee', { name: m.assignedToName }),
                        new Date(m.createdAt).toLocaleDateString(lang),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <span className={`chip ${PRIORITY_TONE[m.priority]}`}>{t(`ops.priority.${m.priority}` as TranslationKey)}</span>
                  <span className={`chip ${MAINT_TONE[m.status]}`}>{t(`ops.maint.status.${m.status}` as TranslationKey)}</span>
                </div>
                {m.resolution && (
                  <p className="card__hint">
                    {t('ops.maintenance.resolution', { text: m.resolution })}
                    {m.cost !== null && ` · ${formatMinorUnits(m.cost)}`}
                  </p>
                )}
                {manager && (m.status === 'open' || m.status === 'in_progress' || m.status === 'resolved') && (
                  <div className="inline-form">
                    {employees.length > 0 && m.status !== 'resolved' && (
                      <select
                        className="input input--sm"
                        value={m.assignedToEmployeeId ?? ''}
                        onChange={(e) => void update(m.id, { assignedToEmployeeId: e.target.value || null })}
                        aria-label={t('ops.maintenance.assign')}
                      >
                        <option value="">{t('ops.maintenance.unassigned')}</option>
                        {employees.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.fullName}
                          </option>
                        ))}
                      </select>
                    )}
                    {m.status === 'open' && (
                      <button type="button" className="btn btn--sm" onClick={() => void update(m.id, { status: 'in_progress' })}>
                        {t('ops.maintenance.start')}
                      </button>
                    )}
                    {m.status !== 'resolved' && (
                      <button type="button" className="btn btn--sm" onClick={() => setResolving({ id: m.id, resolution: '', cost: '' })}>
                        {t('ops.maintenance.resolve')}
                      </button>
                    )}
                    {m.status === 'resolved' && (
                      <button type="button" className="btn btn--sm" onClick={() => void update(m.id, { status: 'closed' })}>
                        {t('ops.maintenance.close')}
                      </button>
                    )}
                    {m.status !== 'resolved' && (
                      <button type="button" className="btn btn--sm btn--ghost" onClick={() => void update(m.id, { status: 'cancelled' })}>
                        {t('ops.maintenance.cancel')}
                      </button>
                    )}
                  </div>
                )}
                {!manager && m.status === 'open' && m.reportedBy === user?.id && (
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => void update(m.id, { status: 'cancelled' })}>
                    {t('ops.maintenance.cancel')}
                  </button>
                )}
                {resolving?.id === m.id && (
                  <div className="inline-form">
                    <input
                      className="input input--sm"
                      style={{ flex: 1, minWidth: 180 }}
                      placeholder={t('ops.maintenance.whatDone')}
                      aria-label={t('ops.maintenance.whatDone')}
                      value={resolving.resolution}
                      onChange={(e) => setResolving({ ...resolving, resolution: e.target.value })}
                    />
                    <input
                      className="input input--sm"
                      style={{ maxWidth: 100 }}
                      inputMode="decimal"
                      placeholder={t('ops.asset.cost')}
                      aria-label={t('ops.asset.cost')}
                      value={resolving.cost}
                      onChange={(e) => setResolving({ ...resolving, cost: e.target.value })}
                    />
                    <button
                      type="button"
                      className="btn btn--sm btn--primary"
                      onClick={() =>
                        void update(m.id, {
                          status: 'resolved',
                          resolution: resolving.resolution.trim(),
                          ...(resolving.cost.trim() ? { cost: parseMinorUnits(resolving.cost) ?? 0 } : {}),
                        })
                      }
                    >
                      {t('ops.maintenance.resolve')}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
