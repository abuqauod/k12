import { haversineKm } from './fleet'
import type { BusStop } from './fleet'

/**
 * Transport registration. The morning and afternoon runs carry different
 * passengers, so this is not a flag — it decides which of the two solves a
 * student contributes demand to.
 */
export type TransportMode = 'TWO_WAY' | 'MORNING' | 'EVENING' | 'NONE'

export type RunDirection = 'MORNING' | 'EVENING'

export type StudentStatus = 'enrolled' | 'graduated' | 'withdrawn' | 'inquiry'

export type GuardianLanguage = 'en' | 'ar'

export interface Guardian {
  /** Stable id from the server; absent only on a guardian the form just
   * added and hasn't saved yet. */
  id?: string
  name: string
  relationship: string
  phone: string
  secondaryPhone: string | null
  email: string | null
  /** The contact a school calls first — a display hint, not how notification
   * recipients are chosen. */
  isPrimary: boolean
  /** Language this guardian's absence notifications are written in. */
  preferredLanguage: GuardianLanguage
  /** Per-channel opt-in — a guardian with neither is never messaged. */
  notifyByEmail: boolean
  notifyBySms: boolean
  /** A former guardian kept for history; excluded from notifications. */
  active: boolean
}

/** A blank guardian for the "add" button. */
export function emptyGuardian(): Guardian {
  return {
    name: '',
    relationship: 'guardian',
    phone: '',
    secondaryPhone: null,
    email: null,
    isPrimary: false,
    preferredLanguage: 'en',
    notifyByEmail: true,
    notifyBySms: false,
    active: true,
  }
}

export interface Student {
  id: string
  studentNumber: string
  givenName: string
  familyName: string
  givenNameAr?: string
  familyNameAr?: string
  /** Links to the timetable cohort, so the two modules share one roll. On a
   * server-backed record this is derived from the class and kept in step
   * with it — `${gradeLevel} ${name}`. */
  studentGroup: string
  /** The campus and homeroom this student belongs to. Optional only so the
   * bundled sample (transport-only, pre-SIS) still parses; a record from the
   * server always carries both. */
  branchId?: string
  classId?: string
  /** The active enrollment's academic year — read-only, follows the class. */
  academicYearId?: string
  /** Where this student boards. Empty means not yet placed on a route. */
  stopId: string
  transportMode: TransportMode
  /** The student's own pickup point — set by placing a pin on the map
   * (StudentDetailDialog / RoutesPage), independent of `stopId`. Undefined on
   * records saved before this existed; treat the same as null. */
  lat?: number | null
  lng?: number | null
  /** Required. The number called first if the bus is delayed. */
  primaryPhone: string
  /** Required. A second contactable adult — one number is a single point of failure. */
  secondaryPhone: string
  active: boolean
  // ---------------------------------------------------------------- SIS —
  // Optional so the transport-only shape this type started as still parses;
  // real records from the server always carry these.
  dob?: string | null
  gender?: 'male' | 'female' | null
  status?: StudentStatus
  admissionDate?: string | null
  address?: string | null
  medicalNotes?: string | null
  guardians?: Guardian[]
}

/** Does this student ride on the given run? */
export function ridesOn(student: Student, direction: RunDirection): boolean {
  if (!student.active) return false
  if (student.transportMode === 'TWO_WAY') return true
  return student.transportMode === direction
}

export const TRANSPORT_MODES: TransportMode[] = ['TWO_WAY', 'MORNING', 'EVENING', 'NONE']

/**
 * Accepts the shapes people actually type: +962 7X XXX XXXX, 07X XXX XXXX,
 * spaces, dashes or none. Deliberately loose on formatting, strict on having
 * enough digits to be a real number.
 */
export function isValidPhone(value: string): boolean {
  const digits = value.replace(/[^\d]/g, '')
  return digits.length >= 8 && digits.length <= 15
}

export interface StudentIssue {
  studentId: string
  field: 'primaryPhone' | 'secondaryPhone' | 'stopId' | 'duplicatePhone'
}

/** Everything the registry considers incomplete, for the "needs attention" list. */
export function auditStudents(students: Student[]): StudentIssue[] {
  const issues: StudentIssue[] = []
  for (const student of students) {
    if (!student.active) continue
    if (!isValidPhone(student.primaryPhone)) {
      issues.push({ studentId: student.id, field: 'primaryPhone' })
    }
    if (!isValidPhone(student.secondaryPhone)) {
      issues.push({ studentId: student.id, field: 'secondaryPhone' })
    } else if (
      student.secondaryPhone.replace(/\D/g, '') === student.primaryPhone.replace(/\D/g, '')
    ) {
      // A duplicate second number defeats the point of having one.
      issues.push({ studentId: student.id, field: 'duplicatePhone' })
    }
    if (student.transportMode !== 'NONE' && !student.stopId) {
      issues.push({ studentId: student.id, field: 'stopId' })
    }
  }
  return issues
}

/** Per-stop demand for one direction — what the routing solver consumes. */
export function demandByStop(
  students: Student[],
  direction: RunDirection,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const student of students) {
    if (!ridesOn(student, direction) || !student.stopId) continue
    counts.set(student.stopId, (counts.get(student.stopId) ?? 0) + 1)
  }
  return counts
}

/* ------------------------------------------------------- stop <-> pin link */
// A student's own map pin (lat/lng) and their assigned stopId are captured
// independently and can drift apart — wrong stop picked, a family moved, a
// mis-placed pin. This section makes that drift visible (RoutesPage's
// "needs review" panel) and, for outliers, gives the VRP solver a way to
// route directly to the student instead of forcing them onto a stop that
// doesn't reflect where they actually are.

/**
 * Not a walkability policy (how far a child may reasonably walk to any
 * stop) — an anomaly threshold for "this pin doesn't look like it belongs
 * to this stop". 500m sits just above the tightest common walk-zone norm
 * (~400m/0.25mi for elementary), so it won't flag routine pin-placement
 * imprecision or a student a short block past their nominal stop, but does
 * flag a pin that's clearly in a different neighbourhood. Overridable per
 * branch via `FleetSettings.outlierThresholdMeters`.
 */
export const DEFAULT_OUTLIER_THRESHOLD_M = 500

/** Id prefix for a synthetic single-student `BusStop` built by
 * `buildDoorToDoorStops` — lets UI code tell a door-to-door node from a
 * real stop with a cheap `.startsWith()` check. */
export const DOOR_TO_DOOR_PREFIX = 'S2S:'

/** Straight-line distance from a student's own pin to a stop, in meters —
 * `null` if the student has no pin or the stop is unknown. */
export function studentStopDistanceMeters(
  student: Student,
  stop: BusStop | undefined,
): number | null {
  if (student.lat == null || student.lng == null || !stop) return null
  return haversineKm({ lat: student.lat, lng: student.lng }, stop) * 1000
}

export type StopLinkStatus = 'MATCHED' | 'OUTLIER' | 'UNASSIGNED_WITH_PIN' | 'NO_LOCATION'

export interface StopLink {
  studentId: string
  status: StopLinkStatus
  stopId: string | null
  distanceM: number | null
  nearestStopId: string | null
  nearestDistanceM: number | null
}

/** How a student's own pin relates to their assigned stop, if any. */
export function computeStopLink(
  student: Student,
  stopById: Map<string, BusStop>,
  allStops: BusStop[],
  thresholdM: number,
): StopLink {
  if (student.lat == null || student.lng == null) {
    return {
      studentId: student.id,
      status: 'NO_LOCATION',
      stopId: student.stopId || null,
      distanceM: null,
      nearestStopId: null,
      nearestDistanceM: null,
    }
  }

  const point = { lat: student.lat, lng: student.lng }
  let nearestStopId: string | null = null
  let nearestDistanceM: number | null = null
  for (const stop of allStops) {
    const d = haversineKm(point, stop) * 1000
    if (nearestDistanceM === null || d < nearestDistanceM) {
      nearestDistanceM = d
      nearestStopId = stop.id
    }
  }

  const assignedStop = student.stopId ? stopById.get(student.stopId) : undefined
  if (!assignedStop) {
    return {
      studentId: student.id,
      status: 'UNASSIGNED_WITH_PIN',
      stopId: null,
      distanceM: null,
      nearestStopId,
      nearestDistanceM,
    }
  }

  const distanceM = haversineKm(point, assignedStop) * 1000
  return {
    studentId: student.id,
    status: distanceM > thresholdM ? 'OUTLIER' : 'MATCHED',
    stopId: assignedStop.id,
    distanceM,
    nearestStopId,
    nearestDistanceM,
  }
}

/** Active, transport-registered students whose pin doesn't match their
 * stop (or has none) — worst mismatch first. This is the "needs review"
 * list; direction-independent, since a pin/stop mismatch doesn't change
 * between the morning and evening run. */
export function findOutliers(students: Student[], stops: BusStop[], thresholdM: number): StopLink[] {
  const stopById = new Map(stops.map((s) => [s.id, s]))
  const links: StopLink[] = []
  for (const student of students) {
    if (!student.active || student.transportMode === 'NONE') continue
    const link = computeStopLink(student, stopById, stops, thresholdM)
    if (link.status === 'OUTLIER' || link.status === 'UNASSIGNED_WITH_PIN') links.push(link)
  }
  return links.sort((a, b) => (b.distanceM ?? 0) - (a.distanceM ?? 0))
}

/**
 * The stops/demand arrays actually handed to the VRP solver for one
 * direction: real stops keep their aggregate demand from every `MATCHED`
 * rider (or every rider, unchanged from today's `demandByStop`, when
 * `doorToDoorEnabled` is false), and each outlier rider becomes their own
 * synthetic demand-1 stop the solver can route to directly. `solve.ts`
 * needs no changes for this — a `BusStop`-shaped node with `studentCount:1`
 * is not a special case anywhere in the solver; see the PR description for
 * the trace confirming that.
 */
export function buildDoorToDoorStops(
  stops: BusStop[],
  students: Student[],
  direction: RunDirection,
  thresholdM: number,
  doorToDoorEnabled: boolean,
): { stops: BusStop[]; demand: number[] } {
  const stopById = new Map(stops.map((s) => [s.id, s]))
  const counts = new Map<string, number>()
  const doorToDoor: BusStop[] = []

  for (const student of students) {
    if (!ridesOn(student, direction) || !student.stopId) continue
    if (!doorToDoorEnabled) {
      counts.set(student.stopId, (counts.get(student.stopId) ?? 0) + 1)
      continue
    }
    const link = computeStopLink(student, stopById, stops, thresholdM)
    if (link.status === 'OUTLIER') {
      doorToDoor.push({
        id: `${DOOR_TO_DOOR_PREFIX}${student.id}`,
        name: `${student.givenName} ${student.familyName}`.trim(),
        lat: student.lat!,
        lng: student.lng!,
        studentCount: 1,
        pinnedBusId: null,
        studentId: student.id,
      })
    } else {
      counts.set(student.stopId, (counts.get(student.stopId) ?? 0) + 1)
    }
  }

  // Every real stop stays in the array, in its original order, at its
  // original index — even a zero-demand one — exactly matching today's
  // `demandByStop`-based behavior (RoutesPage.tsx previously did
  // `fleet.stops.map((stop) => counts.get(stop.id) ?? 0)`). Only the counts
  // themselves change: an outlier's demand has moved to their synthetic
  // node instead of their old stop.
  const allStops = [...stops, ...doorToDoor]
  const demand = allStops.map((stop) => (stop.studentId ? 1 : (counts.get(stop.id) ?? 0)))
  return { stops: allStops, demand }
}

