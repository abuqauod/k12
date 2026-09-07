import type { Calendar, Lesson, Problem, Room, Tier, Timeslot, Unavailability } from './types'
import { DEFAULT_WEIGHTS } from './types'
import { generateTimeslots, schoolDays } from './calendar'

/**
 * A worked K-12 dataset spanning every tier the model supports: KG homerooms,
 * elementary cohorts with rotating specialists, a middle-school cohort and a
 * high-school stream. Used as the default problem the app boots with.
 *
 * The week runs Sunday–Thursday with a morning recess and a staggered lunch:
 * the younger cohorts break at period 5, the older ones at period 6.
 */
export const SAMPLE_CALENDAR: Calendar = {
  weekStart: 'SUNDAY',
  schoolDays: 5,
  dayStart: '08:30:00',
  periodMinutes: 45,
  periodsPerDay: 8,
  breaks: [
    {
      id: 'BR-RECESS',
      name: 'Morning recess',
      kind: 'CLOCK',
      period: 3,
      minutes: 20,
      studentGroups: [],
    },
    {
      id: 'BR-LUNCH-EARLY',
      name: 'Lunch (lower school)',
      kind: 'PERIOD',
      period: 5,
      minutes: 0,
      studentGroups: ['KG1-A', 'KG2-A', 'Grade 4-A', 'Grade 4-B'],
    },
    {
      id: 'BR-LUNCH-LATE',
      name: 'Lunch (upper school)',
      kind: 'PERIOD',
      period: 6,
      minutes: 0,
      studentGroups: ['Grade 8-A', 'Grade 11-Science'],
    },
  ],
}

export function buildTimeslots(): Timeslot[] {
  return generateTimeslots(SAMPLE_CALENDAR)
}

export const SAMPLE_ROOMS: Room[] = [
  { id: 'RM-10', name: 'Kindergarten Block A', capacity: 24 },
  { id: 'RM-11', name: 'Kindergarten Block B', capacity: 24 },
  { id: 'RM-20', name: 'Elementary 4-A', capacity: 30 },
  { id: 'RM-21', name: 'Elementary 4-B', capacity: 30 },
  { id: 'RM-22', name: 'Middle Wing 8-A', capacity: 32 },
  { id: 'RM-30', name: 'Senior Room 11-A', capacity: 30 },
  { id: 'RM-40', name: 'Science Laboratory', capacity: 32 },
  { id: 'RM-41', name: 'Computer Laboratory', capacity: 32 },
  { id: 'RM-50', name: 'Art Studio', capacity: 30 },
  { id: 'RM-60', name: 'Gymnasium', capacity: 60 },
]

interface CurriculumBlock {
  subject: string
  teacher: string
  count: number
  doublePeriod?: boolean
}

interface Cohort {
  studentGroup: string
  tier: Tier
  studentCount: number
  blocks: CurriculumBlock[]
}

const CURRICULUM: Cohort[] = [
  {
    studentGroup: 'KG1-A',
    tier: 'KG',
    studentCount: 22,
    blocks: [
      { subject: 'Phonics', teacher: 'Ms. Clara', count: 5 },
      { subject: 'Numeracy', teacher: 'Ms. Clara', count: 5 },
      { subject: 'Story Time', teacher: 'Ms. Clara', count: 3 },
      { subject: 'Free Play', teacher: 'Ms. Clara', count: 3 },
      { subject: 'Motor Skills', teacher: 'Coach Adam', count: 3 },
      { subject: 'Art and Craft', teacher: 'Mr. Zaid', count: 3, doublePeriod: true },
      { subject: 'Music', teacher: 'Ms. Lina', count: 2 },
    ],
  },
  {
    studentGroup: 'KG2-A',
    tier: 'KG',
    studentCount: 24,
    blocks: [
      { subject: 'Phonics', teacher: 'Ms. Dana', count: 5 },
      { subject: 'Numeracy', teacher: 'Ms. Dana', count: 5 },
      { subject: 'Story Time', teacher: 'Ms. Dana', count: 3 },
      { subject: 'Discovery', teacher: 'Ms. Dana', count: 3 },
      { subject: 'Motor Skills', teacher: 'Coach Adam', count: 3 },
      { subject: 'Art and Craft', teacher: 'Mr. Zaid', count: 3, doublePeriod: true },
      { subject: 'Music', teacher: 'Ms. Lina', count: 2 },
    ],
  },
  {
    studentGroup: 'Grade 4-A',
    tier: 'ELEMENTARY',
    studentCount: 28,
    blocks: [
      { subject: 'English', teacher: 'Ms. Huda', count: 5 },
      { subject: 'Arabic', teacher: 'Mr. Omar', count: 5 },
      { subject: 'Mathematics', teacher: 'Mr. Sami', count: 5 },
      { subject: 'Science', teacher: 'Ms. Rana', count: 4 },
      { subject: 'Social Studies', teacher: 'Mr. Tariq', count: 2 },
      { subject: 'ICT', teacher: 'Ms. Nour', count: 2 },
      { subject: 'Physical Education', teacher: 'Coach Adam', count: 2 },
      { subject: 'Art', teacher: 'Mr. Zaid', count: 1 },
    ],
  },
  {
    studentGroup: 'Grade 4-B',
    tier: 'ELEMENTARY',
    studentCount: 27,
    blocks: [
      { subject: 'English', teacher: 'Ms. Huda', count: 5 },
      { subject: 'Arabic', teacher: 'Mr. Omar', count: 5 },
      { subject: 'Mathematics', teacher: 'Mr. Sami', count: 5 },
      { subject: 'Science', teacher: 'Ms. Rana', count: 4 },
      { subject: 'Social Studies', teacher: 'Mr. Tariq', count: 2 },
      { subject: 'ICT', teacher: 'Ms. Nour', count: 2 },
      { subject: 'Physical Education', teacher: 'Coach Adam', count: 2 },
      { subject: 'Art', teacher: 'Mr. Zaid', count: 1 },
    ],
  },
  {
    studentGroup: 'Grade 8-A',
    tier: 'MIDDLE',
    studentCount: 30,
    blocks: [
      { subject: 'English', teacher: 'Mr. Faris', count: 5 },
      { subject: 'Arabic', teacher: 'Mr. Omar', count: 4 },
      { subject: 'Mathematics', teacher: 'Ms. Maha', count: 5 },
      { subject: 'Physics', teacher: 'Dr. Yousef', count: 3 },
      { subject: 'Chemistry', teacher: 'Dr. Yousef', count: 3 },
      { subject: 'Biology', teacher: 'Ms. Rana', count: 2 },
      { subject: 'ICT', teacher: 'Ms. Nour', count: 2 },
      { subject: 'Physical Education', teacher: 'Coach Adam', count: 2 },
      { subject: 'Art', teacher: 'Mr. Zaid', count: 1 },
    ],
  },
  {
    studentGroup: 'Grade 11-Science',
    tier: 'HIGH',
    studentCount: 26,
    blocks: [
      { subject: 'English', teacher: 'Mr. Faris', count: 4 },
      { subject: 'Mathematics', teacher: 'Ms. Maha', count: 6 },
      { subject: 'Physics', teacher: 'Dr. Yousef', count: 5 },
      { subject: 'Chemistry', teacher: 'Dr. Yousef', count: 4, doublePeriod: true },
      { subject: 'Biology', teacher: 'Ms. Rana', count: 4 },
      { subject: 'ICT', teacher: 'Ms. Nour', count: 2 },
      { subject: 'Physical Education', teacher: 'Coach Adam', count: 1 },
    ],
  },
]

/**
 * Specialist subjects need their facility, so the room variable is pinned and
 * only the timeslot is left for the solver to choose.
 */
const REQUIRED_ROOM: Record<string, string> = {
  'Physical Education': 'RM-60',
  'Motor Skills': 'RM-60',
  Art: 'RM-50',
  'Art and Craft': 'RM-50',
  ICT: 'RM-41',
  Physics: 'RM-40',
  Chemistry: 'RM-40',
}

export function buildLessons(): Lesson[] {
  const lessons: Lesson[] = []
  let n = 1
  for (const cohort of CURRICULUM) {
    for (const block of cohort.blocks) {
      for (let k = 0; k < block.count; k++) {
        lessons.push({
          id: `L-${String(n++).padStart(3, '0')}`,
          subject: block.subject,
          teacher: block.teacher,
          studentGroup: cohort.studentGroup,
          tier: cohort.tier,
          studentCount: cohort.studentCount,
          // Only the first pair of a flagged block is requested as a double.
          doublePeriod: block.doublePeriod === true && k < 2,
          pinnedRoomId: REQUIRED_ROOM[block.subject],
        })
      }
    }
  }
  return lessons
}

function buildUnavailability(timeslots: Timeslot[]): Unavailability[] {
  const out: Unavailability[] = []
  const days = schoolDays(SAMPLE_CALENDAR)
  const onSite = new Set([days[0], days[2]])
  const lastDay = days[days.length - 1]
  const lastPeriods = SAMPLE_CALENDAR.periodsPerDay - 2

  timeslots.forEach((slot, index) => {
    const period = index % SAMPLE_CALENDAR.periodsPerDay
    // Part-time music specialist: on site for the first and third day only.
    if (!onSite.has(slot.dayOfWeek)) {
      out.push({ teacher: 'Ms. Lina', timeslotId: slot.id })
    }
    // Head of science runs department meetings on the last day of the week.
    if (slot.dayOfWeek === lastDay) {
      out.push({ teacher: 'Dr. Yousef', timeslotId: slot.id })
      // No PE in the last two periods of the week.
      if (period >= lastPeriods) {
        out.push({ teacher: 'Coach Adam', timeslotId: slot.id })
      }
    }
  })
  return out
}

export function sampleProblem(): Problem {
  const timeslots = buildTimeslots()
  return {
    calendar: structuredClone(SAMPLE_CALENDAR),
    timeslots,
    rooms: SAMPLE_ROOMS,
    lessons: buildLessons(),
    unavailability: buildUnavailability(timeslots),
    weights: { ...DEFAULT_WEIGHTS },
  }
}

export function emptyProblem(): Problem {
  return {
    calendar: structuredClone(SAMPLE_CALENDAR),
    timeslots: buildTimeslots(),
    rooms: SAMPLE_ROOMS,
    lessons: [],
    unavailability: [],
    weights: { ...DEFAULT_WEIGHTS },
  }
}
