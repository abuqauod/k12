import { useCallback, useRef } from 'react'

interface Props {
  /** Current width of the panel this splitter resizes, in px. */
  value: number
  min: number
  max: number
  onChange: (next: number) => void
  /** Reset target for a double-click. */
  defaultValue: number
  /**
   * True when dragging toward the inline-end should shrink the panel — the
   * case for a panel on the right, and mirrored again under RTL.
   */
  invert?: boolean
  label: string
}

const KEY_STEP = 16

/**
 * A draggable divider between two workspace columns.
 *
 * Pointer capture keeps the drag alive when the cursor outruns the 6px handle,
 * and the caller clamps the result, so a panel can never be dragged past the
 * point where the timetable stops being readable.
 */
export function Splitter({ value, min, max, onChange, defaultValue, invert, label }: Props) {
  const origin = useRef<{ x: number; width: number } | null>(null)

  const clamp = useCallback((next: number) => Math.min(max, Math.max(min, next)), [min, max])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    origin.current = { x: event.clientX, width: value }
    event.currentTarget.setPointerCapture(event.pointerId)
    document.body.classList.add('is-resizing')
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = origin.current
    if (!start) return
    const rtl = document.documentElement.dir === 'rtl'
    const direction = (invert ? -1 : 1) * (rtl ? -1 : 1)
    onChange(clamp(start.width + (event.clientX - start.x) * direction))
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!origin.current) return
    origin.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    document.body.classList.remove('is-resizing')
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const rtl = document.documentElement.dir === 'rtl'
    const direction = (invert ? -1 : 1) * (rtl ? -1 : 1)
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onChange(clamp(value - KEY_STEP * direction))
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      onChange(clamp(value + KEY_STEP * direction))
    } else if (event.key === 'Home') {
      event.preventDefault()
      onChange(defaultValue)
    }
  }

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onChange(defaultValue)}
    >
      <span className="splitter__grip" aria-hidden="true" />
    </div>
  )
}
