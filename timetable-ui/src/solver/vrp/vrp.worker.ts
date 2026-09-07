/// <reference lib="webworker" />
import type { FleetProblem, FleetSolution } from '../../domain/fleet'
import { solveFleet } from './solve'
import type { TravelCosts } from './solve'

export interface VrpRequest {
  type: 'SOLVE'
  problem: FleetProblem
  demand: number[]
  costs?: TravelCosts
  timeBudgetMs: number
  seed: number
}

export type VrpMessage =
  | { type: 'PROGRESS'; elapsedMs: number; iterations: number; best: number }
  | { type: 'DONE'; solution: FleetSolution }
  | { type: 'ERROR'; message: string }

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = (event: MessageEvent<VrpRequest>) => {
  const request = event.data
  if (request.type !== 'SOLVE') return
  try {
    const solution = solveFleet(request.problem, {
      demand: request.demand,
      costs: request.costs,
      timeBudgetMs: request.timeBudgetMs,
      seed: request.seed,
      onProgress: (progress) => ctx.postMessage({ type: 'PROGRESS', ...progress } as VrpMessage),
    })
    ctx.postMessage({ type: 'DONE', solution } satisfies VrpMessage)
  } catch (error) {
    ctx.postMessage({
      type: 'ERROR',
      message: error instanceof Error ? error.message : String(error),
    } satisfies VrpMessage)
  }
}
