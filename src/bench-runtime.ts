import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

export function logOffset(path?: string): number {
  try {
    return path ? statSync(path).size : 0;
  } catch {
    return 0;
  }
}

export function engineEvidence(engine: string, path?: string, offset = 0): string | null {
  if (!path) return null;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = Math.max(offset <= size ? offset : 0, size - 512 * 1024);
    const tail = Buffer.alloc(size - start);
    readSync(fd, tail, 0, tail.length, start);
    const log = tail.toString();
    if (engine === "splash" && /Splash: serving \S+ at /.test(log))
      return "Splash served the model";
    if (engine === "dflash" && /DFlash drafter attached to engine:/i.test(log))
      return "native DFlash drafter attached";
    if (engine === "mtp" && /VLM MTP drafter (?:loaded|attached to engine:)/i.test(log))
      return "VLM MTP drafter loaded";
    if (engine === "ollama" && /speculative decode stats[^\n]*\bdrafted=[1-9]/.test(log))
      return "speculation observed in local Ollama log";
  } catch {
    /* The server may be remote or log elsewhere. */
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return null;
}

export async function sampleModelMemory(
  url: string,
  backend: string,
  model: string,
): Promise<number | undefined> {
  try {
    const response = await fetch(url + (backend === "mlx" ? "/api/status" : "/api/ps"), {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return;
    const data = await response.json();
    const bytes =
      backend === "mlx"
        ? data.model_memory_used
        : data.models?.find(
            (m: { name: string }) => m.name === model || m.name === model + ":latest",
          )?.size;
    if (Number.isFinite(bytes) && bytes > 0) return bytes;
  } catch {
    /* Optional runtime measurement. */
  }
}
