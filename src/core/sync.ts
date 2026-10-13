// memx 多机云同步（阶段 4 第二半）：GitHub 仓镜像 + PII 脱敏闸门 + dry-run 预览。
// 零宿主依赖：只用 node:* + 注入的 GitRunner（默认 child_process.spawnSync，测试注入假 runner）。
// 工作目录 ~/.opencode/memx-sync-repo/：不存在则 clone，存在则 fetch。
// 状态落 ~/.opencode/memx-sync-state.json（doctor / memx_status 读最近一次 push/pull/PII 扫描事实）。
// 报警走 core/alerts 的 AlertStore（由宿主传入，core 不反向 import 宿主）。
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AlertStore } from "./alerts";
import type { MemxSyncConfig } from "./config";

// ---- GitRunner：编排逻辑与真实 git 解耦，测试注入脚本化假 runner ----

export interface GitRunner {
  exec(cmd: string[], cwd: string): { ok: boolean; stdout: string; stderr: string };
}

export function createNodeGitRunner(): GitRunner {
  return {
    exec(cmd, cwd) {
      const [bin, ...args] = cmd;
      const r = spawnSync(bin!, args, { cwd, encoding: "utf8", timeout: 120_000 });
      return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
  };
}

// ---- PII 闸门：命中只报行号 + 规则名，绝不回显内容 ----

export interface PiiHit {
  pattern: string;
  line: number;
}

const PII_RULES: ReadonlyArray<{ pattern: string; re: RegExp }> = [
  { pattern: "openai-key", re: /sk-[A-Za-z0-9_-]{10,}/ },
  { pattern: "aws-access-key", re: /AKIA[0-9A-Z]{16}/ },
  { pattern: "github-token", re: /ghp_[A-Za-z0-9]{20,}/ },
  { pattern: "github-pat", re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { pattern: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { pattern: "jwt", re: /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/ },
  { pattern: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { pattern: "env-assignment", re: /^[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API[_-]?KEY)[A-Z0-9_]*\s*=\s*\S+/ },
];

export function scanSensitive(text: string): PiiHit[] {
  const hits: PiiHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const rule of PII_RULES) {
      if (rule.re.test(line)) hits.push({ pattern: rule.pattern, line: i + 1 });
    }
  }
  return hits;
}

// ---- 镜像清单：USER.md / MEMORY.md / projects/<slug>/.mem/**/*.md ----
// 排除 .trash/（文件名带时间戳，跨机互推必冲突）与 .bak.*；文件不存在则跳过。

export interface SyncFileEntry {
  repoPath: string;
  localPath: string;
}

function walkMirror(root: string): Array<{ repoPath: string; absolutePath: string }> {
  const out: Array<{ repoPath: string; absolutePath: string }> = [];
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) return out;
    const add = (repoPath: string, absolutePath: string): void => {
      out.push({ repoPath, absolutePath });
    };
    add("USER.md", join(root, "USER.md"));
    add("MEMORY.md", join(root, "MEMORY.md"));
    const projectsDir = join(root, "projects");
    if (existsSync(projectsDir) && statSync(projectsDir).isDirectory()) {
      for (const slug of readdirSync(projectsDir).sort()) {
        const memDir = join(projectsDir, slug, ".mem");
        if (!existsSync(memDir) || !statSync(memDir).isDirectory()) continue;
        const walk = (dir: string, prefix: string): void => {
          for (const name of readdirSync(dir).sort()) {
            const full = join(dir, name);
            const st = statSync(full);
            if (st.isDirectory()) {
              if (name === ".trash") continue;
              walk(full, prefix + name + "/");
            } else if (st.isFile() && name.endsWith(".md") && !name.includes(".bak.")) {
              add(`projects/${slug}/.mem/${prefix}${name}`, full);
            }
          }
        };
        walk(memDir, "");
      }
    }
  } catch {
    // 镜像列举是只读探测：任何 IO 异常都退化成"少列几个"，绝不抛（插件不能崩）
  }
  return out.filter((e) => existsSync(e.absolutePath));
}

export function listToSync(): SyncFileEntry[] {
  return walkMirror(join(homedir(), ".opencode")).map((e) => ({
    repoPath: e.repoPath,
    localPath: e.absolutePath,
  }));
}

function listFromWorkdir(workdir: string): SyncFileEntry[] {
  return walkMirror(workdir).map((e) => ({
    repoPath: e.repoPath,
    localPath: join(homedir(), ".opencode", e.repoPath),
  }));
}

// ---- 状态文件：doctor / memx_status 的最近事实来源 ----

export interface SyncState {
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: string;
  consecutiveFailures: number;
  lastPiiScan: { at: string; files: number; hits: number } | null;
}

export function syncStatePath(): string {
  return join(homedir(), ".opencode", "memx-sync-state.json");
}

export function readSyncState(path?: string): SyncState | null {
  try {
    const p = path ?? syncStatePath();
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<SyncState>;
    if (typeof raw !== "object" || raw === null) return null;
    return {
      lastPushAt: typeof raw.lastPushAt === "string" ? raw.lastPushAt : null,
      lastPullAt: typeof raw.lastPullAt === "string" ? raw.lastPullAt : null,
      lastError: typeof raw.lastError === "string" ? raw.lastError : "",
      consecutiveFailures: typeof raw.consecutiveFailures === "number" ? raw.consecutiveFailures : 0,
      lastPiiScan:
        typeof raw.lastPiiScan === "object" && raw.lastPiiScan !== null
          ? (raw.lastPiiScan as SyncState["lastPiiScan"])
          : null,
    };
  } catch {
    return null;
  }
}

export function writeSyncState(path: string, state: SyncState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // 状态写盘失败不能影响同步主流程
  }
}

// ---- dry-run 报告（只读；脚本与模块共用）----

export interface DryRunFileEntry {
  repoPath: string;
  localPath: string;
  /** null = 远端未取到（workdir 不存在，无法比对） */
  added: number | null;
  removed: number | null;
}

export interface DryRunReport {
  config: MemxSyncConfig;
  workdir: string;
  workdirExists: boolean;
  files: DryRunFileEntry[];
  piiHits: Array<{ file: string; pattern: string; line: number }>;
  remoteLog: string[];
}

/** 纯 JS 行级 diff（LCS）：dry-run 不碰 git 索引，只比对本地文件与 worktree 副本。 */
function diffLineCounts(local: string, remote: string): { added: number; removed: number } {
  const a = local.split("\n");
  const b = remote.split("\n");
  const n = b.length;
  let prev = new Array<number>(n + 1).fill(0);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    [prev, curr] = [curr, prev];
  }
  const lcs = prev[n]!;
  return { added: a.length - lcs, removed: b.length - lcs };
}

export function buildDryRunReport(opts: {
  config: MemxSyncConfig;
  runner?: GitRunner;
  workdir?: string;
}): DryRunReport {
  const runner = opts.runner ?? createNodeGitRunner();
  const workdir = opts.workdir ?? syncWorkdir();
  const workdirExists = existsSync(workdir);

  const files: DryRunFileEntry[] = listToSync().map((f) => {
    if (!workdirExists) return { ...f, added: null, removed: null };
    const remotePath = join(workdir, f.repoPath);
    if (!existsSync(remotePath)) {
      let lines = 0;
      try {
        lines = readFileSync(f.localPath, "utf8").split("\n").length;
      } catch {
        // 读不到就当 0 行
      }
      return { ...f, added: lines, removed: 0 };
    }
    let localText = "";
    let remoteText = "";
    try {
      localText = readFileSync(f.localPath, "utf8");
      remoteText = readFileSync(remotePath, "utf8");
    } catch {
      // 读不到就跳过行数比对
    }
    const { added, removed } = diffLineCounts(localText, remoteText);
    return { ...f, added, removed };
  });

  const piiHits: Array<{ file: string; pattern: string; line: number }> = [];
  for (const f of files) {
    let text = "";
    try {
      text = readFileSync(f.localPath, "utf8");
    } catch {
      continue;
    }
    for (const h of scanSensitive(text)) piiHits.push({ file: f.repoPath, ...h });
  }

  let remoteLog: string[] = [];
  if (workdirExists) {
    const r = runner.exec(["git", "log", "--oneline", "-5"], workdir);
    if (r.ok) remoteLog = r.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  }

  return { config: opts.config, workdir, workdirExists, files, piiHits, remoteLog };
}

export function syncWorkdir(): string {
  return join(homedir(), ".opencode", "memx-sync-repo");
}

// ---- 模块 ----

export interface SyncResult {
  ok: boolean;
  kind: "pushed" | "no-change" | "pulled" | "conflict" | "pii-blocked" | "error";
  message: string;
  piiHits?: Array<{ file: string; pattern: string; line: number }>;
}

export interface SyncStatus {
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: string;
  pendingFiles: number;
  consecutiveFailures: number;
}

export interface SyncModule {
  push(): Promise<SyncResult>;
  pull(): Promise<SyncResult>;
  status(): SyncStatus;
  dryRun(): DryRunReport;
  dispose(): void;
}

export interface CreateSyncOpts {
  config: MemxSyncConfig;
  alerts: AlertStore;
  runner?: GitRunner;
  workdir?: string;
  statePath?: string;
}

function summarizeNumstat(out: string): string {
  const parts: string[] = [];
  for (const line of out.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const [a, r, ...rest] = t.split("\t");
    const path = rest.join("\t");
    const added = a === "-" ? 0 : Number(a) || 0;
    const removed = r === "-" ? 0 : Number(r) || 0;
    parts.push(removed === 0 ? `${path} +${added} 行` : `${path} +${added} -${removed} 行`);
  }
  const summary = parts.join(", ");
  return summary.length > 120 ? summary.slice(0, 117) + "…" : summary;
}

export function createSync(opts: CreateSyncOpts): SyncModule {
  const config = opts.config;
  const runner = opts.runner ?? createNodeGitRunner();
  const workdir = opts.workdir ?? syncWorkdir();
  const statePath = opts.statePath ?? syncStatePath();
  // enabled=false 或 machineName 为空 → 模块不启动（不 clone、不注册任何东西）
  const active = config.enabled && config.machineName !== "";

  const persisted = active ? readSyncState(statePath) : null;
  let lastPushAt = persisted?.lastPushAt ?? null;
  let lastPullAt = persisted?.lastPullAt ?? null;
  let lastError = persisted?.lastError ?? "";
  let consecutiveFailures = persisted?.consecutiveFailures ?? 0;
  let lastPiiScan = persisted?.lastPiiScan ?? null;

  const save = (): void => {
    writeSyncState(statePath, { lastPushAt, lastPullAt, lastError, consecutiveFailures, lastPiiScan });
  };

  const alert = (level: "warn" | "critical", code: string, message: string): void => {
    opts.alerts.append({ level, code, message, ts: new Date().toISOString() });
  };

  function ensureRepo(): { ok: boolean; error?: string } {
    if (existsSync(join(workdir, ".git"))) return { ok: true };
    mkdirSync(dirname(workdir), { recursive: true });
    const r = runner.exec(["git", "clone", `git@github.com:${config.repo}.git`, workdir], dirname(workdir));
    if (!r.ok) return { ok: false, error: r.stderr.trim() || "clone 失败" };
    return { ok: true };
  }

  function failFast(message: string): SyncResult {
    lastError = message;
    consecutiveFailures++;
    save();
    return { ok: false, kind: "error", message };
  }

  async function push(): Promise<SyncResult> {
    if (!active) return { ok: false, kind: "error", message: "sync 未启用（enabled=false 或 machineName 为空）" };
    try {
      // PII 闸门先于任何 git 动作：命中即拒推，一个字节都不出门
      const files = listToSync();
      const piiHits: Array<{ file: string; pattern: string; line: number }> = [];
      for (const f of files) {
        let text = "";
        try {
          text = readFileSync(f.localPath, "utf8");
        } catch {
          continue;
        }
        for (const h of scanSensitive(text)) piiHits.push({ file: f.repoPath, ...h });
      }
      lastPiiScan = { at: new Date().toISOString(), files: files.length, hits: piiHits.length };
      if (piiHits.length > 0) {
        lastError = `PII 闸门拦截：${piiHits.length} 处敏感信息命中`;
        alert("critical", "SYNC_PII_BLOCKED", `${lastError}（${files.length} 个待推文件），已拒推`);
        save();
        return { ok: false, kind: "pii-blocked", message: lastError, piiHits };
      }

      const ensured = ensureRepo();
      if (!ensured.ok) return failFast(`clone 失败：${ensured.error ?? "未知"}`);

      for (const f of files) {
        const dest = join(workdir, f.repoPath);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(f.localPath, dest);
      }

      const status = runner.exec(["git", "status", "--porcelain"], workdir);
      if (status.ok && status.stdout.trim() === "") {
        save();
        return { ok: true, kind: "no-change", message: "无改动" };
      }

      runner.exec(["git", "add", "-A"], workdir);
      const num = runner.exec(["git", "diff", "--cached", "--numstat"], workdir);
      const message = `memx@${config.machineName}: ${summarizeNumstat(num.stdout)}`;
      const commit = runner.exec(["git", "commit", "-m", message], workdir);
      if (!commit.ok) return failFast(`commit 失败：${commit.stderr.trim() || "未知"}`);

      let pushRes = runner.exec(["git", "push", "origin", config.branch], workdir);
      if (!pushRes.ok) {
        // 非快进（或任何 push 失败）→ fetch + rebase + 重试一次；不进入重试风暴
        runner.exec(["git", "fetch", "origin", config.branch], workdir);
        const rebase = runner.exec(["git", "rebase", `origin/${config.branch}`], workdir);
        if (!rebase.ok) {
          runner.exec(["git", "rebase", "--abort"], workdir);
          lastError = "push 被拒且 rebase 冲突，已回滚，需人工处理";
          alert("critical", "SYNC_CONFLICT", lastError);
          consecutiveFailures++;
          save();
          return { ok: false, kind: "conflict", message: lastError };
        }
        pushRes = runner.exec(["git", "push", "origin", config.branch], workdir);
        if (!pushRes.ok) {
          lastError = `push 重试仍失败：${pushRes.stderr.trim() || "未知"}`;
          alert("warn", "SYNC_PUSH_FAILED", lastError);
          consecutiveFailures++;
          save();
          return { ok: false, kind: "error", message: lastError };
        }
      }

      lastPushAt = new Date().toISOString();
      lastError = "";
      consecutiveFailures = 0;
      save();
      return { ok: true, kind: "pushed", message };
    } catch (err) {
      return failFast(err instanceof Error ? err.message : String(err));
    }
  }

  async function pull(): Promise<SyncResult> {
    if (!active) return { ok: false, kind: "error", message: "sync 未启用（enabled=false 或 machineName 为空）" };
    try {
      const ensured = ensureRepo();
      if (!ensured.ok) return failFast(`clone 失败：${ensured.error ?? "未知"}`);

      const fetched = runner.exec(["git", "fetch", "origin", config.branch], workdir);
      if (!fetched.ok) return failFast(`fetch 失败：${fetched.stderr.trim() || "未知"}`);

      const rebase = runner.exec(["git", "rebase", `origin/${config.branch}`], workdir);
      if (!rebase.ok) {
        // 冲突不强行解：abort 回滚 + critical 报警，留人工
        runner.exec(["git", "rebase", "--abort"], workdir);
        lastError = "pull 时 rebase 冲突，已回滚，需人工处理";
        alert("critical", "SYNC_CONFLICT", lastError);
        consecutiveFailures++;
        save();
        return { ok: false, kind: "conflict", message: lastError };
      }

      let copied = 0;
      for (const f of listFromWorkdir(workdir)) {
        mkdirSync(dirname(f.localPath), { recursive: true });
        copyFileSync(join(workdir, f.repoPath), f.localPath);
        copied++;
      }

      lastPullAt = new Date().toISOString();
      lastError = "";
      consecutiveFailures = 0;
      save();
      return { ok: true, kind: "pulled", message: `已拉取 ${copied} 个文件` };
    } catch (err) {
      return failFast(err instanceof Error ? err.message : String(err));
    }
  }

  function status(): SyncStatus {
    return {
      lastPushAt,
      lastPullAt,
      lastError,
      pendingFiles: listToSync().length,
      consecutiveFailures,
    };
  }

  function dryRun(): DryRunReport {
    return buildDryRunReport({ config, runner, workdir });
  }

  function dispose(): void {
    // 模块自身不持有定时器（宿主持有 pull 定时器），此处仅作 API 占位
  }

  return { push, pull, status, dryRun, dispose };
}
