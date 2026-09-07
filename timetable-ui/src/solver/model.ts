import type { Problem } from '../domain/types'
import { weekOrder } from '../domain/calendar'

/**
 * A `Problem` flattened into integer-indexed typed arrays so the search loop
 * never touches strings or object properties.
 */
export interface CompiledModel {
  L: number
  T: number
  R: number
  teacherCount: number
  groupCount: number
  subjectCount: number
  dayCount: number
  periodCount: number

  lessonTeacher: Int32Array
  lessonGroup: Int32Array
  lessonSubject: Int32Array
  lessonSize: Int32Array
  lessonDouble: Uint8Array
  pinnedTimeslot: Int32Array
  pinnedRoom: Int32Array

  tsDay: Int32Array
  tsPeriod: Int32Array
  roomCapacity: Int32Array
  /** teacherIndex * T + timeslotIndex -> 1 when blocked. */
  blocked: Uint8Array
  /** groupIndex * T + timeslotIndex -> 1 when the cohort is on break. */
  groupBlocked: Uint8Array
  /** groupIndex -> bitmask of periods reserved as that cohort's break. */
  groupBreakMask: Uint32Array

  teachers: string[]
  groups: string[]
  subjects: string[]
  /** Day index -> ordered timeslot indices. */
  dayTimeslots: number[][]

  problem: Problem
  /** False when a day exceeds 32 periods; bitmask soft constraints then bail. */
  maskSafe: boolean
  roomMaskSafe: boolean
}

function indexer() {
  const map = new Map<string, number>()
  const list: string[] = []
  return {
    id(value: string): number {
      let i = map.get(value)
      if (i === undefined) {
        i = list.length
        map.set(value, i)
        list.push(value)
      }
      return i
    },
    list,
    map,
  }
}

export function compile(problem: Problem): CompiledModel {
  const { timeslots, rooms, lessons, unavailability } = problem
  const L = lessons.length
  const T = timeslots.length
  const R = rooms.length

  const teacherIdx = indexer()
  const groupIdx = indexer()
  const subjectIdx = indexer()

  const lessonTeacher = new Int32Array(L)
  const lessonGroup = new Int32Array(L)
  const lessonSubject = new Int32Array(L)
  const lessonSize = new Int32Array(L)
  const lessonDouble = new Uint8Array(L)
  const pinnedTimeslot = new Int32Array(L).fill(-1)
  const pinnedRoom = new Int32Array(L).fill(-1)

  const tsById = new Map(timeslots.map((t, i) => [t.id, i]))
  const roomById = new Map(rooms.map((r, i) => [r.id, i]))

  for (let i = 0; i < L; i++) {
    const lesson = lessons[i]
    lessonTeacher[i] = teacherIdx.id(lesson.teacher)
    lessonGroup[i] = groupIdx.id(lesson.studentGroup)
    lessonSubject[i] = subjectIdx.id(lesson.subject)
    lessonSize[i] = lesson.studentCount ?? -1
    lessonDouble[i] = lesson.doublePeriod ? 1 : 0
    if (lesson.pinnedTimeslotId) pinnedTimeslot[i] = tsById.get(lesson.pinnedTimeslotId) ?? -1
    if (lesson.pinnedRoomId) pinnedRoom[i] = roomById.get(lesson.pinnedRoomId) ?? -1
  }

  // Day / period coordinates: timeslots are ordered by start time inside a day.
  const usedDays = weekOrder(problem.calendar.weekStart).filter((d) =>
    timeslots.some((t) => t.dayOfWeek === d),
  )
  const dayCount = usedDays.length
  const tsDay = new Int32Array(T)
  const tsPeriod = new Int32Array(T)
  const dayTimeslots: number[][] = []

  usedDays.forEach((day, dayIndex) => {
    const ordered = timeslots
      .map((t, i) => ({ t, i }))
      .filter(({ t }) => t.dayOfWeek === day)
      .sort((a, b) => a.t.startTime.localeCompare(b.t.startTime))
    dayTimeslots.push(ordered.map(({ i }) => i))
    ordered.forEach(({ i }, period) => {
      tsDay[i] = dayIndex
      tsPeriod[i] = period
    })
  })

  const periodCount = dayTimeslots.reduce((max, slots) => Math.max(max, slots.length), 0)

  const roomCapacity = new Int32Array(R)
  for (let i = 0; i < R; i++) roomCapacity[i] = rooms[i].capacity ?? -1

  const blocked = new Uint8Array(Math.max(1, teacherIdx.list.length * T))
  for (const entry of unavailability) {
    const t = teacherIdx.map.get(entry.teacher)
    const s = tsById.get(entry.timeslotId)
    if (t !== undefined && s !== undefined) blocked[t * T + s] = 1
  }

  // PERIOD breaks reserve a slot for the cohorts they cover. An empty
  // studentGroups list means the break applies to the whole school.
  const groupBlocked = new Uint8Array(Math.max(1, groupIdx.list.length * T))
  const groupBreakMask = new Uint32Array(Math.max(1, groupIdx.list.length))
  for (const rule of problem.calendar.breaks) {
    if (rule.kind !== 'PERIOD') continue
    const targets =
      rule.studentGroups.length > 0
        ? rule.studentGroups.map((group) => groupIdx.map.get(group))
        : groupIdx.list.map((_, index) => index)
    for (const g of targets) {
      if (g !== undefined && rule.period <= 32) groupBreakMask[g] |= 1 << (rule.period - 1)
    }
    for (let s = 0; s < T; s++) {
      if (tsPeriod[s] !== rule.period - 1) continue
      for (const g of targets) {
        if (g !== undefined) groupBlocked[g * T + s] = 1
      }
    }
  }

  return {
    L,
    T,
    R,
    teacherCount: teacherIdx.list.length,
    groupCount: groupIdx.list.length,
    subjectCount: subjectIdx.list.length,
    dayCount,
    periodCount,
    lessonTeacher,
    lessonGroup,
    lessonSubject,
    lessonSize,
    lessonDouble,
    pinnedTimeslot,
    pinnedRoom,
    tsDay,
    tsPeriod,
    roomCapacity,
    blocked,
    groupBlocked,
    groupBreakMask,
    teachers: teacherIdx.list,
    groups: groupIdx.list,
    subjects: subjectIdx.list,
    dayTimeslots,
    problem,
    maskSafe: periodCount <= 32,
    roomMaskSafe: R <= 32,
  }
}
