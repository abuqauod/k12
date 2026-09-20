/** A homeroom / form class — the group a student sits in for the daily
 * register. `label` is `${gradeLevel} ${name}` and is what the timetable
 * side sees as `studentGroup`. */
export interface SchoolClass {
  id: string
  branchId: string
  gradeLevel: string
  name: string
  label: string
  capacity: number
  homeroomTeacherId: string | null
  academicYearId: string | null
  active: boolean
  /** Enrolled students currently in this class. */
  enrolled: number
}

export interface NewClass {
  branchId: string
  gradeLevel: string
  name: string
  capacity: number
  homeroomTeacherId?: string | null
  academicYearId?: string | null
}

/** Demo-only cohort labels shared by the offline sample generators
 * (`sample.ts`'s `CURRICULUM`, `students.ts`'s `sampleStudents`) — kept in
 * one place so the two can't drift the way they used to: both files
 * previously hand-kept their own copy of the same six labels in sync by
 * hand. These `classId`s only exist within the bundled demo data; they
 * never correspond to a real `SchoolClass` a signed-in tenant would have. */
export const SAMPLE_COHORTS: Array<{ classId: string; label: string }> = [
  { classId: 'SAMPLE-KG1-A', label: 'KG1-A' },
  { classId: 'SAMPLE-KG2-A', label: 'KG2-A' },
  { classId: 'SAMPLE-GRADE4-A', label: 'Grade 4-A' },
  { classId: 'SAMPLE-GRADE4-B', label: 'Grade 4-B' },
  { classId: 'SAMPLE-GRADE8-A', label: 'Grade 8-A' },
  { classId: 'SAMPLE-GRADE11-SCIENCE', label: 'Grade 11-Science' },
]

/** Group classes by grade for display: "KG1" → [Stars, Moon], "Grade 1" → [A, B]. */
export function byGrade(classes: SchoolClass[]): Array<{ gradeLevel: string; sections: SchoolClass[] }> {
  const order: string[] = []
  const map = new Map<string, SchoolClass[]>()
  for (const klass of classes) {
    if (!map.has(klass.gradeLevel)) {
      map.set(klass.gradeLevel, [])
      order.push(klass.gradeLevel)
    }
    map.get(klass.gradeLevel)!.push(klass)
  }
  return order.map((gradeLevel) => ({
    gradeLevel,
    sections: [...map.get(gradeLevel)!].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }),
    ),
  }))
}
