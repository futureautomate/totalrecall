import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SessionsPage from "./SessionsPage";

const rows = [{ sessionId: "s1", projectPath: "D:\\p\\demo", title: "JWT auth", aiTitle: null,
  startedAt: "2026-08-01T10:00:00.000Z", outcome: "completed", snippet: "Added >>jwt<< auth" }];

const detail = { sessionId: "s1", projectPath: "D:\\p\\demo", startedAt: rows[0].startedAt, endedAt: null,
  firstPrompt: null, aiTitle: null, gitBranch: null, models: [], messageCount: 3, digestStatus: "done",
  digestTitle: "JWT auth", digestSummary: null, decisions: [], outcome: "completed", topics: [], filesEdited: [] };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.includes("/api/projects") ? []
      : url.includes("/related") ? []
      : url.includes("/excerpt") ? { snippets: [] }
      : url.includes("/api/sessions?") && url.includes("q=jwt") ? { rows, total: 1, mode: "search" }
      : url.includes("/api/sessions?") ? { rows: [], total: 0, mode: "list" }
      : detail;
    return { ok: true, status: 200, json: async () => body } as any;
  }));
});

afterEach(() => { cleanup(); });

describe("SessionsPage", () => {
  it("debounces search and renders highlighted results", async () => {
    render(<MemoryRouter><SessionsPage /></MemoryRouter>);
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "jwt" } });
    await waitFor(() => expect(screen.getByText("JWT auth")).toBeTruthy());
    expect(document.querySelector("mark")?.textContent).toBe("jwt");
    const calls = (fetch as any).mock.calls.map((c: any[]) => c[0] as string).filter((u: string) => u.includes("/api/sessions?"));
    expect(calls.some((u: string) => u.includes("q=jwt"))).toBe(true);
  });
  it("shows an empty state when there are no sessions", async () => {
    render(<MemoryRouter><SessionsPage /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText(/totalrecall backfill/i)).toBeTruthy());
  });
  it("does not refetch the session list when selecting a row", async () => {
    render(<MemoryRouter><SessionsPage /></MemoryRouter>);
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: "jwt" } });
    await waitFor(() => expect(screen.getByText("JWT auth")).toBeTruthy());
    const sessionListCalls = () => (fetch as any).mock.calls
      .map((c: any[]) => c[0] as string).filter((u: string) => u.includes("/api/sessions?")).length;
    const before = sessionListCalls();
    fireEvent.click(screen.getByText("JWT auth"));
    await waitFor(() => expect(screen.getByText(/search raw transcript/i)).toBeTruthy());
    expect(sessionListCalls()).toBe(before);
  });
});
