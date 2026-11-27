import { execFile } from "node:child_process";
import { readFile, readlink, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { basename } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
type Client = "claude" | "qwen";
type Registration = {
  pid: number;
  startedAt?: unknown;
  procStart?: unknown;
  pidNs?: unknown;
  pidDomain?: unknown;
  hostname?: unknown;
};

async function ps(pid: number, columns: string) {
  const { stdout } = await exec("/bin/ps", ["-ww", "-p", String(pid), "-o", columns], {
    timeout: 1500,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  return stdout.trim();
}

function nativeClient(client: Client, executable: string) {
  return (
    basename(executable) === client ||
    (client === "claude" && /\/claude\/versions\/\d+\.\d+\.\d+[^/]*$/.test(executable))
  );
}

function clientScript(client: Client, script: string | undefined) {
  if (!script) return false;
  return (
    nativeClient(client, script) ||
    (client === "claude"
      ? script.endsWith("/@anthropic-ai/claude-code/cli.js")
      : /\/@qwen-code\/qwen-code\/(?:dist\/)?cli(?:-entry)?\.js$/.test(script))
  );
}

// Registrations are local process claims. Check the owner's uid, executable, state
// and process lifetime on each capture. Never include argv in report data or errors.
export async function ownsSession(client: Client, record: Registration) {
  const { pid, startedAt, procStart } = record;
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    (record.hostname != null && record.hostname !== hostname()) ||
    (startedAt == null && procStart == null)
  )
    return false;
  try {
    process.kill(pid, 0);
    if (record.pidDomain != null) {
      let domain: string = process.platform;
      if (process.platform === "linux") {
        const machine = await readFile("/etc/machine-id", "utf8");
        domain += ":" + machine.trim() + ":" + (await readlink("/proc/self/ns/pid"));
      }
      if (record.pidDomain !== domain) return false;
    }
    if (
      record.pidNs != null &&
      (process.platform !== "linux" || record.pidNs !== (await stat("/proc/self/ns/pid")).ino)
    )
      return false;
    const info = await ps(pid, "uid=,stat=,lstart=,comm=");
    const fields = /^(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/.exec(
      info,
    );
    if (!fields || Number(fields[1]) !== process.getuid?.() || /^[ZX]/.test(fields[2]!))
      return false;
    const start = Date.parse(fields[3] + " UTC");
    if (
      !Number.isFinite(start) ||
      (startedAt != null &&
        (typeof startedAt !== "number" ||
          !Number.isFinite(startedAt) ||
          startedAt < start ||
          startedAt > Date.now()))
    )
      return false;

    if (procStart != null && !(client === "claude" && procStart === fields[3])) {
      if (process.platform !== "linux") return false;
      const raw = await readFile(`/proc/${pid}/stat`, "utf8");
      const ticks = raw
        .slice(raw.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/)[19];
      const boot = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      if (procStart !== (client === "qwen" ? boot + ":" + ticks : ticks)) return false;
    }
    const executable =
      process.platform === "linux" ? await readlink(`/proc/${pid}/exe`) : fields[4]!;
    if (nativeClient(client, executable)) return true;
    if (!["node", "bun"].includes(basename(executable))) return false;
    // Only inspect the entry point. User-supplied arguments can contain any client name.
    const argv =
      process.platform === "linux"
        ? (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0")
        : (await ps(pid, "args=")).split(/\s+/);
    const script = argv
      .slice(1)
      .find((arg) => !/^(?:--expose-gc|--max-old-space-size=\d+)$/.test(arg));
    return clientScript(client, script);
  } catch {
    return false;
  }
}
