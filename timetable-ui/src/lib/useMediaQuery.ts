import { useEffect, useState } from 'react'

/** Subscribes to a media query so layout logic can match the CSS breakpoints. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  )

  useEffect(() => {
    const list = window.matchMedia(query)
    const sync = () => setMatches(list.matches)
    sync()
    list.addEventListener('change', sync)
    // Belt and braces: some embedded/emulated viewports resize without ever
    // firing a MediaQueryList change, which would strand the layout.
    window.addEventListener('resize', sync)
    return () => {
      list.removeEventListener('change', sync)
      window.removeEventListener('resize', sync)
    }
  }, [query])

  return matches
}
