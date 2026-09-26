import type { TokenGetter } from './http'
import { api, enc, pick, qs } from './apiClient'

/** Client for `/ops/*` (SAMS Phase 5). Money is minor units. */

type G = TokenGetter

// ------------------------------------------------------------------ assets
export type AssetStatus = 'in_stock' | 'assigned' | 'maintenance' | 'disposed'
export interface Asset {
  id: string
  assetTag: string
  name: string
  categoryCode: string
  branchId: string
  roomId: string | null
  roomName: string | null
  serialNumber: string | null
  vendorId: string | null
  purchaseDate: string | null
  purchaseCost: number | null
  warrantyUntil: string | null
  status: AssetStatus
  assignedTo: { type: 'employee' | 'room'; id: string } | null
  assignedToName: string | null
  notes: string | null
  disposedAt: string | null
  disposalReason: string | null
  history?: { id: string; type: string; date: string; from: string | null; to: string | null; note: string | null; cost: number | null }[]
}
export const listAssets = (g: G, p: { branchId?: string; status?: string; categoryCode?: string; q?: string } = {}) =>
  pick(api<{ assets: Asset[] }>(g, 'GET', `/ops/assets${qs(p)}`), 'assets')
export const getAsset = (g: G, id: string) => api<Asset>(g, 'GET', `/ops/assets/${enc(id)}`)
export const createAsset = (g: G, body: Record<string, unknown>) => api<Asset>(g, 'POST', '/ops/assets', body)
export const assetStep = (
  g: G,
  id: string,
  step: 'assign' | 'return' | 'maintenance' | 'transfer' | 'dispose',
  body: Record<string, unknown>,
) => api<Asset>(g, 'POST', `/ops/assets/${enc(id)}/${step}`, body)

// --------------------------------------------------------------- inventory
export interface InventoryItem {
  id: string
  branchId: string
  sku: string
  name: string
  unit: string
  categoryCode: string
  reorderLevel: number
  quantity: number
  lowStock: boolean
  active: boolean
}
export interface StockMovement {
  id: string
  type: 'receive' | 'issue' | 'adjust' | 'transfer_out' | 'transfer_in'
  quantity: number
  balance: number
  supplierName: string | null
  unitCost: number | null
  reference: string | null
  issuedTo: string | null
  note: string | null
  createdAt: string
}
export interface Supplier {
  id: string
  name: string
  contactName: string | null
  phone: string | null
  email: string | null
}
export const listItems = (g: G, p: { branchId?: string; lowStock?: boolean; q?: string } = {}) =>
  pick(api<{ items: InventoryItem[] }>(g, 'GET', `/ops/inventory/items${qs(p)}`), 'items')
export const createItem = (g: G, body: Record<string, unknown>) => api<InventoryItem>(g, 'POST', '/ops/inventory/items', body)
export const itemMovements = (g: G, id: string) =>
  api<{ item: InventoryItem; movements: StockMovement[] }>(g, 'GET', `/ops/inventory/items/${enc(id)}/movements`)
export const moveStock = (g: G, id: string, body: Record<string, unknown>) =>
  api<{ movement: StockMovement; item: InventoryItem }>(g, 'POST', `/ops/inventory/items/${enc(id)}/movements`, body)
export const listSuppliers = (g: G) => pick(api<{ suppliers: Supplier[] }>(g, 'GET', '/ops/suppliers'), 'suppliers')
export const createSupplier = (g: G, body: { name: string; phone?: string | null; contactName?: string | null }) =>
  api<Supplier>(g, 'POST', '/ops/suppliers', body)

// -------------------------------------------------------------- facilities
export interface Building {
  id: string
  branchId: string
  name: string
  code: string | null
  floors: number | null
  active: boolean
}
export interface Room {
  id: string
  branchId: string
  buildingId: string
  name: string
  code: string | null
  typeCode: string
  capacity: number | null
  floor: number | null
  active: boolean
}
export type MaintenanceStatus = 'open' | 'in_progress' | 'resolved' | 'closed' | 'cancelled'
export interface MaintenanceRequest {
  id: string
  requestNumber: string
  branchId: string
  roomId: string | null
  roomName: string | null
  assetId: string | null
  assetName: string | null
  title: string
  description: string | null
  priority: 'low' | 'normal' | 'high' | 'urgent'
  status: MaintenanceStatus
  assignedToEmployeeId: string | null
  assignedToName: string | null
  reportedBy: string
  resolution: string | null
  cost: number | null
  createdAt: string
}
export const listFacilities = (g: G, branchId?: string) =>
  api<{ buildings: Building[]; rooms: Room[] }>(g, 'GET', `/ops/facilities${qs({ branchId })}`)
export const createBuilding = (g: G, body: Record<string, unknown>) => api<Building>(g, 'POST', '/ops/buildings', body)
export const createRoom = (g: G, body: Record<string, unknown>) => api<Room>(g, 'POST', '/ops/rooms', body)
export const updateRoom = (g: G, id: string, body: Record<string, unknown>) => api<Room>(g, 'PATCH', `/ops/rooms/${enc(id)}`, body)
export const listMaintenance = (g: G, p: { branchId?: string; status?: string; assetId?: string } = {}) =>
  pick(api<{ requests: MaintenanceRequest[] }>(g, 'GET', `/ops/maintenance${qs(p)}`), 'requests')
export const reportMaintenance = (g: G, body: Record<string, unknown>) => api<MaintenanceRequest>(g, 'POST', '/ops/maintenance', body)
export const updateMaintenance = (g: G, id: string, body: Record<string, unknown>) =>
  api<MaintenanceRequest>(g, 'PATCH', `/ops/maintenance/${enc(id)}`, body)

// --------------------------------------------------------------- transport
export interface Driver {
  id: string
  branchId: string
  employeeId: string | null
  name: string
  phone: string | null
  licenseNumber: string | null
  licenseExpiry: string | null
  busId: string | null
  active: boolean
}
export interface FleetBus {
  id: string
  branchId: string
  name: string
  seats: number
  plateNumber: string | null
  registrationExpiry: string | null
  insuranceExpiry: string | null
  inspectionExpiry: string | null
  attendantName: string | null
  drivers: Driver[]
}
export interface ComplianceItem {
  kind: string
  ownerType: 'bus' | 'driver'
  ownerId: string
  name: string
  expiresAt: string
  expired: boolean
}
export const listFleet = (g: G, branchId?: string) =>
  pick(api<{ buses: FleetBus[] }>(g, 'GET', `/ops/transport/buses${qs({ branchId })}`), 'buses')
export const saveBusDetails = (g: G, id: string, body: Record<string, unknown>) =>
  api<unknown>(g, 'PUT', `/ops/transport/buses/${enc(id)}/details`, body)
export const listDrivers = (g: G, branchId?: string) =>
  pick(api<{ drivers: Driver[] }>(g, 'GET', `/ops/transport/drivers${qs({ branchId })}`), 'drivers')
export const createDriver = (g: G, body: Record<string, unknown>) => api<Driver>(g, 'POST', '/ops/transport/drivers', body)
export const updateDriver = (g: G, id: string, body: Record<string, unknown>) =>
  api<Driver>(g, 'PATCH', `/ops/transport/drivers/${enc(id)}`, body)
export const compliance = (g: G, branchId?: string) =>
  api<{ asOf: string; items: ComplianceItem[]; busesWithoutDetails: { busId: string; name: string }[] }>(
    g,
    'GET',
    `/ops/transport/compliance${qs({ branchId })}`,
  )
export const transportFees = (g: G, branchId: string, academicYearId: string) =>
  api<{ fee: { id: string; twoWay: number; oneWay: number } | null; riders: { twoWay: number; oneWay: number } }>(
    g,
    'GET',
    `/ops/transport/fees${qs({ branchId, academicYearId })}`,
  )
export const setTransportFees = (g: G, body: { branchId: string; academicYearId: string; twoWay: number; oneWay: number }) =>
  api<{ twoWay: number; oneWay: number }>(g, 'PUT', '/ops/transport/fees', body)
export const billTransport = (g: G, body: { branchId: string; academicYearId: string }) =>
  api<{ charged: number; alreadyCharged: number; noInvoice: string[] }>(g, 'POST', '/ops/transport/fees/bill', body)

// ----------------------------------------------------------------- library
export interface Book {
  id: string
  title: string
  author: string | null
  isbn: string | null
  publisher: string | null
  year: number | null
  categoryCode: string | null
  language: string | null
  copies: { id: string; barcode: string; branchId: string; shelf: string | null; status: string }[]
  available: number
}
export interface Loan {
  id: string
  title: string | null
  barcode: string | null
  borrowerType: 'student' | 'employee'
  borrowerId: string
  borrowerName: string | null
  loanedAt: string
  dueDate: string
  returnedAt: string | null
  lostAt: string | null
  renewals: number
  overdue: boolean
  fine: number
  fineStatus: 'none' | 'due' | 'paid' | 'waived' | 'billed'
}
export interface LibrarySettings {
  loanDays: number
  maxLoans: number
  maxRenewals: number
  finePerDay: number
  lostFee: number
}
export const listBooks = (g: G, p: { q?: string; branchId?: string } = {}) =>
  pick(api<{ books: Book[] }>(g, 'GET', `/ops/library/books${qs(p)}`), 'books')
export const createBook = (g: G, body: Record<string, unknown>) => api<Book>(g, 'POST', '/ops/library/books', body)
export const addCopy = (g: G, bookId: string, body: { branchId: string; barcode: string; shelf: string | null }) =>
  api<unknown>(g, 'POST', `/ops/library/books/${enc(bookId)}/copies`, body)
export const listLoans = (g: G, p: { branchId?: string; view?: string; borrowerId?: string } = {}) =>
  pick(api<{ loans: Loan[] }>(g, 'GET', `/ops/library/loans${qs(p)}`), 'loans')
export const lend = (g: G, body: { barcode: string; borrowerType: 'student' | 'employee'; borrowerId: string }) =>
  api<Loan>(g, 'POST', '/ops/library/loans', body)
export const loanAction = (g: G, id: string, action: 'return' | 'renew' | 'lost' | 'pay' | 'waive' | 'bill', body: Record<string, unknown> = {}) =>
  api<Loan>(g, 'POST', `/ops/library/loans/${enc(id)}/${action}`, body)
/** SAMS 11.3: the borrower on a scanned ID card. */
export const borrowerByCard = (g: G, card: string) =>
  api<{ type: 'student' | 'employee'; id: string; name: string; branchId: string; maxLoans: number; loans: Loan[] }>(g, 'GET', `/ops/library/borrower${qs({ card })}`)
export const returnByBarcode = (g: G, barcode: string) => api<Loan>(g, 'POST', '/ops/library/return-by-barcode', { barcode })
export const notifyOverdue = (g: G, body: { branchId?: string } = {}) =>
  api<{ loans: number; families: number }>(g, 'POST', '/ops/library/overdue/notify', body)
export const librarySettings = (g: G) => api<LibrarySettings>(g, 'GET', '/ops/library/settings')
export const saveLibrarySettings = (g: G, body: LibrarySettings) => api<LibrarySettings>(g, 'PUT', '/ops/library/settings', body)

// ------------------------------------------------------------------ events
export type EventStatus = 'draft' | 'open' | 'closed' | 'cancelled' | 'completed'
export interface SchoolEvent {
  id: string
  branchId: string
  title: string
  titleAr: string | null
  typeCode: string
  description: string | null
  location: string | null
  startDate: string
  endDate: string
  capacity: number | null
  registrationDeadline: string | null
  fee: number | null
  gradeLevels: string[]
  status: EventStatus
  costs: { id: string; label: string; amount: number }[]
  registered: number
  waitlisted: number
  attended: number
  placesLeft: number | null
  budget: { income: number; costs: number; net: number }
  registrations?: {
    id: string
    studentId: string
    studentName: string | null
    studentNumber: string | null
    status: 'registered' | 'waitlisted'
    attended: boolean | null
  }[]
}
export const listEvents = (g: G, p: { branchId?: string; status?: string; upcoming?: boolean } = {}) =>
  pick(api<{ events: SchoolEvent[] }>(g, 'GET', `/ops/events${qs(p)}`), 'events')
export const getEvent = (g: G, id: string) => api<SchoolEvent>(g, 'GET', `/ops/events/${enc(id)}`)
export const createEvent = (g: G, body: Record<string, unknown>) => api<SchoolEvent>(g, 'POST', '/ops/events', body)
export const updateEvent = (g: G, id: string, body: Record<string, unknown>) => api<SchoolEvent>(g, 'PATCH', `/ops/events/${enc(id)}`, body)
export const setEventStatus = (g: G, id: string, status: EventStatus) =>
  api<SchoolEvent>(g, 'POST', `/ops/events/${enc(id)}/status`, { status })
export const setEventCosts = (g: G, id: string, costs: { label: string; amount: number }[]) =>
  api<SchoolEvent>(g, 'PUT', `/ops/events/${enc(id)}/costs`, { costs })
export const registerForEvent = (g: G, id: string, studentId: string) =>
  api<{ id: string; status: string }>(g, 'POST', `/ops/events/${enc(id)}/registrations`, { studentId })
export const cancelRegistration = (g: G, id: string, regId: string) =>
  api<{ promoted: number }>(g, 'POST', `/ops/events/${enc(id)}/registrations/${enc(regId)}/cancel`, {})
export const markEventAttendance = (g: G, id: string, records: { registrationId: string; attended: boolean }[]) =>
  api<{ saved: number }>(g, 'PUT', `/ops/events/${enc(id)}/attendance`, { records })
export const billEvent = (g: G, id: string, academicYearId: string) =>
  api<{ charged: number; alreadyCharged: number; noInvoice: string[] }>(g, 'POST', `/ops/events/${enc(id)}/bill`, { academicYearId })
