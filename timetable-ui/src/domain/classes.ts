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
