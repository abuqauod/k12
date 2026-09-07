/// <reference lib="webworker" />
import type { Problem, Score, Solution } from '../domain/types'
import { solve } from './solve'

export interface SolveRequest {
  type: 'SOLVE'
  problem: Problem
  timeBudgetMs: number
  seed: number
}

export type SolverMessage =
  | { type: 'PROGRESS'; elapsedMs: number; iterations: number; best: Score; restarts: number }
  | { type: 'DONE'; solution: Solution }
  | { type: 'ERROR'; message: string }

const ctx = self as unknown as DedicatedWorkerGlobalScope

ctx.onmessage = (event: MessageEvent<SolveRequest>) => {
  const request = event.data
  if (request.type !== 'SOLVE') return
  try {
    const solution = solve(request.problem, {
      timeBudgetMs: request.timeBudgetMs,
      seed: request.seed,
      onProgress: (progress) => {
        const message: SolverMessage = { type: 'PROGRESS', ...progress }
        ctx.postMessage(message)
      },
    })
    ctx.postMessage({ type: 'DONE', solution } satisfies SolverMessage)
  } catch (error) {
    ctx.postMessage({
      type: 'ERROR',
      message: error instanceof Error ? error.message : String(error),
    } satisfies SolverMessage)
  }
}
