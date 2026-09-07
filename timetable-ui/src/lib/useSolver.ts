import { useCallback, useEffect, useRef, useState } from 'react'
import type { Problem, Score, Solution } from '../domain/types'
import type { SolveRequest, SolverMessage } from '../solver/solver.worker'

export interface SolverProgress {
  elapsedMs: number
  iterations: number
  best: Score
  restarts: number
}

/**
 * Drives the solver in a worker so a long search never blocks the UI thread.
 * Terminating the worker is the cancel path — the search loop is synchronous.
 */
export function useSolver() {
  const workerRef = useRef<Worker | null>(null)
  const [solution, setSolution] = useState<Solution | null>(null)
  const [progress, setProgress] = useState<SolverProgress | null>(null)
  const [solving, setSolving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const stop = useCallback(() => {
    workerRef.current?.terminate()
    workerRef.current = null
    setSolving(false)
  }, [])

  useEffect(() => () => workerRef.current?.terminate(), [])

  const run = useCallback(
    (problem: Problem, timeBudgetMs: number, seed: number) => {
      workerRef.current?.terminate()
      setError(null)
      setProgress(null)
      setSolving(true)

      const worker = new Worker(new URL('../solver/solver.worker.ts', import.meta.url), {
        type: 'module',
      })
      workerRef.current = worker

      worker.onmessage = (event: MessageEvent<SolverMessage>) => {
        const message = event.data
        if (message.type === 'PROGRESS') {
          setProgress({
            elapsedMs: message.elapsedMs,
            iterations: message.iterations,
            best: message.best,
            restarts: message.restarts,
          })
        } else if (message.type === 'DONE') {
          setSolution(message.solution)
          setSolving(false)
          worker.terminate()
          workerRef.current = null
        } else {
          setError(message.message)
          setSolving(false)
          worker.terminate()
          workerRef.current = null
        }
      }

      worker.onerror = (event) => {
        setError(event.message || 'Solver worker crashed.')
        setSolving(false)
      }

      const request: SolveRequest = {
        type: 'SOLVE',
        problem,
        timeBudgetMs,
        seed,
      }
      worker.postMessage(request)
    },
    [],
  )

  const reset = useCallback(() => {
    setSolution(null)
    setProgress(null)
    setError(null)
  }, [])

  return { solution, progress, solving, error, run, stop, reset }
}
