import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withOptOutsFor } from "../permissions-opt-out.ts";
import { renderModelfile } from "./modelfile.ts";
import { renderSettings } from "./settings.ts";
import { DEFAULT_SIZE, loadSizes, pickSize } from "./sizes.ts";

export type Runner = (argv: string[], env?: Record<string, string | undefined>) => Promise<number>;

export const spawnRunner: Runner = async (argv, env) =>
  await Bun.spawn(argv, { stdio: ["inherit", "inherit", "inherit"], env: env ?? process.env })
    .exited;

const TOOLS = "Bash,Read,Edit,Write,Skill";
const OLLAMA_URL = "http://localhost:11434";

export const serverResponds = async (run: Runner) =>
  (await run([
    "curl",
    "-sf",
    "-o",
    "/dev/null",
    "--max-time",
    "2",
    `${OLLAMA_URL}/api/version`,
  ])) === 0;

function buildPlan(home: string, args: string[]) {
  const sizes = loadSizes(home);
  const [first, ...rest] = args;
  const isSize = first !== undefined && Object.hasOwn(sizes, first);
  const sizeName = isSize ? first : DEFAULT_SIZE;
  const claudeArgs = isSize ? rest : args;
  const size = pickSize(sizes, sizeName);
  const read = (name: string) => JSON.parse(readFileSync(join(home, "config", name), "utf8"));
  const settings = withOptOutsFor(
    "ollama",
    renderSettings(read("ollama-base.json"), read("hooks.json"), size),
  );
  return { size, settings, modelfile: renderModelfile(size), claudeArgs };
}

export async function launch(
  home: string,
  args: string[],
  run: Runner = spawnRunner,
): Promise<number> {
  if (args.includes("--print-config")) {
    const { settings, modelfile } = buildPlan(
      home,
      args.filter((a) => a !== "--print-config"),
    );
    console.log(modelfile);
    console.log(JSON.stringify(settings, null, 2));
    return 0;
  }
  const { size, settings, modelfile, claudeArgs } = buildPlan(home, args);
  if (!(await serverResponds(run))) {
    console.error("Ollama is not responding on localhost:11434; run cl servers");
    return 1;
  }
  const dir = mkdtempSync(join(tmpdir(), "claude-lite-"));
  if ((await run(["ollama", "show", size.model])) !== 0) {
    if ((await run(["ollama", "pull", size.base])) !== 0) return 1;
    const modelfilePath = join(dir, "Modelfile");
    writeFileSync(modelfilePath, modelfile);
    if ((await run(["ollama", "create", size.model, "-f", modelfilePath])) !== 0) return 1;
  }
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_LITE_HOME: home,
    ANTHROPIC_BASE_URL: OLLAMA_URL,
  };
  delete env.ANTHROPIC_API_KEY;
  return await run(
    [
      "claude",
      "--settings",
      settingsPath,
      "--system-prompt-file",
      join(home, "config", "system-prompt.md"),
      "--model",
      size.model,
      "--tools",
      TOOLS,
      ...claudeArgs,
    ],
    env,
  );
}
