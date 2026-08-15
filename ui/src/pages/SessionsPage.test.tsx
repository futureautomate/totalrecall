import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SessionsPage from "./SessionsPage";

const rows = [{ sessionId: "s1", projectPath: "D:\\p\\demo", title: "JWT auth", aiTitle: null,
  startedAt: "2026-08-01T10:00:00.000Z", outcome: "completed", snippet: "Added >>jwt<< auth" }];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.includes("/api/projects") ? []
      : url.includes("q=jwt") ? { rows, total: 1, mode: "search" }
      : { rows: [], total: 0, mode: "list" };
    return { ok: true, status: 200, json: async () => body } as any;
  }));
});

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
});
