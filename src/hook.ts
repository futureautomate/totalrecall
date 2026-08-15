import fs from "node:fs";

const MARKER = "sessiontrack";

export function installHook(
  settingsPath: string, cliJsAbsPath: string,
): { installed: boolean; already: boolean } {
  let settings: any = {};
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  }
  settings.hooks ??= {};
  settings.hooks.SessionEnd ??= [];
  const exists = settings.hooks.SessionEnd.some((entry: any) =>
    entry?.hooks?.some((h: any) => typeof h.command === "string" && h.command.includes(MARKER)));
  if (exists) return { installed: false, already: true };
  settings.hooks.SessionEnd.push({
    hooks: [{
      type: "command",
      // trailing "sessiontrack" positional arg is a stable idempotency marker,
      // independent of cliJsAbsPath (which may not itself contain "sessiontrack"
      // if installed to a non-default location); hook-run declares it as an
      // optional, ignored argument so real execution is unaffected.
      command: `node "${cliJsAbsPath}" hook-run ${MARKER}`,
      timeout: 600,
    }],
  });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { installed: true, already: false };
}
