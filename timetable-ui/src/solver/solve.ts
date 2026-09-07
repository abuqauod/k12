import type { Assignment, Problem, Score, Solution } from '../domain/types'
import { compile } from './model'
import type { CompiledModel } from './model'
import { createBuffers, scalar, score } from './score'
import { explain } from './explain'

export interface SolveOptions {
  timeBudgetMs: number
  seed?: number
  onProgress?: (progress: {
    elapsedMs: number
    iterations: number
    best: Score
    restarts: number
  }) => void
}

/** Deterministic PRNG so a given seed always reproduces the same schedule. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Greedy construction: hardest lessons first, each placed in the
 * least-damaging (timeslot, room) pair given what is already scheduled.
 */
function construct(
  model: CompiledModel,
  ts: Int32Array,
  rm: Int32Array,
  rand: () => number,
): void {
  const { L, T, R, teacherCount, groupCount, subjectCount, dayCount } = model
  const roomBusy = new Uint8Array(T * R)
  const teacherBusy = new Uint8Array(T * teacherCount)
  const groupBusy = new Uint8Array(T * groupCount)
  const subjectDay = new Uint8Array(groupCount * subjectCount * dayCount)
  const groupDayLoad = new Uint8Array(groupCount * dayCount)
  // First room a cohort lands in becomes its preferred homeroom.
  const homeroom = new Int32Array(groupCount).fill(-1)

  // Lessons whose teacher or cohort is busiest are the hardest to place.
  const teacherLoad = new Int32Array(teacherCount)
  const groupLoad = new Int32Array(groupCount)
  for (let i = 0; i < L; i++) {
    teacherLoad[model.lessonTeacher[i]]++
    groupLoad[model.lessonGroup[i]]++
  }

  const order = Array.from({ length: L }, (_, i) => i).sort((a, b) => {
    const pinnedA = model.pinnedTimeslot[a] >= 0 ? 1 : 0
    const pinnedB = model.pinnedTimeslot[b] >= 0 ? 1 : 0
    if (pinnedA !== pinnedB) return pinnedB - pinnedA
    const da = teacherLoad[model.lessonTeacher[a]] + groupLoad[model.lessonGroup[a]]
    const db = teacherLoad[model.lessonTeacher[b]] + groupLoad[model.lessonGroup[b]]
    return db - da
  })

  for (const i of order) {
    const teacher = model.lessonTeacher[i]
    const group = model.lessonGroup[i]
    const subject = model.lessonSubject[i]
    const size = model.lessonSize[i]

    let bestSlot = 0
    let bestRoom = 0
    let bestCost = Number.POSITIVE_INFINITY

    const slotChoices = model.pinnedTimeslot[i] >= 0 ? [model.pinnedTimeslot[i]] : null
    const roomChoices = model.pinnedRoom[i] >= 0 ? [model.pinnedRoom[i]] : null

    for (let sIdx = 0; sIdx < (slotChoices ? slotChoices.length : T); sIdx++) {
      const slot = slotChoices ? slotChoices[sIdx] : sIdx
      let cost = 0
      if (teacherBusy[slot * teacherCount + teacher]) cost += 100
      if (groupBusy[slot * groupCount + group]) cost += 100
      if (model.blocked[teacher * T + slot]) cost += 100
      if (model.groupBlocked[group * T + slot]) cost += 100
      if (cost >= 200) continue

      const day = model.tsDay[slot]
      if (subjectDay[(group * subjectCount + subject) * dayCount + day]) cost += 4
      // Prefer packing a cohort day tightly, and earlier periods first.
      cost += groupDayLoad[group * dayCount + day] * 0.05
      cost += model.tsPeriod[slot] * 0.02

      for (let rIdx = 0; rIdx < (roomChoices ? roomChoices.length : R); rIdx++) {
        const room = roomChoices ? roomChoices[rIdx] : rIdx
        let total = cost
        if (roomBusy[slot * R + room]) total += 100
        const cap = model.roomCapacity[room]
        if (cap >= 0 && size >= 0 && size > cap) total += 100
        if (homeroom[group] >= 0 && homeroom[group] !== room) total += 1.5
        total += rand() * 0.01
        if (total < bestCost) {
          bestCost = total
          bestSlot = slot
          bestRoom = room
        }
      }
    }

    ts[i] = bestSlot
    rm[i] = bestRoom
    roomBusy[bestSlot * R + bestRoom] = 1
    teacherBusy[bestSlot * teacherCount + teacher] = 1
    groupBusy[bestSlot * groupCount + group] = 1
    subjectDay[(group * subjectCount + subject) * dayCount + model.tsDay[bestSlot]] = 1
    groupDayLoad[group * dayCount + model.tsDay[bestSlot]]++
    if (homeroom[group] < 0) homeroom[group] = bestRoom
  }
}

/**
 * Construction heuristic followed by simulated annealing with reheats.
 * Runs until `timeBudgetMs` is spent and returns the best solution seen.
 */
export function solve(problem: Problem, options: SolveOptions): Solution {
  const started = Date.now()
  const model = compile(problem)
  const { L, T, R } = model

  if (L === 0 || T === 0 || R === 0) {
    const empty = new Int32Array(0)
    const { violations, score: s } = explain(model, empty, empty)
    return {
      status: L === 0 ? 'SUCCESS' : 'INFEASIBLE',
      score: L === 0 ? s : { hard: -L, soft: 0 },
      assignments: problem.lessons.map((lesson) => ({
        lessonId: lesson.id,
        timeslotId: null,
        roomId: null,
      })),
      violations:
        L > 0
          ? [
              {
                constraint: 'ROOM_CONFLICT' as const,
                level: 'HARD' as const,
                penalty: L,
                messageKey: T === 0 ? 'msg.noTimeslots' : 'msg.noRooms',
                messageParams: {},
                lessonIds: problem.lessons.map((l) => l.id),
              },
            ]
          : violations,
      stats: { iterations: 0, elapsedMs: Date.now() - started, restarts: 0 },
    }
  }

  const rand = mulberry32(options.seed ?? 0x5eed)
  const buffers = createBuffers(model)

  const ts = new Int32Array(L)
  const rm = new Int32Array(L)
  construct(model, ts, rm, rand)

  const bestTs = Int32Array.from(ts)
  const bestRm = Int32Array.from(rm)
  let current = scalar(score(model, ts, rm, buffers))
  let best = current
  let bestScore = score(model, bestTs, bestRm, buffers)

  const movable: number[] = []
  for (let i = 0; i < L; i++) {
    if (model.pinnedTimeslot[i] < 0 || model.pinnedRoom[i] < 0) movable.push(i)
  }
  const M = movable.length

  let iterations = 0
  let restarts = 0
  let sinceImprovement = 0
  // Tuned to the magnitude of soft deltas. Deriving it from the combined
  // scalar would start thousands of degrees too hot, because a single hard
  // violation is worth a million soft points.
  let temperature = 8
  const budget = options.timeBudgetMs
  let lastReport = started

  if (M > 0) {
    for (;;) {
      // Clock and progress checks are amortised over a block of moves.
      const now = Date.now()
      if (now - started >= budget) break
      if (options.onProgress && now - lastReport >= 120) {
        lastReport = now
        options.onProgress({
          elapsedMs: now - started,
          iterations,
          best: bestScore,
          restarts,
        })
      }

      for (let block = 0; block < 400; block++) {
        iterations++
        const i = movable[(rand() * M) | 0]
        const oldTs = ts[i]
        const oldRm = rm[i]
        let j = -1
        let oldTsJ = -1
        let oldRmJ = -1

        const move = rand()
        if (move < 0.35 && model.pinnedTimeslot[i] < 0) {
          ts[i] = (rand() * T) | 0
        } else if (move < 0.55 && model.pinnedRoom[i] < 0) {
          rm[i] = (rand() * R) | 0
        } else if (move < 0.75) {
          if (model.pinnedTimeslot[i] < 0) ts[i] = (rand() * T) | 0
          if (model.pinnedRoom[i] < 0) rm[i] = (rand() * R) | 0
        } else {
          // Swap both planning variables between two lessons.
          j = movable[(rand() * M) | 0]
          oldTsJ = ts[j]
          oldRmJ = rm[j]
          if (model.pinnedTimeslot[i] < 0 && model.pinnedTimeslot[j] < 0) {
            ts[i] = oldTsJ
            ts[j] = oldTs
          }
          if (model.pinnedRoom[i] < 0 && model.pinnedRoom[j] < 0) {
            rm[i] = oldRmJ
            rm[j] = oldRm
          }
        }

        const candidate = scalar(score(model, ts, rm, buffers))
        const delta = candidate - current

        if (delta >= 0 || rand() < Math.exp(delta / temperature)) {
          current = candidate
          if (candidate > best) {
            best = candidate
            bestTs.set(ts)
            bestRm.set(rm)
            bestScore = score(model, bestTs, bestRm, buffers)
            sinceImprovement = 0
          } else {
            sinceImprovement++
          }
        } else {
          ts[i] = oldTs
          rm[i] = oldRm
          if (j >= 0) {
            ts[j] = oldTsJ
            rm[j] = oldRmJ
          }
          sinceImprovement++
        }
      }

      temperature *= 0.997
      if (temperature < 0.25) temperature = 0.25

      // Stuck for a long stretch: fall back to the best solution and warm up
      // just enough to escape the basin without discarding the fine-tuning.
      if (sinceImprovement > 150_000) {
        restarts++
        sinceImprovement = 0
        ts.set(bestTs)
        rm.set(bestRm)
        current = best
        temperature = 2.5
      }
    }
  }

  const { violations, score: explained } = explain(model, bestTs, bestRm)

  const assignments: Assignment[] = problem.lessons.map((lesson, i) => ({
    lessonId: lesson.id,
    timeslotId: problem.timeslots[bestTs[i]]?.id ?? null,
    roomId: problem.rooms[bestRm[i]]?.id ?? null,
  }))

  return {
    status: explained.hard === 0 ? 'SUCCESS' : 'INFEASIBLE',
    score: explained,
    assignments,
    violations,
    stats: { iterations, elapsedMs: Date.now() - started, restarts },
  }
}
