import type { CompiledModel } from './model'
import type { Score } from '../domain/types'

/**
 * Scratch buffers reused across every evaluation. Only the entries touched by
 * the previous evaluation are cleared, so a full score stays O(lessons).
 */
export interface ScoreBuffers {
  roomOcc: Int32Array
  teacherOcc: Int32Array
  groupOcc: Int32Array
  teacherPeriods: Uint32Array
  groupPeriods: Uint32Array
  teacherRooms: Uint32Array
  groupRooms: Uint32Array
  subjectPeriods: Uint32Array
  subjectDoubles: Uint32Array
  touched: Int32Array
}

export function createBuffers(model: CompiledModel): ScoreBuffers {
  const { L, T, R, teacherCount, groupCount, subjectCount, dayCount } = model
  return {
    roomOcc: new Int32Array(Math.max(1, T * R)),
    teacherOcc: new Int32Array(Math.max(1, T * teacherCount)),
    groupOcc: new Int32Array(Math.max(1, T * groupCount)),
    teacherPeriods: new Uint32Array(Math.max(1, teacherCount * dayCount)),
    groupPeriods: new Uint32Array(Math.max(1, groupCount * dayCount)),
    teacherRooms: new Uint32Array(Math.max(1, teacherCount * dayCount)),
    groupRooms: new Uint32Array(Math.max(1, groupCount * dayCount)),
    subjectPeriods: new Uint32Array(Math.max(1, groupCount * subjectCount * dayCount)),
    subjectDoubles: new Uint32Array(Math.max(1, groupCount * subjectCount * dayCount)),
    touched: new Int32Array(Math.max(1, L * 6)),
  }
}

function popcount(v: number): number {
  v = v - ((v >>> 1) & 0x55555555)
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
  v = (v + (v >>> 4)) & 0x0f0f0f0f
  return (v * 0x01010101) >>> 24
}

/** Idle periods between a day's first and last occupied period. */
function gapsInMask(mask: number): number {
  if (mask === 0) return 0
  const lowest = 31 - Math.clz32(mask & -mask)
  const highest = 31 - Math.clz32(mask)
  return highest - lowest + 1 - popcount(mask)
}

/**
 * Full HardSoftScore for an assignment. `ts[i]` / `rm[i]` hold the timeslot and
 * room index chosen for lesson `i`.
 */
export function score(
  model: CompiledModel,
  ts: Int32Array,
  rm: Int32Array,
  buf: ScoreBuffers,
): Score {
  const {
    L,
    T,
    R,
    lessonTeacher,
    lessonGroup,
    lessonSubject,
    lessonSize,
    lessonDouble,
    tsDay,
    tsPeriod,
    roomCapacity,
    blocked,
    groupBlocked,
    groupBreakMask,
    subjectCount,
    dayCount,
    maskSafe,
    roomMaskSafe,
  } = model
  const w = model.problem.weights

  const {
    roomOcc,
    teacherOcc,
    groupOcc,
    teacherPeriods,
    groupPeriods,
    teacherRooms,
    groupRooms,
    subjectPeriods,
    subjectDoubles,
    touched,
  } = buf

  let hard = 0
  let nRoom = 0
  let nTeacher = 0
  let nGroup = 0
  let nTp = 0
  let nGp = 0
  let nSp = 0

  const roomKeys = touched
  const teacherKeys = touched.subarray(L, L * 2)
  const groupKeys = touched.subarray(L * 2, L * 3)
  const tpKeys = touched.subarray(L * 3, L * 4)
  const gpKeys = touched.subarray(L * 4, L * 5)
  const spKeys = touched.subarray(L * 5, L * 6)

  for (let i = 0; i < L; i++) {
    const slot = ts[i]
    const room = rm[i]
    if (slot < 0 || room < 0) {
      hard -= 1 // unassigned entity
      continue
    }

    const teacher = lessonTeacher[i]
    const group = lessonGroup[i]
    const day = tsDay[slot]
    const period = tsPeriod[slot]
    const bit = 1 << period

    // --- HARD 1: room conflict -------------------------------------------
    const rk = slot * R + room
    const rPrev = roomOcc[rk]
    if (rPrev === 0) roomKeys[nRoom++] = rk
    roomOcc[rk] = rPrev + 1
    hard -= rPrev

    // --- HARD 2: teacher conflict ----------------------------------------
    const tk = slot * model.teacherCount + teacher
    const tPrev = teacherOcc[tk]
    if (tPrev === 0) teacherKeys[nTeacher++] = tk
    teacherOcc[tk] = tPrev + 1
    hard -= tPrev

    // --- HARD 3: student group conflict ----------------------------------
    const gk = slot * model.groupCount + group
    const gPrev = groupOcc[gk]
    if (gPrev === 0) groupKeys[nGroup++] = gk
    groupOcc[gk] = gPrev + 1
    hard -= gPrev

    // --- HARD 4: teacher unavailability ----------------------------------
    if (blocked[teacher * T + slot] === 1) hard -= 1

    // --- HARD 5: cohort break --------------------------------------------
    if (groupBlocked[group * T + slot] === 1) hard -= 1

    // --- HARD 6: room capacity -------------------------------------------
    const cap = roomCapacity[room]
    const size = lessonSize[i]
    if (cap >= 0 && size >= 0 && size > cap) hard -= 1

    if (!maskSafe) continue

    const tdKey = teacher * dayCount + day
    if (teacherPeriods[tdKey] === 0) tpKeys[nTp++] = tdKey
    teacherPeriods[tdKey] |= bit
    if (roomMaskSafe) teacherRooms[tdKey] |= 1 << room

    const gdKey = group * dayCount + day
    if (groupPeriods[gdKey] === 0) gpKeys[nGp++] = gdKey
    groupPeriods[gdKey] |= bit
    if (roomMaskSafe) groupRooms[gdKey] |= 1 << room

    const sdKey = (group * subjectCount + lessonSubject[i]) * dayCount + day
    if (subjectPeriods[sdKey] === 0) spKeys[nSp++] = sdKey
    subjectPeriods[sdKey] |= bit
    if (lessonDouble[i] === 1) subjectDoubles[sdKey] |= bit
  }

  let soft = 0

  for (let k = 0; k < nTp; k++) {
    const key = tpKeys[k]
    soft -= gapsInMask(teacherPeriods[key]) * w.teacherContinuity
    if (roomMaskSafe) {
      const rooms = popcount(teacherRooms[key])
      if (rooms > 1) soft -= (rooms - 1) * w.teacherRoomStability
    }
    teacherPeriods[key] = 0
    teacherRooms[key] = 0
  }

  for (let k = 0; k < nGp; k++) {
    const key = gpKeys[k]
    // A period the cohort has reserved as its break is not an idle gap.
    const occupied = groupPeriods[key] | groupBreakMask[(key / dayCount) | 0]
    soft -= gapsInMask(occupied) * w.studentContinuity
    if (roomMaskSafe) {
      const rooms = popcount(groupRooms[key])
      if (rooms > 1) soft -= (rooms - 1) * w.studentRoomStability
    }
    groupPeriods[key] = 0
    groupRooms[key] = 0
  }

  for (let k = 0; k < nSp; k++) {
    const key = spKeys[k]
    const mask = subjectPeriods[key]
    const dbl = subjectDoubles[key]
    const extra = popcount(mask) - 1
    if (extra > 0) {
      // Adjacent periods flagged as a double period are exempt.
      const paired = popcount(mask & (mask >>> 1) & dbl & (dbl >>> 1))
      const penalised = extra - paired
      if (penalised > 0) soft -= penalised * w.subjectDistribution
    }
    subjectPeriods[key] = 0
    subjectDoubles[key] = 0
  }

  for (let k = 0; k < nRoom; k++) roomOcc[roomKeys[k]] = 0
  for (let k = 0; k < nTeacher; k++) teacherOcc[teacherKeys[k]] = 0
  for (let k = 0; k < nGroup; k++) groupOcc[groupKeys[k]] = 0

  return { hard, soft }
}

/** Single number for the annealing acceptance test — hard dominates soft. */
export function scalar(s: Score): number {
  return s.hard * 1_000_000 + s.soft
}
