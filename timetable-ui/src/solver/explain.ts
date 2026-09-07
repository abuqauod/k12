import type { CompiledModel } from './model'
import type { Score, Violation } from '../domain/types'
import { breakAt } from '../domain/calendar'

const hhmm = (time: string) => time.slice(0, 5)

/**
 * Human-readable justification for every broken constraint. Runs once per
 * solution (not in the search loop), so clarity beats raw speed here.
 *
 * Messages are emitted as a translation key plus parameters; the UI renders
 * them in the active language and `api.ts` renders the English form.
 */
export function explain(
  model: CompiledModel,
  ts: Int32Array,
  rm: Int32Array,
): { violations: Violation[]; score: Score } {
  const { lessons, timeslots, rooms, weights } = model.problem
  const violations: Violation[] = []
  let hard = 0
  let soft = 0

  const slotParams = (index: number) => ({
    dayToken: timeslots[index].dayOfWeek,
    time: hhmm(timeslots[index].startTime),
  })

  const bucket = <K>(keyOf: (i: number) => K | null) => {
    const map = new Map<K, number[]>()
    for (let i = 0; i < lessons.length; i++) {
      const key = keyOf(i)
      if (key === null) continue
      const list = map.get(key)
      if (list) list.push(i)
      else map.set(key, [i])
    }
    return map
  }

  const assigned = (i: number) => ts[i] >= 0 && rm[i] >= 0

  // ---- HARD ---------------------------------------------------------------
  const clash = (
    constraint: Violation['constraint'],
    map: Map<string, number[]>,
    describe: (members: number[]) => { key: string; params: Record<string, string | number> },
  ) => {
    for (const members of map.values()) {
      if (members.length < 2) continue
      const penalty = (members.length * (members.length - 1)) / 2
      hard -= penalty
      const { key, params } = describe(members)
      violations.push({
        constraint,
        level: 'HARD',
        penalty,
        messageKey: key,
        messageParams: params,
        lessonIds: members.map((i) => lessons[i].id),
      })
    }
  }

  clash(
    'ROOM_CONFLICT',
    bucket((i) => (assigned(i) ? `${ts[i]}|${rm[i]}` : null)),
    (members) => ({
      key: 'msg.roomConflict',
      params: {
        room: rooms[rm[members[0]]].name,
        ids: members.map((i) => lessons[i].id).join(', '),
        ...slotParams(ts[members[0]]),
      },
    }),
  )

  clash(
    'TEACHER_CONFLICT',
    bucket((i) => (assigned(i) ? `${ts[i]}|${lessons[i].teacher}` : null)),
    (members) => ({
      key: 'msg.teacherConflict',
      params: {
        teacher: lessons[members[0]].teacher,
        count: members.length,
        ...slotParams(ts[members[0]]),
      },
    }),
  )

  clash(
    'STUDENT_GROUP_CONFLICT',
    bucket((i) => (assigned(i) ? `${ts[i]}|${lessons[i].studentGroup}` : null)),
    (members) => ({
      key: 'msg.groupConflict',
      params: {
        group: lessons[members[0]].studentGroup,
        count: members.length,
        ...slotParams(ts[members[0]]),
      },
    }),
  )

  const blockedSet = new Set(
    model.problem.unavailability.map((u) => `${u.teacher}|${u.timeslotId}`),
  )

  for (let i = 0; i < lessons.length; i++) {
    const lesson = lessons[i]
    if (!assigned(i)) {
      hard -= 1
      violations.push({
        constraint: 'ROOM_CONFLICT',
        level: 'HARD',
        penalty: 1,
        messageKey: 'msg.unplaced',
        messageParams: { id: lesson.id, subject: lesson.subject },
        lessonIds: [lesson.id],
      })
      continue
    }
    if (blockedSet.has(`${lesson.teacher}|${timeslots[ts[i]].id}`)) {
      hard -= 1
      violations.push({
        constraint: 'TEACHER_UNAVAILABLE',
        level: 'HARD',
        penalty: 1,
        messageKey: 'msg.teacherUnavailable',
        messageParams: { teacher: lesson.teacher, id: lesson.id, ...slotParams(ts[i]) },
        lessonIds: [lesson.id],
      })
    }
    const reserved = breakAt(model.problem.calendar, lesson.studentGroup, model.tsPeriod[ts[i]])
    if (reserved) {
      hard -= 1
      violations.push({
        constraint: 'COHORT_BREAK',
        level: 'HARD',
        penalty: 1,
        messageKey: 'msg.cohortBreak',
        messageParams: {
          group: lesson.studentGroup,
          breakName: reserved.name,
          id: lesson.id,
          ...slotParams(ts[i]),
        },
        lessonIds: [lesson.id],
      })
    }
    const capacity = rooms[rm[i]].capacity
    if (
      capacity !== undefined &&
      lesson.studentCount !== undefined &&
      lesson.studentCount > capacity
    ) {
      hard -= 1
      violations.push({
        constraint: 'ROOM_CAPACITY',
        level: 'HARD',
        penalty: 1,
        messageKey: 'msg.roomCapacity',
        messageParams: {
          room: rooms[rm[i]].name,
          capacity,
          group: lesson.studentGroup,
          count: lesson.studentCount,
        },
        lessonIds: [lesson.id],
      })
    }
  }

  // ---- SOFT ---------------------------------------------------------------
  const periodsOf = (members: number[]) =>
    [...new Set(members.map((i) => model.tsPeriod[ts[i]]))].sort((a, b) => a - b)

  const gapCount = (periods: number[]) =>
    periods.length === 0 ? 0 : periods[periods.length - 1] - periods[0] + 1 - periods.length

  const byTeacherDay = bucket((i) =>
    assigned(i) ? `${lessons[i].teacher}|${model.tsDay[ts[i]]}` : null,
  )
  for (const [key, members] of byTeacherDay) {
    const [teacher] = key.split('|')
    const dayToken = timeslots[ts[members[0]]].dayOfWeek
    const gaps = gapCount(periodsOf(members))
    if (gaps > 0) {
      const penalty = gaps * weights.teacherContinuity
      soft -= penalty
      violations.push({
        constraint: 'TEACHER_CONTINUITY',
        level: 'SOFT',
        penalty,
        messageKey: gaps === 1 ? 'msg.teacherGaps.one' : 'msg.teacherGaps.other',
        messageParams: { teacher, gaps, dayToken },
        lessonIds: members.map((i) => lessons[i].id),
      })
    }
    const roomsUsed = new Set(members.map((i) => rm[i])).size
    if (roomsUsed > 1) {
      const penalty = (roomsUsed - 1) * weights.teacherRoomStability
      soft -= penalty
      violations.push({
        constraint: 'TEACHER_ROOM_STABILITY',
        level: 'SOFT',
        penalty,
        messageKey: 'msg.teacherRooms',
        messageParams: { teacher, rooms: roomsUsed, dayToken },
        lessonIds: members.map((i) => lessons[i].id),
      })
    }
  }

  const byGroupDay = bucket((i) =>
    assigned(i) ? `${lessons[i].studentGroup}|${model.tsDay[ts[i]]}` : null,
  )
  const periods = model.problem.calendar.periodsPerDay
  for (const [key, members] of byGroupDay) {
    const [group] = key.split('|')
    const dayToken = timeslots[ts[members[0]]].dayOfWeek
    // A period the cohort has reserved as its break is not an idle gap.
    const reservedPeriods: number[] = []
    for (let period = 0; period < periods; period++) {
      if (breakAt(model.problem.calendar, group, period)) reservedPeriods.push(period)
    }
    const gaps = gapCount(
      [...new Set([...periodsOf(members), ...reservedPeriods])].sort((a, b) => a - b),
    )
    if (gaps > 0) {
      const penalty = gaps * weights.studentContinuity
      soft -= penalty
      violations.push({
        constraint: 'STUDENT_CONTINUITY',
        level: 'SOFT',
        penalty,
        messageKey: gaps === 1 ? 'msg.studentGaps.one' : 'msg.studentGaps.other',
        messageParams: { group, gaps, dayToken },
        lessonIds: members.map((i) => lessons[i].id),
      })
    }
    const roomsUsed = new Set(members.map((i) => rm[i])).size
    if (roomsUsed > 1) {
      const penalty = (roomsUsed - 1) * weights.studentRoomStability
      soft -= penalty
      violations.push({
        constraint: 'STUDENT_ROOM_STABILITY',
        level: 'SOFT',
        penalty,
        messageKey: 'msg.groupRooms',
        messageParams: { group, rooms: roomsUsed, dayToken },
        lessonIds: members.map((i) => lessons[i].id),
      })
    }
  }

  const bySubjectDay = bucket((i) =>
    assigned(i)
      ? `${lessons[i].studentGroup}|${lessons[i].subject}|${model.tsDay[ts[i]]}`
      : null,
  )
  for (const [key, members] of bySubjectDay) {
    if (members.length < 2) continue
    const [group, subject] = key.split('|')
    const sorted = [...members].sort((a, b) => model.tsPeriod[ts[a]] - model.tsPeriod[ts[b]])
    let paired = 0
    for (let k = 0; k < sorted.length - 1; k++) {
      const a = sorted[k]
      const b = sorted[k + 1]
      const adjacent = model.tsPeriod[ts[b]] - model.tsPeriod[ts[a]] === 1
      if (adjacent && lessons[a].doublePeriod && lessons[b].doublePeriod) paired++
    }
    const penalised = members.length - 1 - paired
    if (penalised > 0) {
      const penalty = penalised * weights.subjectDistribution
      soft -= penalty
      violations.push({
        constraint: 'SUBJECT_DISTRIBUTION',
        level: 'SOFT',
        penalty,
        messageKey: 'msg.subjectRepeat',
        messageParams: {
          group,
          subject,
          count: members.length,
          dayToken: timeslots[ts[members[0]]].dayOfWeek,
        },
        lessonIds: members.map((i) => lessons[i].id),
      })
    }
  }

  violations.sort((a, b) =>
    a.level === b.level ? b.penalty - a.penalty : a.level === 'HARD' ? -1 : 1,
  )

  return { violations, score: { hard, soft } }
}
