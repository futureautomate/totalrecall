import { describe, it, expect } from "vitest";
import { encodeProjectPath, excludedProjectDirs, claudeProjectsDir } from "../src/paths.js";
import os from "node:os";
import path from "node:path";

describe("paths", () => {
  it("encodes a Windows path the way Claude Code does", () => {
    expect(encodeProjectPath("D:\\Projects\\sessiontrack")).toBe("D--Projects-sessiontrack");
    expect(encodeProjectPath("C:\\Users\\tejas")).toBe("C--Users-tejas");
  });
  it("claudeProjectsDir points into the home directory", () => {
    expect(claudeProjectsDir()).toBe(path.join(os.homedir(), ".claude", "projects"));
  });
  it("excludes the digester cwd from scanning", () => {
    const digesterEncoded = encodeProjectPath(path.join(os.homedir(), ".sessiontrack", "digester-cwd"));
    expect(excludedProjectDirs().has(digesterEncoded)).toBe(true);
  });
});
