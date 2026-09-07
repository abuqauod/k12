/**
 * Domain model — mirrors the Optaplanner "School Timetabling" entity classes.
 *
 *  Timeslot  -> planning value
 *  Room      -> planning value
 *  Lesson    -> planning entity (variables: timeslot, room)
 */

export const DAYS_OF_WEEK = [
  'SUNDAY',
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
] as const

export type DayOfWeek = (typeof DAYS_OF_WEEK)[number]

/** Planning value. `startTime` / `endTime` use the "00:00:00" wire format. */
export interface Timeslot {
  id: string
  dayOfWeek: DayOfWeek
  startTime: string
  endTime: string
}

/** Planning value. */
export interface Room {
  id: string
  name: string
  /** Optional capacity metadata — checked against `Lesson.studentCount`. */
  capacity?: number
}

/** Tier tags let the UI group KG / elementary / middle / high school cohorts. */
export type Tier = 'KG' | 'ELEMENTARY' | 'MIDDLE' | 'HIGH'

/** Planning entity. */
export interface Lesson {
  id: string
  subject: string
  teacher: string
  /** "KG1-A" | "Grade 4-B" | "Grade 11-Science" — free-form across all tiers. */
  studentGroup: string
  tier?: Tier
  studentCount?: number
  /** Exempts the lesson from the subject-distribution penalty when paired. */
  doublePeriod?: boolean
  /** Pre-assigned (locked) values — the solver will not move these. */
  pinnedTimeslotId?: string
  pinnedRoomId?: string
}

/** `teacher` is unavailable during `timeslotId`. */
export interface Unavailability {
  teacher: string
  timeslotId: string
}

/**
 * A break in the school day. Two kinds, because a shared grid cannot express
 * them the same way:
 *
 *  CLOCK  — real minutes inserted after a period for the whole school. No
 *           teaching slot is consumed; later periods simply start later.
 *           This is morning recess.
 *  PERIOD — a teaching period reserved as a break for specific cohorts. The
 *           slot still exists (other cohorts teach through it), but the listed
 *           cohorts can never be scheduled in it. This is staggered lunch, and
 *           it is what lets each class have its own break.
 */
export interface BreakRule {
  id: string
  name: string
  kind: 'CLOCK' | 'PERIOD'
  /** 1-based. CLOCK: the break follows this period. PERIOD: this period IS the break. */
  period: number
  /** CLOCK only — length of the gap. */
  minutes: number
  /** PERIOD only — cohorts on break. Empty means every cohort. */
  studentGroups: string[]
}

/** Shape of the school week. Regenerates `Problem.timeslots` when edited. */
export interface Calendar {
  /** First teaching day. Sunday–Thursday and Monday–Friday weeks both work. */
  weekStart: DayOfWeek
  schoolDays: number
  /** "08:30:00" — when period 1 begins. */
  dayStart: string
  periodMinutes: number
  periodsPerDay: number
  breaks: BreakRule[]
}

export interface ConstraintWeights {
  teacherContinuity: number
  studentContinuity: number
  subjectDistribution: number
  teacherRoomStability: number
  studentRoomStability: number
}

export const DEFAULT_WEIGHTS: ConstraintWeights = {
  teacherContinuity: 2,
  studentContinuity: 1,
  subjectDistribution: 3,
  teacherRoomStability: 1,
  studentRoomStability: 2,
}

export interface Problem {
  calendar: Calendar
  timeslots: Timeslot[]
  rooms: Room[]
  lessons: Lesson[]
  unavailability: Unavailability[]
  weights: ConstraintWeights
}

export interface Assignment {
  lessonId: string
  timeslotId: string | null
  roomId: string | null
}

/** Optaplanner HardSoftScore. Both members are <= 0; 0hard/0soft is perfect. */
export interface Score {
  hard: number
  soft: number
}

export type ConstraintId =
  | 'ROOM_CONFLICT'
  | 'TEACHER_CONFLICT'
  | 'STUDENT_GROUP_CONFLICT'
  | 'TEACHER_UNAVAILABLE'
  | 'COHORT_BREAK'
  | 'ROOM_CAPACITY'
  | 'TEACHER_CONTINUITY'
  | 'STUDENT_CONTINUITY'
  | 'SUBJECT_DISTRIBUTION'
  | 'TEACHER_ROOM_STABILITY'
  | 'STUDENT_ROOM_STABILITY'

export interface Violation {
  constraint: ConstraintId
  level: 'HARD' | 'SOFT'
  penalty: number
  /**
   * Translation key plus its substitutions, rather than a baked sentence, so
   * the same violation renders in any UI language. `dayToken` (when present)
   * holds a `DayOfWeek` that the renderer localises into `{day}`.
   */
  messageKey: string
  messageParams: Record<string, string | number>
  lessonIds: string[]
}

export type SolveStatus = 'SUCCESS' | 'INFEASIBLE' | 'IDLE'

export interface Solution {
  status: SolveStatus
  score: Score
  assignments: Assignment[]
  violations: Violation[]
  /** Solver telemetry. */
  stats: { iterations: number; elapsedMs: number; restarts: number }
}

export const CONSTRAINT_META: Record<
  ConstraintId,
  { label: string; level: 'HARD' | 'SOFT'; description: string }
> = {
  ROOM_CONFLICT: {
    label: 'Room conflict',
    level: 'HARD',
    description: 'A room hosts at most one lesson per timeslot.',
  },
  TEACHER_CONFLICT: {
    label: 'Teacher conflict',
    level: 'HARD',
    description: 'A teacher teaches at most one lesson per timeslot.',
  },
  STUDENT_GROUP_CONFLICT: {
    label: 'Student group conflict',
    level: 'HARD',
    description: 'A student group attends at most one lesson per timeslot.',
  },
  TEACHER_UNAVAILABLE: {
    label: 'Teacher unavailable',
    level: 'HARD',
    description: 'A teacher is never scheduled inside a blocked timeslot.',
  },
  COHORT_BREAK: {
    label: 'Cohort break',
    level: 'HARD',
    description: 'A cohort is never taught during a period reserved as its break.',
  },
  ROOM_CAPACITY: {
    label: 'Room capacity',
    level: 'HARD',
    description: 'Room capacity must cover the cohort size.',
  },
  TEACHER_CONTINUITY: {
    label: 'Teacher continuity',
    level: 'SOFT',
    description: 'Minimise idle gaps inside a teacher’s working day.',
  },
  STUDENT_CONTINUITY: {
    label: 'Student continuity',
    level: 'SOFT',
    description: 'Minimise idle gaps inside a cohort’s day.',
  },
  SUBJECT_DISTRIBUTION: {
    label: 'Subject distribution',
    level: 'SOFT',
    description: 'Spread a subject across the week unless it is a double period.',
  },
  TEACHER_ROOM_STABILITY: {
    label: 'Teacher room stability',
    level: 'SOFT',
    description: 'Keep a teacher in as few rooms per day as possible.',
  },
  STUDENT_ROOM_STABILITY: {
    label: 'Cohort room stability',
    level: 'SOFT',
    description:
      'Keep a cohort in one room per day — the rule that holds KG classes in their block.',
  },
}
