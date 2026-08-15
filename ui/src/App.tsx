import { NavLink, Route, Routes, Navigate } from "react-router-dom";
import { useEffect, useState } from "react";
import SessionsPage from "./pages/SessionsPage";
import GraphPage from "./pages/GraphPage";
import ProjectsPage from "./pages/ProjectsPage";
import StatusBar from "./components/StatusBar";

export default function App() {
  const [theme, setTheme] = useState<"dark" | "light">(() => (localStorage.getItem("tr-theme") as any) || "dark");
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem("tr-theme", theme); }, [theme]);
  return (
    <div className="shell">
      <nav className="nav">
        <div className="brand">TotalRecall</div>
        <NavLink to="/sessions">Sessions</NavLink>
        <NavLink to="/graph">Graph</NavLink>
        <NavLink to="/projects">Projects</NavLink>
        <div style={{ flex: 1 }} />
        <button className="btn" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          {theme === "dark" ? "☀ Light" : "☾ Dark"}
        </button>
      </nav>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/sessions" replace />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/graph" element={<GraphPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
        </Routes>
      </main>
      <StatusBar />
    </div>
  );
}
