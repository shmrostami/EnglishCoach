import { Routes, Route, NavLink } from "react-router-dom";
import { SessionView } from "./views/SessionView.js";
import { DashboardView } from "./views/DashboardView.js";
import { GoalsView } from "./views/GoalsView.js";

export default function App() {
  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 760, margin: "0 auto", padding: 24 }}>
      <nav style={{ display: "flex", gap: 16, marginBottom: 24, borderBottom: "1px solid #ddd", paddingBottom: 8 }}>
        <NavLink to="/">Session</NavLink>
        <NavLink to="/dashboard">Dashboard</NavLink>
        <NavLink to="/goals">Goals</NavLink>
      </nav>
      <Routes>
        <Route path="/" element={<SessionView />} />
        <Route path="/dashboard" element={<DashboardView />} />
        <Route path="/goals" element={<GoalsView />} />
      </Routes>
    </div>
  );
}
