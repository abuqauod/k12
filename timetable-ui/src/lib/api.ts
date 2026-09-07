import type { Problem, Room, Solution, Timeslot } from '../domain/types'
import { englishMessage } from '../i18n/translations'

/**
 * The wire contract the scheduling backend speaks. Mirrors the response the
 * solver service returns so the same payload can be replayed or posted.
 */
export interface ApiTimetableRow {
  lesson_id: string
  subject: string
  teacher: string
  student_group: string
  assigned_timeslot: Timeslot | null
  assigned_room: Pick<Room, 'id' | 'name'> | null
}

export interface ApiResponse {
  status: 'SUCCESS' | 'INFEASIBLE'
  unresolved_violations_count: number
  timetable: ApiTimetableRow[]
  errors?: Array<{ code: string; message: string; lesson_ids: string[] }>
}

export function toApiResponse(problem: Problem, solution: Solution): ApiResponse {
  const slotById = new Map(problem.timeslots.map((slot) => [slot.id, slot]))
  const roomById = new Map(problem.rooms.map((room) => [room.id, room]))
  const lessonById = new Map(problem.lessons.map((lesson) => [lesson.id, lesson]))

  const timetable: ApiTimetableRow[] = solution.assignments.map((assignment) => {
    const lesson = lessonById.get(assignment.lessonId)
    const slot = assignment.timeslotId ? slotById.get(assignment.timeslotId) : undefined
    const room = assignment.roomId ? roomById.get(assignment.roomId) : undefined
    return {
      lesson_id: assignment.lessonId,
      subject: lesson?.subject ?? '',
      teacher: lesson?.teacher ?? '',
      student_group: lesson?.studentGroup ?? '',
      assigned_timeslot: slot ?? null,
      assigned_room: room ? { id: room.id, name: room.name } : null,
    }
  })

  const hardViolations = solution.violations.filter((v) => v.level === 'HARD')

  const response: ApiResponse = {
    status: solution.status === 'SUCCESS' ? 'SUCCESS' : 'INFEASIBLE',
    unresolved_violations_count: hardViolations.reduce((sum, v) => sum + v.penalty, 0),
    timetable,
  }

  if (hardViolations.length > 0) {
    // The wire payload stays English so downstream consumers see stable text.
    response.errors = hardViolations.map((violation) => ({
      code: violation.constraint,
      message: englishMessage(violation.messageKey, violation.messageParams),
      lesson_ids: violation.lessonIds,
    }))
  }

  return response
}

/** Serialises the editable inputs so a problem can be saved and reloaded. */
export function toProblemPayload(problem: Problem) {
  return {
    calendar: problem.calendar,
    timeslots: problem.timeslots,
    rooms: problem.rooms,
    lessons: problem.lessons,
    unavailability: problem.unavailability,
    weights: problem.weights,
  }
}

export function download(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
