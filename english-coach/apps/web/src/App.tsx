import { Routes, Route, NavLink } from "react-router-dom";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { SessionView } from "./views/SessionView.js";
import { DashboardView } from "./views/DashboardView.js";
import { GoalsView } from "./views/GoalsView.js";

// Each route gets its own boundary: one view's render crash (bad wire shape,
// missing data) cannot blank the rest of the app or the nav.
export default function App() {
  return (
    <div className="ec-app">
      <header className="ec-topbar">
        <span className="ec-wordmark"><span className="ec-wordmark__dot" aria-hidden="true" />English Coach</span>
        <nav className="ec-nav" aria-label="Primary">
          <NavLink to="/" end className={({ isActive }) => "ec-navlink" + (isActive ? " is-active" : "")}>Session</NavLink>
          <NavLink to="/dashboard" className={({ isActive }) => "ec-navlink" + (isActive ? " is-active" : "")}>Dashboard</NavLink>
          <NavLink to="/goals" className={({ isActive }) => "ec-navlink" + (isActive ? " is-active" : "")}>Goals</NavLink>
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<ErrorBoundary><SessionView /></ErrorBoundary>} />
        <Route path="/dashboard" element={<ErrorBoundary><DashboardView /></ErrorBoundary>} />
        <Route path="/goals" element={<ErrorBoundary><GoalsView /></ErrorBoundary>} />
      </Routes>
    </div>
  );
}
