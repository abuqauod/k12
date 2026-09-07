import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

export type Role = 'admin' | 'scheduler'

export interface User {
  id: string
  email: string
  name: string
  nameAr: string
  role: Role
}

/**
 * DEMO CREDENTIALS ONLY.
 *
 * These are checked in the browser against a list that ships inside the bundle,
 * which means anyone can read them and nothing here is a security boundary. It
 * exists so the routing, roles and session flow can be exercised without a
 * backend. Replace `signIn` with a call to a real identity provider — and move
 * the user list server-side — before this is pointed at live staff accounts.
 */
const DEMO_ACCOUNTS: Array<User & { password: string }> = [
  {
    id: 'u-admin',
    email: 'admin@school.test',
    password: 'admin123',
    name: 'Layla Hassan',
    nameAr: 'ليلى حسن',
    role: 'admin',
  },
  {
    id: 'u-sched',
    email: 'scheduler@school.test',
    password: 'plan123',
    name: 'Omar Nasser',
    nameAr: 'عمر ناصر',
    role: 'scheduler',
  },
]

export const DEMO_HINTS = DEMO_ACCOUNTS.map(({ email, password, role }) => ({
  email,
  password,
  role,
}))

interface AuthValue {
  user: User | null
  signIn: (email: string, password: string) => Promise<boolean>
  signOut: () => void
}

const AuthContext = createContext<AuthValue | null>(null)
const STORAGE_KEY = 'timetable.session'

function readSession(): User | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const id = JSON.parse(raw) as string
    const match = DEMO_ACCOUNTS.find((account) => account.id === id)
    if (!match) return null
    const { password: _password, ...user } = match
    return user
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(readSession)

  const signIn = useCallback(async (email: string, password: string) => {
    // Only the account id is persisted — the password is never stored.
    const match = DEMO_ACCOUNTS.find(
      (account) =>
        account.email.toLowerCase() === email.trim().toLowerCase() &&
        account.password === password,
    )
    if (!match) return false
    const { password: _password, ...next } = match
    setUser(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next.id))
    } catch {
      // Session simply will not survive a reload.
    }
    return true
  }, [])

  const signOut = useCallback(() => {
    setUser(null)
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      // Nothing to clear.
    }
  }, [])

  const value = useMemo<AuthValue>(() => ({ user, signIn, signOut }), [user, signIn, signOut])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside an AuthProvider')
  return value
}
