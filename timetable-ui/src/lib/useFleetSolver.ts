import { useCallback, useEffect, useRef, useState } from 'react'
import type { FleetProblem, FleetSolution } from '../domain/fleet'
import type { VrpMessage, VrpRequest } from '../solver/vrp/vrp.worker'
import type { TravelCosts } from '../solver/vrp/solve'

export interface FleetProgress {
  elapsedMs: number
  iterations: number
  best: number
}

/** Runs the routing search in a worker so the map stays interactive. */
export function useFleetSolver() {
  const workerRef = useRef<Worker | null>(null)
  const [solution, setSolution] = useState<FleetSolution | null>(null)
  const [progress, setProgress] = useState<FleetProgress | null>(null)
  const [solving, setSolving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => () => workerRef.current?.terminate(), [])

  const stop = useCallback(() => {
    workerRef.current?.terminate()
    workerRef.current = null
    setSolving(false)
  }, [])

  const run = useCallback(
    (
      problem: FleetProblem,
      demand: number[],
      costs: TravelCosts | undefined,
      timeBudgetMs: number,
      seed: number,
    ) => {
    workerRef.current?.terminate()
    setError(null)
    setProgress(null)
    setSolving(true)

    const worker = new Worker(new URL('../solver/vrp/vrp.worker.ts', import.meta.url), {
      type: 'module',
    })
    workerRef.current = worker

    worker.onmessage = (event: MessageEvent<VrpMessage>) => {
      const message = event.data
      if (message.type === 'PROGRESS') {
        setProgress({
          elapsedMs: message.elapsedMs,
          iterations: message.iterations,
          best: message.best,
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
      setError(event.message || 'Routing worker crashed.')
      setSolving(false)
    }

      worker.postMessage({
        type: 'SOLVE',
        problem,
        demand,
        costs,
        timeBudgetMs,
        seed,
      } satisfies VrpRequest)
    },
    [],
  )

  return { solution, progress, solving, error, run, stop }
}
