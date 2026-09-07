import type { PlacedLesson } from '../lib/view'
import { subjectHue } from '../lib/view'
import type { Dimension } from '../lib/view'

interface Props {
  placed: PlacedLesson
  /** Which field is already implied by the current view, so it can be omitted. */
  dimension: Dimension
  flagged: boolean
  dimmed: boolean
  onSelect: (lessonId: string) => void
}

export function LessonCard({ placed, dimension, flagged, dimmed, onSelect }: Props) {
  const { lesson, room } = placed

  const secondary =
    dimension === 'studentGroup'
      ? lesson.teacher
      : dimension === 'teacher'
        ? lesson.studentGroup
        : `${lesson.studentGroup} · ${lesson.teacher}`

  const tertiary = dimension === 'room' ? lesson.id : (room?.name ?? 'No room')

  return (
    <button
      type="button"
      className={`lesson${flagged ? ' lesson--flagged' : ''}${dimmed ? ' lesson--dim' : ''}`}
      style={{ ['--h' as string]: subjectHue(lesson.subject) }}
      onClick={() => onSelect(lesson.id)}
      title={`${lesson.id} · ${lesson.subject} · ${lesson.teacher} · ${lesson.studentGroup}${
        room ? ` · ${room.name}` : ''
      }`}
    >
      <span className="lesson__subject">
        {lesson.subject}
        {lesson.doublePeriod && <span className="lesson__badge">2P</span>}
        {lesson.pinnedTimeslotId && (
          <span className="lesson__badge" aria-hidden="true">
            🔒
          </span>
        )}
      </span>
      <span className="lesson__line">{secondary}</span>
      <span className="lesson__line">{tertiary}</span>
    </button>
  )
}
