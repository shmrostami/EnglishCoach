import { Routes, Route, NavLink } from "react-router-dom";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { SessionView } from "./views/SessionView.js";
import { DashboardView } from "./views/DashboardView.js";
import { GoalsView } from "./views/GoalsView.js";

// Each route gets its own boundary: one view's render crash (bad wire shape,
// missing data) cannot blank the rest of the app or the nav.
export default function App() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 760, margin: "0 auto", padding: 24 }}>
      <nav style={{ display: "flex", gap: 16, marginBottom: 24, borderBottom: "1px solid #ddd", paddingBottom: 8 }}>
        <NavLink to="/">Session</NavLink>
        <NavLink to="/dashboard">Dashboard</NavLink>
        <NavLink to="/goals">Goals</NavLink>
      </nav>
      <Routes>
        <Route path="/" element={<ErrorBoundary><SessionView /></ErrorBoundary>} />
        <Route path="/dashboard" element={<ErrorBoundary><DashboardView /></ErrorBoundary>} />
        <Route path="/goals" element={<ErrorBoundary><GoalsView /></ErrorBoundary>} />
      </Routes>
    </div>
  );
}
