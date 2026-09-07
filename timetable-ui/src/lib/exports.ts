import type { Problem, Solution } from '../domain/types'
import { placeLessons } from './view'

/** Excel opens UTF-8 CSV correctly only when it starts with a BOM. */
const BOM = '﻿'

function cell(value: string | number | undefined): string {
  const text = value === undefined || value === null ? '' : String(value)
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * One row per lesson, in the order the week runs. Opens directly in Excel and
 * pivots easily by cohort, teacher or room.
 */
export function timetableToCsv(problem: Problem, solution: Solution | null): string {
  const placed = placeLessons(problem, solution)
    .slice()
    .sort((a, b) => {
      if (!a.timeslot) return 1
      if (!b.timeslot) return -1
      return (
        a.timeslot.dayOfWeek.localeCompare(b.timeslot.dayOfWeek) ||
        a.period - b.period ||
        a.lesson.studentGroup.localeCompare(b.lesson.studentGroup)
      )
    })

  const header = [
    'lesson_id',
    'day',
    'period',
    'start',
    'end',
    'subject',
    'teacher',
    'student_group',
    'room',
    'double_period',
    'locked',
    'room_required',
  ]

  const rows = placed.map((item) =>
    [
      item.lesson.id,
      item.timeslot?.dayOfWeek ?? '',
      item.period >= 0 ? item.period + 1 : '',
      item.timeslot?.startTime.slice(0, 5) ?? '',
      item.timeslot?.endTime.slice(0, 5) ?? '',
      item.lesson.subject,
      item.lesson.teacher,
      item.lesson.studentGroup,
      item.room?.name ?? '',
      item.lesson.doublePeriod ? 'yes' : '',
      item.lesson.pinnedTimeslotId ? 'yes' : '',
      item.lesson.pinnedRoomId ? 'yes' : '',
    ]
      .map(cell)
      .join(','),
  )

  return BOM + [header.join(','), ...rows].join('\r\n')
}

export function downloadCsv(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}
