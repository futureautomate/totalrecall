import { describe, it, expect } from "vitest";
import { installHook } from "../src/hook.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tempSettings(content: object | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "st-hook-"));
  const p = path.join(dir, "settings.json");
  if (content !== null) fs.writeFileSync(p, JSON.stringify(content, null, 2));
  return p;
}

describe("installHook", () => {
  it("adds a SessionEnd hook to empty settings", () => {
    const p = tempSettings({});
    const r = installHook(p, "D:\\Projects\\sessiontrack\\dist\\cli.js");
    expect(r.installed).toBe(true);
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    const cmd = s.hooks.SessionEnd[0].hooks[0].command;
    expect(cmd).toContain("hook-run");
    expect(s.hooks.SessionEnd[0].hooks[0].timeout).toBe(600);
  });

  it("creates settings file when missing", () => {
    const p = tempSettings(null);
    const r = installHook(p, "C:\\x\\cli.js");
    expect(r.installed).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
  });

  it("is idempotent", () => {
    const p = tempSettings({});
    installHook(p, "C:\\x\\cli.js");
    const r2 = installHook(p, "C:\\x\\cli.js");
    expect(r2.already).toBe(true);
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(s.hooks.SessionEnd.length).toBe(1);
  });

  it("preserves existing unrelated hooks", () => {
    const p = tempSettings({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "echo hi" }] }] } });
    installHook(p, "C:\\x\\cli.js");
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    expect(s.hooks.SessionEnd.length).toBe(2);
    expect(s.hooks.SessionEnd[0].hooks[0].command).toBe("echo hi");
  });
});
