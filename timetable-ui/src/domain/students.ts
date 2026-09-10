import { sampleFleet } from './fleet'

/**
 * Transport registration. The morning and afternoon runs carry different
 * passengers, so this is not a flag — it decides which of the two solves a
 * student contributes demand to.
 */
export type TransportMode = 'TWO_WAY' | 'MORNING' | 'EVENING' | 'NONE'

export type RunDirection = 'MORNING' | 'EVENING'

export type StudentStatus = 'enrolled' | 'graduated' | 'withdrawn' | 'inquiry'

export interface Guardian {
  name: string
  relationship: string
  phone: string
  secondaryPhone: string | null
  email: string | null
  /** The contact a school calls first — at most one guardian should have
   * this set (checked where a guardian list is edited, not here). */
  isPrimary: boolean
}

export interface Student {
  id: string
  studentNumber: string
  givenName: string
  familyName: string
  givenNameAr?: string
  familyNameAr?: string
  /** Links to the timetable cohort, so the two modules share one roll. */
  studentGroup: string
  /** Where this student boards. Empty means not yet placed on a route. */
  stopId: string
  transportMode: TransportMode
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

/* ------------------------------------------------------------------ sample */

const GIVEN = [
  ['Omar', 'عمر'], ['Layla', 'ليلى'], ['Yousef', 'يوسف'], ['Sara', 'سارة'],
  ['Ahmad', 'أحمد'], ['Noor', 'نور'], ['Karim', 'كريم'], ['Dana', 'دانا'],
  ['Tariq', 'طارق'], ['Rania', 'رانيا'], ['Zaid', 'زيد'], ['Maha', 'مها'],
]
const FAMILY = [
  ['Haddad', 'حداد'], ['Nasser', 'ناصر'], ['Khalil', 'خليل'], ['Masri', 'المصري'],
  ['Odeh', 'عودة'], ['Salti', 'الصلتي'], ['Rimawi', 'الريماوي'], ['Zaben', 'الزبن'],
]
const COHORTS = [
  'KG1-A', 'KG2-A', 'Grade 4-A', 'Grade 4-B', 'Grade 8-A', 'Grade 11-Science',
]

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const phone = (random: () => number) =>
  `+962 7${Math.floor(random() * 3) + 7} ${String(Math.floor(random() * 900) + 100)} ${String(
    Math.floor(random() * 9000) + 1000,
  )}`

/**
 * One student per seat the demo stops implied, so the registry and the routing
 * agree from the first load. Modes are mixed because a real school always has
 * children who only ride one way.
 */
export function sampleStudents(): Student[] {
  const random = mulberry32(0x2b0d)
  const fleet = sampleFleet()
  const students: Student[] = []
  let n = 1

  for (const stop of fleet.stops) {
    for (let i = 0; i < stop.studentCount; i++) {
      const [given, givenAr] = GIVEN[Math.floor(random() * GIVEN.length)]!
      const [family, familyAr] = FAMILY[Math.floor(random() * FAMILY.length)]!
      const roll = random()
      const mode: TransportMode = roll < 0.72 ? 'TWO_WAY' : roll < 0.88 ? 'MORNING' : 'EVENING'

      students.push({
        id: `S-${String(n).padStart(4, '0')}`,
        studentNumber: `2026${String(n).padStart(4, '0')}`,
        givenName: given!,
        familyName: family!,
        givenNameAr: givenAr,
        familyNameAr: familyAr,
        studentGroup: COHORTS[Math.floor(random() * COHORTS.length)]!,
        stopId: stop.id,
        transportMode: mode,
        primaryPhone: phone(random),
        secondaryPhone: phone(random),
        active: true,
      })
      n++
    }
  }

  return students
}
