import { expect, test } from "bun:test";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "../src/install.ts";

function liteHomeWithOverlay(overlay: object) {
  const home = mkdtempSync(join(tmpdir(), "posture-"));
  cpSync(join(import.meta.dir, "..", "config"), join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "local-claude.json"), JSON.stringify(overlay));
  return home;
}

async function doctorOutput(home: string): Promise<string[]> {
  const userHome = mkdtempSync(join(tmpdir(), "posture-user-"));
  const printed: string[] = [];
  const originalLog = console.log;
  console.log = (line: string) => printed.push(line);
  try {
    await doctor(userHome, home, async () => 0, userHome);
  } finally {
    console.log = originalLog;
  }
  return printed;
}

test("doctor shows a disabled sandbox and a bypass permission mode", async () => {
  const overlay = {
    sandbox: { enabled: false },
    permissions: { defaultMode: "bypassPermissions" },
  };
  const printed = await doctorOutput(liteHomeWithOverlay(overlay));
  expect(printed).toContain("info sandbox off");
  expect(printed).toContain("info permission mode bypassPermissions");
});

test("doctor shows the sandbox on and the default mode without an overlay", async () => {
  const printed = await doctorOutput(liteHomeWithOverlay({}));
  expect(printed).toContain("info sandbox on");
  expect(printed).toContain("info permission mode default");
});
