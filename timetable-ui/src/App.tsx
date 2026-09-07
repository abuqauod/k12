import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { AppShell } from './app/AppShell'
import { useAuth } from './auth/AuthContext'
import { DashboardPage } from './pages/DashboardPage'
import { LoginPage } from './pages/LoginPage'
import { ForgotPasswordPage } from './pages/ForgotPasswordPage'
import { SetPasswordPage } from './pages/SetPasswordPage'
import { SettingsPage } from './pages/SettingsPage'
import { TimetablePage } from './pages/TimetablePage'
import { RoutesPage } from './pages/RoutesPage'
import { StudentsPage } from './pages/StudentsPage'

function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const location = useLocation()
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/accept-invite" element={<SetPasswordPage mode="invite" />} />
      <Route path="/reset-password" element={<SetPasswordPage mode="reset" />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/timetable" element={<TimetablePage />} />
        <Route path="/students" element={<StudentsPage />} />
        <Route path="/routes" element={<RoutesPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  )
}
