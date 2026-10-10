import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

const MemxConfigSchema = z.object({
  refinementModel: z.string().optional().default("opencode/mimo-v2.6-flash-free"),
  maxSignalsPerSession: z.number().int().positive().optional().default(20),
  autoBackupCount: z.number().int().positive().optional().default(5),
  throttleMinutes: z.number().int().positive().optional().default(10),
});

export type MemxConfig = z.infer<typeof MemxConfigSchema>;

export function getConfigPath(): string {
  return join(homedir(), ".opencode", "memx.config.json");
}

export async function loadMemxConfig(): Promise<MemxConfig> {
  const path = getConfigPath();

  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    const result = MemxConfigSchema.safeParse(parsed);

    if (!result.success) {
      console.error(`[memx:error] Failed to parse config: ${result.error}`);
      return MemxConfigSchema.parse({});
    }

    return result.data;
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      console.warn(`[memx:warn] Config not found at ${path}, using defaults.`);
    } else {
      console.error(`[memx:error] Failed to parse config: ${err}`);
    }
    return MemxConfigSchema.parse({});
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
