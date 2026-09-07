/* Remove the Calendar tab from the timetable sidebar; Settings owns it now. */
const fs = require('fs')
let misses = 0
const edit = (path, pairs) => {
  let s = fs.readFileSync(path, 'utf8')
  for (const [a, b] of pairs) {
    if (!s.includes(a)) {
      console.error(`MISS ${path}: ` + JSON.stringify(a.slice(0, 70)))
      misses++
      continue
    }
    s = s.replace(a, b)
  }
  fs.writeFileSync(path, s)
}

// ---- cut CalendarTab out of DataPanel ------------------------------------
let s = fs.readFileSync('src/components/DataPanel.tsx', 'utf8')
const start = s.indexOf('/* ----------------------------------------------------------------- calendar */')
const end = s.indexOf('/* ---------------------------------------------------------------- timeslots */')
if (start < 0 || end < 0 || end < start) {
  console.error('CalendarTab anchors not found')
  process.exit(1)
}
s = s.slice(0, start) + s.slice(end)
fs.writeFileSync('src/components/DataPanel.tsx', s)

edit('src/components/DataPanel.tsx', [
  [
    "type Tab = 'lessons' | 'calendar' | 'timeslots' | 'rooms' | 'availability'",
    "type Tab = 'lessons' | 'timeslots' | 'rooms' | 'availability'",
  ],
  ["  { id: 'calendar', key: 'panel.calendar' },\n", ''],
  ['    calendar: problem.calendar.breaks.length,\n', ''],
  ["      {tab === 'calendar' && <CalendarTab problem={problem} onChange={onChange} />}\n", ''],
  // imports the calendar tab owned
  [
    "import { applyCalendar, breakAt, schoolDays } from '../domain/calendar'\n",
    '',
  ],
  [
    "import { SchoolWeekFields, clampNumber as clamp } from './SchoolWeekFields'\n",
    '',
  ],
  [
    "import type { BreakRule, ConstraintWeights, DayOfWeek, Problem, Solution } from '../domain/types'",
    "import type { DayOfWeek, Problem, Solution } from '../domain/types'",
  ],
  [
    "import type { BreakRule, DayOfWeek, Problem, Solution } from '../domain/types'",
    "import type { DayOfWeek, Problem, Solution } from '../domain/types'",
  ],
])

// ---- Settings owns the whole calendar ------------------------------------
edit('src/pages/SettingsPage.tsx', [
  [
    "import { RoutingRulesEditor } from '../components/RoutingRules'",
    "import { RoutingRulesEditor } from '../components/RoutingRules'\nimport { BreaksEditor } from '../components/BreaksEditor'",
  ],
])

let settings = fs.readFileSync('src/pages/SettingsPage.tsx', 'utf8')
const calStart = settings.indexOf('function CalendarSettingsTab() {')
const calEnd = settings.indexOf('/* --------------------------------------------------------------- transport */')
if (calStart < 0 || calEnd < 0) {
  console.error('CalendarSettingsTab anchors not found')
  process.exit(1)
}
settings =
  settings.slice(0, calStart) +
  `function CalendarSettingsTab() {
  const { t } = useI18n()
  const { problem, setProblem } = useApp()

  return (
    <div className="card-row">
      <section className="card">
        <h2 className="card__title">{t('calendar.weekTitle')}</h2>
        <SchoolWeekFields problem={problem} onChange={setProblem} />
      </section>

      <section className="card">
        <h2 className="card__title">{t('calendar.breaks')}</h2>
        <BreaksEditor />
      </section>
    </div>
  )
}

` +
  settings.slice(calEnd)
fs.writeFileSync('src/pages/SettingsPage.tsx', settings)

if (misses) process.exit(1)
console.log('calendar tab moved to settings')
