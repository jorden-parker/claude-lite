import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// An inert entry point at the package's installed path exercises the real OS
// process table without launching a model or accessing any user configuration.
export async function startClient(root: string, client: "claude" | "qwen") {
  const pkg = client === "claude" ? "@anthropic-ai/claude-code" : "@qwen-code/qwen-code";
  const script = join(root, "node_modules", pkg, "cli.js");
  await mkdir(dirname(script), { recursive: true });
  await writeFile(script, "setInterval(() => {}, 1000)");
  return Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "ignore" });
}
