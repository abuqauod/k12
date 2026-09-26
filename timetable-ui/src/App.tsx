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
import { StudentProfilePage } from './pages/StudentProfilePage'
import { AdmissionsPage } from './pages/AdmissionsPage'
import { ApplicationPage } from './pages/ApplicationPage'
import { YearEndPage } from './pages/YearEndPage'
import { ParentsPage } from './pages/ParentsPage'
import { AttendancePage } from './pages/AttendancePage'
import { ClassesPage } from './pages/ClassesPage'
import { LogsPage } from './pages/LogsPage'
import { FinancePage } from './pages/FinancePage'
import { HrPage } from './pages/HrPage'
import { EmployeePage } from './pages/EmployeePage'
import { OperationsPage } from './pages/OperationsPage'
import { LibraryPage } from './pages/LibraryPage'
import { EventPage, EventsPage } from './pages/EventsPage'
import { FleetPage } from './pages/FleetPage'
import { ApprovalsPage } from './pages/ApprovalsPage'
import { CommunicationPage } from './pages/CommunicationPage'
import { ReportsPage } from './pages/ReportsPage'
import { ClinicPage } from './pages/ClinicPage'
import { BehaviourPage } from './pages/BehaviourPage'
import { PortalShell } from './portal/PortalShell'
import { PortalHome } from './portal/PortalHome'
import { PortalChildPage } from './portal/PortalChildPage'

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, accessReady } = useAuth()
  const location = useLocation()
  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  // Staff and parents get different apps; wait to know which this is.
  if (!accessReady) return <div className="page-loading" aria-busy="true" />
  return <>{children}</>
}

/** The staff app: a parent portal login is sent to the portal instead. */
function StaffOnly({ children }: { children: ReactNode }) {
  const { roleKey } = useAuth()
  return roleKey === 'parent' ? <Navigate to="/portal" replace /> : <>{children}</>
}

function ParentOnly({ children }: { children: ReactNode }) {
  const { roleKey } = useAuth()
  return roleKey === 'parent' ? <>{children}</> : <Navigate to="/dashboard" replace />
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
            <ParentOnly>
              <PortalShell />
            </ParentOnly>
          </RequireAuth>
        }
      >
        <Route path="/portal" element={<PortalHome />} />
        <Route path="/portal/children/:id" element={<PortalChildPage />} />
      </Route>
      <Route
        element={
          <RequireAuth>
            <StaffOnly>
              <AppShell />
            </StaffOnly>
          </RequireAuth>
        }
      >
        <Route path="/dashboard" element={<DashboardPage />} />
        <Route path="/timetable" element={<TimetablePage />} />
        <Route path="/students" element={<StudentsPage />} />
        <Route path="/students/year-end" element={<YearEndPage />} />
        <Route path="/students/:id" element={<StudentProfilePage />} />
        <Route path="/admissions" element={<AdmissionsPage />} />
        <Route path="/admissions/:id" element={<ApplicationPage />} />
        <Route path="/parents" element={<ParentsPage />} />
        <Route path="/classes" element={<ClassesPage />} />
        <Route path="/attendance" element={<AttendancePage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/routes" element={<RoutesPage />} />
        <Route path="/finance" element={<FinancePage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/communication" element={<CommunicationPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/clinic" element={<ClinicPage />} />
        <Route path="/behaviour" element={<BehaviourPage />} />
        <Route path="/hr" element={<HrPage />} />
        <Route path="/hr/employees/:id" element={<EmployeePage />} />
        <Route path="/operations" element={<OperationsPage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/events" element={<EventsPage />} />
        <Route path="/events/:id" element={<EventPage />} />
        <Route path="/fleet" element={<FleetPage />} />
        <Route path="/settings/:section?" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  )
}
