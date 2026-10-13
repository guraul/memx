import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";

/**
 * 注入闸门：谁能被注入 memx 内容。
 *
 * ⚠️ 这里**不出现任何具体 agent 名字**——memx 必须宿主无关（opencode 只是第一个宿主）。
 * 谁该被排除（例如某个会把 system 原样回显给终端用户的 agent）由消费方自己填。
 */
const MemxInjectSchema = z.object({
  /** 总开关。false = 一个字节都不注入（protocol hook 照常工作，只是不注入）。 */
  enabled: z.boolean().optional().default(true),
  /** "all" = 所有 agent；数组 = 只有列出的。 */
  includeAgents: z.union([z.literal("all"), z.array(z.string())]).optional().default("all"),
  /** 永远压过 includeAgents。 */
  excludeAgents: z.array(z.string()).optional().default([]),
});

const MemxConfigSchema = z.object({
  refinementModel: z.string().optional().default("opencode/mimo-v2.6-flash-free"),
  maxSignalsPerSession: z.number().int().positive().optional().default(20),
  autoBackupCount: z.number().int().positive().optional().default(5),
  throttleMinutes: z.number().int().positive().optional().default(10),
  inject: MemxInjectSchema.optional().default({ enabled: true, includeAgents: "all", excludeAgents: [] }),
});

export type MemxConfig = z.infer<typeof MemxConfigSchema>;

export function getConfigPath(): string {
  return join(homedir(), ".opencode", "memx.config.json");
}

/** 配置不存在是持久状态而非事件：warn 一次即可。
 *  注入闸门按 TTL 后台重读配置（`context` hook 每 step 同步触发，不能在里面 await），
 *  逐次 warn 会让"没建配置文件"的机器每 30 秒刷一行——那是噪声，不是信息。 */
let missingConfigWarned = false;

export async function loadMemxConfig(): Promise<MemxConfig> {
  const path = getConfigPath();

  try {
    const raw = await readFile(path, "utf-8");
    missingConfigWarned = false;
    const parsed = JSON.parse(raw);
    const result = MemxConfigSchema.safeParse(parsed);

    if (!result.success) {
      console.error(`[memx:error] Failed to parse config: ${result.error}`);
      return MemxConfigSchema.parse({});
    }

    return result.data;
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === "ENOENT") {
      if (!missingConfigWarned) {
        console.warn(`[memx:warn] Config not found at ${path}, using defaults.`);
        missingConfigWarned = true;
      }
    } else {
      console.error(`[memx:error] Failed to parse config: ${err}`);
    }
    return MemxConfigSchema.parse({});
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
