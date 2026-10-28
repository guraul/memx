// memx 多机云同步（阶段 4 第二半）：GitHub 仓镜像 + PII 脱敏闸门 + dry-run 预览。
// 零宿主依赖：只用 node:* + 注入的 GitRunner（默认 child_process.spawnSync，测试注入假 runner）。
// 工作目录 ~/.opencode/memx-sync-repo/：不存在则 clone，存在则 fetch。
// 状态落 ~/.opencode/memx-sync-state.json（doctor / memx_status 读最近一次 push/pull/PII 扫描事实）。
// 报警走 core/alerts 的 AlertStore（由宿主传入，core 不反向 import 宿主）。
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AlertStore } from "./alerts.ts";
import type { MemxSyncConfig } from "./config.ts";
// 显式 .ts：scripts/doctor.ts 走 `node --experimental-strip-types` 直接加载本模块，
// 扩展名缺失会在运行时 ERR_MODULE_NOT_FOUND（tsc/vitest 都发现不了）。
import { withFileLock } from "./store/lock.ts";

// ---- GitRunner：编排逻辑与真实 git 解耦，测试注入脚本化假 runner ----

export interface GitRunner {
  exec(cmd: string[], cwd: string): { ok: boolean; stdout: string; stderr: string; reason?: string };
}

export function createNodeGitRunner(): GitRunner {
  return {
    exec(cmd, cwd) {
      const [bin, ...args] = cmd;
      const r = spawnSync(bin!, args, { cwd, encoding: "utf8", timeout: 120_000 });
      // 失败原因不丢：ENOENT / 超时（r.error）、被信号杀（r.signal）、非零退出（r.status）拼成一句可读原因
      const parts: string[] = [];
      if (r.error) parts.push(r.error.message);
      if (r.signal) parts.push(`signal ${r.signal}`);
      if (r.status !== null && r.status !== 0) parts.push(`exit ${r.status}`);
      const out: { ok: boolean; stdout: string; stderr: string; reason?: string } = {
        ok: r.status === 0,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
      };
      if (parts.length > 0) out.reason = parts.join("；");
      return out;
    },
  };
}

/** 会创建 commit 的 git 命令共用的兜底身份：prod 上 workdir 是新 clone，从没配过 git 身份，
 *  commit / rebase 都要写 author/committer，缺身份会直接失败。commit 走 commitCommand
 *  （workdir 已有真身份时不覆盖）；rebase 重放本地提交必然要写 committer，一律显式带上——
 *  否则没有身份的环境下 rebase 会以 "Committer identity unknown" 失败，被误判成内容冲突（SYNC_CONFLICT 误报）。 */
const SYNC_IDENTITY_ARGS = ["-c", "user.name=memx-sync", "-c", "user.email=memx@localhost"] as const;

// ---- PII 闸门：命中只报行号 + 规则名，绝不回显内容 ----
// issue #33：规则分两层。block 层是高精度机器凭据形态，命中即拒推，**冻结**；
// alert 层是语义型/低置信规则，只告警不阻断——命中照推，但明细落状态文件持久留痕。
// 低置信为什么不能进 block：一次误报就 fail-closed 锁死整机同步（issue #10 实测锁了一整天）。

export type PiiTier = "block" | "alert";

export interface PiiHit {
  pattern: string;
  line: number;
  tier: PiiTier;
}

/** 带文件路径的命中（dry-run / push 结果用）。 */
export interface PiiFileHit {
  file: string;
  pattern: string;
  line: number;
  tier: PiiTier;
}

export interface PiiRule {
  pattern: string;
  re: RegExp;
  tier: PiiTier;
}

/** block 层（**冻结**，issue #33）：8 条高精度凭据形态永不下放到 alert 层。
 *  新增形态只有同样高精度（几乎不可能误报）才允许进这一层。 */
export const PII_BLOCK_RULES: ReadonlyArray<PiiRule> = [
  // 词边界 + 现实前缀/长度（issue #10）：旧写法 /sk-[A-Za-z0-9_-]{10,}/ 无边界，
  // 把 `risk-management-foo`、`task-spec-branch-name-verify` 中段出现的 `sk-…` 当成 key，
  // 一次词形误报就把整机同步 fail-closed 锁死。新规则三重约束：
  //   ① 前导 `[^A-Za-z0-9_-]`（或行首）= `sk-` 必须是**词的开头**，中段一律不算；
  //   ② 现行真实前缀 `proj-` / `ant-` 直接放行（`sk-proj-…`、`sk-ant-api03-…`）；
  //   ③ 其余裸 `sk-` 要求 ≥20 位 base62 且**含大写字母或数字**——真实 key 是随机串，
  //      全小写的连字符词组（`spec-branch-name-verify`）因此被排除，不必逐个枚举词表。
  // 明确的取舍：一律小写、无数字的 20+ 位 token 不拦（随机性太弱），本次现场两类误报与经典
  // `sk-` + 长 base62 形态都能正确区分；要放宽就把 ③ 的正向前瞻删掉。
  {
    pattern: "openai-key",
    re: /(^|[^A-Za-z0-9_-])sk-(?:(?:proj-|ant-)[A-Za-z0-9][A-Za-z0-9-]{5,}|(?=[A-Za-z0-9_-]{20,})[A-Za-z0-9_-]*(?=[A-Z0-9])[A-Za-z0-9_-]*)/,
    tier: "block",
  },
  { pattern: "aws-access-key", re: /AKIA[0-9A-Z]{16}/, tier: "block" },
  { pattern: "github-token", re: /ghp_[A-Za-z0-9]{20,}/, tier: "block" },
  { pattern: "github-pat", re: /github_pat_[A-Za-z0-9_]{20,}/, tier: "block" },
  { pattern: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/, tier: "block" },
  { pattern: "jwt", re: /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/, tier: "block" },
  { pattern: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, tier: "block" },
  { pattern: "env-assignment", re: /^[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API[_-]?KEY)[A-Z0-9_]*\s*=\s*\S+/, tier: "block" },
];

/** alert 层：低置信语义规则，**只告警不阻断**。命中照推，明细写进 `lastPiiScan` 与
 *  `piiAlertLog`（状态文件，不剪龄，只封顶）——不能只依赖 7 天剪龄的 AlertStore。 */
export const PII_ALERT_RULES: ReadonlyArray<PiiRule> = [
  {
    pattern: "password-statement",
    // 「我的密码是 abc123」「password is hunter2」「密码：abc123」这类**陈述/赋值**形态。
    // 值里要求至少一位数字：过滤「密码管理器」「password is required」这类讨论/说明。
    // 这层本来就是低置信，宁可漏报，也不要把普通文档刷成告警。
    re: /(?:密码|口令|passwd|password|passphrase)\s*(?:是|为|[:：=]|is)\s*(?=[^\s]*\d)[^\s]{3,}/i,
    tier: "alert",
  },
];

const PII_RULES: ReadonlyArray<PiiRule> = [...PII_BLOCK_RULES, ...PII_ALERT_RULES];

export function scanSensitive(text: string): PiiHit[] {
  const hits: PiiHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const rule of PII_RULES) {
      if (rule.re.test(line)) hits.push({ pattern: rule.pattern, line: i + 1, tier: rule.tier });
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

/** 同步范围内的 repo 路径判定（删除传播专用，比 walkMirror 更严）。
 *  walkMirror 决定"拷什么"，这里决定"敢删什么"——删除不可逆，判据必须更窄：
 *  - 只认 USER.md / MEMORY.md / `projects/<slug>/.mem/**` 下的 `.md`
 *  - 任意一段以 `.` 开头（`.trash/`、隐藏文件、隐藏目录）一律排除
 *  - 文件名含 `.bak.` 排除（备份不进镜像，也绝不能被删除传播带走）
 *  后果可控：宁可漏传播一个删除，也不碰软删件/备份/同步范围外的文件。 */
export function isSyncRepoPath(repoPath: string): boolean {
  if (repoPath === "USER.md" || repoPath === "MEMORY.md") return true;
  if (!repoPath.endsWith(".md") || repoPath.includes(".bak.")) return false;
  const parts = repoPath.split("/");
  if (parts.length < 4 || parts[0] !== "projects" || parts[2] !== ".mem") return false;
  const slug = parts[1]!;
  if (slug === "" || slug.startsWith(".")) return false;
  return parts.slice(3).every((seg) => seg !== "" && !seg.startsWith("."));
}

/** 待传播的删除：`rev` 那棵树里属于同步范围、但本地已不存在的路径（issue #21）。
 *
 *  这是 push 侧判断"本地删除"与 pull 侧"孤儿"共用的只读探针：
 *  - `rev` 解析不到 / workdir 未 clone / git 不可用 → []（fail-safe：绝不凭猜测报/删任何东西）
 *  - 目录约定与删除安全边界见 {@link isSyncRepoPath}
 */
export function listPendingDeletions(opts: { rev: string; workdir?: string; runner?: GitRunner }): string[] {
  const workdir = opts.workdir ?? syncWorkdir();
  const runner = opts.runner ?? createNodeGitRunner();
  if (!existsSync(join(workdir, ".git"))) return [];
  const r = runner.exec(["git", "ls-tree", "-r", "--name-only", opts.rev], workdir);
  if (!r.ok) return [];
  const localPaths = new Set(listToSync().map((f) => f.repoPath));
  const out: string[] = [];
  for (const line of r.stdout.split("\n")) {
    const repoPath = line.trim();
    if (repoPath !== "" && isSyncRepoPath(repoPath) && !localPaths.has(repoPath)) out.push(repoPath);
  }
  return out.sort();
}

function listFromWorkdir(workdir: string): SyncFileEntry[] {
  return walkMirror(workdir).map((e) => ({
    repoPath: e.repoPath,
    localPath: join(homedir(), ".opencode", e.repoPath),
  }));
}

// ---- 状态文件：doctor / memx_status 的最近事实来源 ----

/** 一次 PII 扫描的事实记录。`alertHits` 是 alert 层明细（只含 file/pattern/line，绝不回显内容），
 *  随状态文件落盘，是「告警层留痕」的持久管道之一（另一条是 {@link SyncState.piiAlertLog}）。 */
export interface PiiScanRecord {
  at: string;
  files: number;
  /** 命中总数 = blocked + alerted */
  hits: number;
  /** block 层命中数（命中即拒推） */
  blocked: number;
  /** alert 层命中数（放行但留痕） */
  alerted: number;
  alertHits: Array<{ file: string; pattern: string; line: number }>;
}

/** alert 层命中的持久留痕（append-only、不剪龄、只封顶）。 */
export interface PiiAlertRecord {
  at: string;
  file: string;
  pattern: string;
  line: number;
}

export interface SyncState {
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: string;
  consecutiveFailures: number;
  lastPiiScan: PiiScanRecord | null;
  /** alert 层命中历史（issue #33）：**不随扫描覆盖**，也没有 7 天剪龄——低置信内容一旦被推出，
   *  远端 git 历史是永久的，本地至少要留住"什么时候推过哪条规则"。封顶 200 条丢最旧。 */
  piiAlertLog: PiiAlertRecord[];
  /** 上一次**成功** pull 记录的远端 branch sha（`git rev-parse origin/<branch>`）。
   *  下次 pull 用它做前置短路比对；旧状态文件没有该字段 → null = 未知 → 走真实 pull（向后兼容）。 */
  lastRemoteSha: string | null;
  /** 最近一次观测到的**未推提交数**（`git rev-list --count @{u}..HEAD`，issue #12 的可观测字段）。
   *  老状态文件没有该字段 → 0（向后兼容）。 */
  unsyncedCommits: number;
}

/** alert 留痕上限：只在条数上封顶，不做时间剪龄（与 AlertStore 的 7 天剪龄区分开）。 */
const PII_ALERT_LOG_MAX = 200;

function isPiiAlertDetail(value: unknown): value is { file: string; pattern: string; line: number } {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<{ file: string; pattern: string; line: number }>;
  return typeof v.file === "string" && typeof v.pattern === "string" && typeof v.line === "number";
}

function normalizePiiScan(raw: unknown): PiiScanRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Partial<PiiScanRecord>;
  if (typeof r.at !== "string" || typeof r.files !== "number" || typeof r.hits !== "number") return null;
  return {
    at: r.at,
    files: r.files,
    hits: r.hits,
    // 旧状态只有 hits（分层之前所有规则都是 block 层）→ blocked=hits / alerted=0
    blocked: typeof r.blocked === "number" ? r.blocked : r.hits,
    alerted: typeof r.alerted === "number" ? r.alerted : 0,
    alertHits: Array.isArray(r.alertHits) ? r.alertHits.filter(isPiiAlertDetail) : [],
  };
}

function normalizePiiAlertLog(raw: unknown): PiiAlertRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: PiiAlertRecord[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Partial<PiiAlertRecord>;
    const at = e.at;
    if (typeof at !== "string" || !isPiiAlertDetail(e)) continue;
    out.push({ at, file: e.file, pattern: e.pattern, line: e.line });
  }
  return out.slice(-PII_ALERT_LOG_MAX);
}

export function syncStatePath(): string {
  return join(homedir(), ".opencode", "memx-sync-state.json");
}

/** 同步串行闸门（跨进程）：workdir 只有一个，push/pull 不能同时碰它。 */
export function syncLockPath(): string {
  return join(homedir(), ".opencode", ".memx-sync.lock");
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
      lastPiiScan: normalizePiiScan(raw.lastPiiScan),
      piiAlertLog: normalizePiiAlertLog(raw.piiAlertLog),
      lastRemoteSha: typeof raw.lastRemoteSha === "string" ? raw.lastRemoteSha : null,
      unsyncedCommits: typeof raw.unsyncedCommits === "number" ? raw.unsyncedCommits : 0,
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
  /** prepare 模式（--fetch）的说明：clone / 快进成功 / 为何没前进；未开 prepare 时为空串 */
  note: string;
  files: DryRunFileEntry[];
  piiHits: PiiFileHit[];
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

/** prepare（dry-run --fetch）：把 workdir 对齐到远端最新（clone 或 fetch + merge --ff-only）。
 *  只动 workdir 这个缓存目录——绝不 push、绝不碰 ~/.opencode 里的记忆文件。
 *  workdir 里有未推提交时 ff-only 会失败，此时退回"就用本地 workdir 比对"并把原因写进 note，
 *  免得预览因为本地缓存状态而悄悄失真。 */
function prepareWorkdir(opts: { config: MemxSyncConfig; runner: GitRunner; workdir: string }): string {
  const { config, runner, workdir } = opts;
  if (!existsSync(join(workdir, ".git"))) {
    mkdirSync(dirname(workdir), { recursive: true });
    const clone = runner.exec(
      ["git", "clone", remoteUrl(config.repo), workdir],
      dirname(workdir),
    );
    return clone.ok
      ? `已 clone ${config.repo} → ${workdir}（比对基准 = 远端 HEAD）`
      : `clone 失败：${clone.stderr.trim() || clone.reason || "无输出"}`;
  }
  const fetch = runner.exec(["git", "fetch", "origin", config.branch], workdir);
  if (!fetch.ok) return `fetch 失败：${fetch.stderr.trim() || fetch.reason || "无输出"}`;
  const ff = runner.exec(["git", "merge", "--ff-only", `origin/${config.branch}`], workdir);
  return ff.ok
    ? `已 fetch + 快进到 origin/${config.branch}（比对基准 = 远端 HEAD）`
    : `workdir 有未推提交，无法快进；预览基于本地 workdir（可能落后于远端）`;
}

export function buildDryRunReport(opts: {
  config: MemxSyncConfig;
  runner?: GitRunner;
  workdir?: string;
  /** true = 先 clone/fetch 到 workdir 再比对（首合并预览用；仍然只读记忆文件、绝不 push） */
  prepare?: boolean;
}): DryRunReport {
  const runner = opts.runner ?? createNodeGitRunner();
  const workdir = opts.workdir ?? syncWorkdir();
  const note = opts.prepare ? prepareWorkdir({ config: opts.config, runner, workdir }) : "";
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

  const piiHits: PiiFileHit[] = [];
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

  return { config: opts.config, workdir, workdirExists, note, files, piiHits, remoteLog };
}

export function syncWorkdir(): string {
  return join(homedir(), ".opencode", "memx-sync-repo");
}

/** 远端地址：`owner/name` 走 GitHub SSH（默认），带协议前缀 / 绝对路径的写法原样使用。
 *  后者让本机自测与自建远端（本地 bare 仓）能用真实的 git 走完整条路，不必打桩。 */
export function remoteUrl(repo: string): string {
  return /^(git@|ssh:\/\/|https?:\/\/|file:|\/|\.\/|\.\.\/)/.test(repo) ? repo : `git@github.com:${repo}.git`;
}

/** 解析 `git ls-remote origin refs/heads/<branch>` 输出：首行首字段（sha）。空 / 非 sha → ""，
 *  调用方据此回落完整 pull（fail-open，绝不让这个优化把 pull 弄坏）。 */
function parseLsRemoteSha(stdout: string): string {
  const first = stdout.split("\n").map((l) => l.trim()).find((l) => l !== "");
  const sha = first?.split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : "";
}

// ---- 模块 ----

export interface SyncResult {
  ok: boolean;
  kind: "pushed" | "no-change" | "pulled" | "conflict" | "pii-blocked" | "error";
  message: string;
  piiHits?: PiiFileHit[];
}

export interface SyncStatus {
  lastPushAt: string | null;
  lastPullAt: string | null;
  lastError: string;
  /** 待同步文件数 = 本地镜像文件数 + 待传播的删除数（issue #21）。 */
  pendingFiles: number;
  /** 待传播的删除数：同步基线里还有、本地已不存在（issue #21）。统计口径含删除。 */
  pendingDeletions: number;
  consecutiveFailures: number;
  /** 未推提交数（issue #12）：>0 = 本地有提交还没出门，push 必须真的执行（不再被 no-change 短路）。 */
  unsyncedCommits: number;
}

export interface SyncModule {
  push(): Promise<SyncResult>;
  /** force:true → 跳过"远端无变化"前置短路，强制走完整 pull（启动补齐 / 人工通道用）。 */
  pull(opts?: { force?: boolean }): Promise<SyncResult>;
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
  let piiAlertLog = persisted?.piiAlertLog ?? [];
  let lastRemoteSha = persisted?.lastRemoteSha ?? null;
  let unsyncedCommits = persisted?.unsyncedCommits ?? 0;

  const save = (): void => {
    writeSyncState(statePath, {
      lastPushAt,
      lastPullAt,
      lastError,
      consecutiveFailures,
      lastPiiScan,
      piiAlertLog,
      lastRemoteSha,
      unsyncedCommits,
    });
  };

  /** alert 层命中落**持久管道**（issue #33）：状态文件 append-only、不剪龄，仅按条数封顶。
   *  与 AlertStore 的 7 天剪龄分开——即时提醒会消失，这条留痕不会。
   *  同 file+pattern+line 只记一次（同一处内容反复推不刷屏）；行号变化则算新记录。 */
  function recordPiiAlerts(hits: Array<{ file: string; pattern: string; line: number }>, at: string): void {
    if (hits.length === 0) return;
    const seen = new Set(piiAlertLog.map((e) => `${e.file}\u0000${e.pattern}\u0000${e.line}`));
    for (const h of hits) {
      const key = `${h.file}\u0000${h.pattern}\u0000${h.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      piiAlertLog.push({ at, file: h.file, pattern: h.pattern, line: h.line });
    }
    if (piiAlertLog.length > PII_ALERT_LOG_MAX) piiAlertLog = piiAlertLog.slice(-PII_ALERT_LOG_MAX);
  }

  // 同一事实不重复刷屏：定时拉在离线机器上每 30 分钟失败一次，不去重会把 200 条账本塞满同一行
  const alert = (level: "warn" | "critical", code: string, message: string): void => {
    const recent = opts.alerts.list();
    const last = recent[recent.length - 1];
    if (last && last.code === code && last.message === message) return;
    opts.alerts.append({ level, code, message, ts: new Date().toISOString() });
  };

  /** 覆盖前备份：本地内容与将写入的内容不同 → 先存成 <file>.bak.<ts>（每文件保留最新 5 份）。
   *  拉取是"远端优先"，没有这一步就会静默吞掉本地未推的改动（首合并、推送失败后尤其危险）。 */
  function backupBeforeOverwrite(target: string): string {
    const bak = `${target}.bak.${Date.now()}`;
    copyFileSync(target, bak);
    try {
      const dir = dirname(target);
      const prefix = `${basename(target)}.bak.`;
      const olds = readdirSync(dir)
        .filter((f) => f.startsWith(prefix))
        .map((f) => join(dir, f))
        .sort()
        .reverse();
      for (const old of olds.slice(5)) unlinkSync(old);
    } catch {
      // 备份清理失败不影响拉取
    }
    return bak;
  }

  function ensureRepo(): { ok: boolean; error?: string } {
    if (existsSync(join(workdir, ".git"))) return { ok: true };
    mkdirSync(dirname(workdir), { recursive: true });
    const r = runner.exec(["git", "clone", remoteUrl(config.repo), workdir], dirname(workdir));
    if (!r.ok) return { ok: false, error: r.stderr.trim() || r.reason || "无输出" };
    return { ok: true };
  }

  /** 串行闸门：workdir 只有一份，push/pull 不能同时碰（git index.lock 会互相踩）。
   *  插件是每进程一实例、每个进程各自按目录实例化——同一个实例里两次快速写盘也会并发
   *  `void sync.push()`。进程内与跨进程都要挡，所以用文件锁而不是内存互斥。
   *  ttl/timeout 都比默认宽：一次 push 含网络往返（git 命令自身 120s 超时封顶）。 */
  function withSyncLock<T>(fn: () => T | Promise<T>): Promise<T> {
    return withFileLock(syncLockPath(), fn, { ttlMs: 600_000, timeoutMs: 300_000 });
  }

  function failFast(message: string): SyncResult {
    lastError = message;
    consecutiveFailures++;
    alert("warn", "SYNC_ERROR", message);
    save();
    return { ok: false, kind: "error", message };
  }

  /** 新 clone 的 workdir 未必有 git 身份（prod 上就没配过）——没有就现造一个，
   *  否则 commit 直接失败、同步永远推不出去。有真身份时不覆盖。 */
  function commitCommand(message: string): string[] {
    const probe = runner.exec(["git", "config", "user.email"], workdir);
    const hasIdentity = probe.ok && probe.stdout.trim() !== "";
    return hasIdentity
      ? ["git", "commit", "-m", message]
      : ["git", ...SYNC_IDENTITY_ARGS, "commit", "-m", message];
  }

  /** workdir 内取 `origin/<branch>` 的 sha（完整 pull 成功后记录，供下次前置短路比对）。
   *  取不到（命令失败 / 输出非 sha）→ null = 未知，下次照样走真实 pull。 */
  function readOriginSha(): string | null {
    const r = runner.exec(["git", "rev-parse", `origin/${config.branch}`], workdir);
    const sha = r.ok ? r.stdout.trim() : "";
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  }

  /** 未推提交数（issue #12）：`git rev-list --count @{u}..HEAD`。
   *  **不吞任何错误**：workdir 没 clone / 没有上游 / git 不可用 / 输出不可解析 → null = 未知。
   *  调用方对 null 的处置各不相同：push 短路要 fail-open（照常 push，绝不再把积压藏起来），
   *  status 只报已记录值（保持只读、少 spawn）。 */
  function countUnsyncedCommits(): number | null {
    if (!existsSync(join(workdir, ".git"))) return null;
    const r = runner.exec(["git", "rev-list", "--count", "@{u}..HEAD"], workdir);
    if (!r.ok) return null;
    const text = r.stdout.trim();
    if (!/^\d+$/.test(text)) return null;
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : null;
  }

  /** 删除传播的基线版本：优先"上次成功同步的远端 sha"；旧状态没有 sha 但确实同步过 →
   *  用 workdir HEAD（= 上次镜像到的内容）；从未同步过（首推 / 新机器）→ null。
   *  为什么首推不传播：新机器本地镜像可能不完整，拿它当"真相"会把远端记忆整体清空。
   *  代价只是"第一次 push 不传删除"，紧随其后的 pull 会写入 sha，下一轮即生效。 */
  function deletionBaselineRev(): string | null {
    if (lastRemoteSha !== null) return lastRemoteSha;
    if (lastPushAt !== null || lastPullAt !== null) return "HEAD";
    return null;
  }

  /** push 前把"基线里还有、本地已删"的同步文件从 workdir 删掉，随后 `git add -A` 就会把删除
   *  写进提交（issue #21）。三道闸：本地镜像为空不删 / 基线未知不删 / 只删基线里存在且在
   *  同步范围内的路径——"本地新增但还没拉过"的文件永远不在基线里，绝不被误判成删除。 */
  function pruneDeletedFromWorkdir(files: SyncFileEntry[]): number {
    if (files.length === 0) return 0;
    const rev = deletionBaselineRev();
    if (rev === null) return 0;
    let pruned = 0;
    for (const repoPath of listPendingDeletions({ rev, workdir, runner })) {
      const dest = join(workdir, repoPath);
      if (!existsSync(dest)) continue;
      try {
        unlinkSync(dest);
        pruned++;
      } catch {
        // 删不掉就保留差异，下次 push 再试——不假装传播成功
      }
    }
    return pruned;
  }

  /** 远端删除优先（issue #21）：基线里还有、现在 `origin/<branch>` 里没有的文件 → 删本地副本。
   *  与 push 侧共用同一套"范围 + 基线"判据，只认**明确的远端删除**（git diff --diff-filter=D），
   *  本地新增未推的文件不会出现在 diff 里，因此不会被误删。
   *  基线未知（首次 pull / 旧状态文件）→ 不删：宁可少收敛一轮，也不拿不完整信息动本地记忆。
   *  删除前一律先备份 `.bak.<ts>`——本地可能改过而远端已删，安全网不能少。 */
  function propagateRemoteDeletions(): { deleted: number; backedUp: number } {
    if (lastRemoteSha === null) return { deleted: 0, backedUp: 0 };
    const diff = runner.exec(
      ["git", "diff", "--name-only", "--diff-filter=D", lastRemoteSha, `origin/${config.branch}`],
      workdir,
    );
    if (!diff.ok) return { deleted: 0, backedUp: 0 };
    let deleted = 0;
    let backedUp = 0;
    for (const line of diff.stdout.split("\n")) {
      const repoPath = line.trim();
      if (repoPath === "" || !isSyncRepoPath(repoPath)) continue;
      const local = join(homedir(), ".opencode", repoPath);
      if (!existsSync(local)) continue;
      try {
        backupBeforeOverwrite(local);
        backedUp++;
        unlinkSync(local);
        deleted++;
      } catch {
        // 删不掉（权限/占用）→ 本地副本保留，下次 pull 再收敛，不静默丢内容
      }
    }
    return { deleted, backedUp };
  }

  async function push(): Promise<SyncResult> {
    if (!active) return { ok: false, kind: "error", message: "sync 未启用（enabled=false 或 machineName 为空）" };
    try {
      // PII 闸门先于任何 git 动作：block 层命中即拒推，一个字节都不出门；
      // alert 层只告警不阻断（issue #33），但命中明细必须落持久留痕。
      const files = listToSync();
      const piiHits: PiiFileHit[] = [];
      for (const f of files) {
        let text = "";
        try {
          text = readFileSync(f.localPath, "utf8");
        } catch {
          continue;
        }
        for (const h of scanSensitive(text)) piiHits.push({ file: f.repoPath, ...h });
      }
      const blockHits = piiHits.filter((h) => h.tier === "block");
      const alertHits = piiHits.filter((h) => h.tier === "alert");
      const scannedAt = new Date().toISOString();
      const alertDetails = alertHits.map((h) => ({ file: h.file, pattern: h.pattern, line: h.line }));
      lastPiiScan = {
        at: scannedAt,
        files: files.length,
        hits: piiHits.length,
        blocked: blockHits.length,
        alerted: alertHits.length,
        alertHits: alertDetails,
      };
      // 先落持久留痕再动 git：即便下面的 clone/commit/push 失败，alert 命中也不会丢
      if (alertDetails.length > 0) recordPiiAlerts(alertDetails, scannedAt);
      save();
      if (blockHits.length > 0) {
        lastError = `PII 闸门拦截：${blockHits.length} 处敏感信息命中`;
        alert("critical", "SYNC_PII_BLOCKED", `${lastError}（${files.length} 个待推文件），已拒推`);
        save();
        return { ok: false, kind: "pii-blocked", message: lastError, piiHits };
      }
      if (alertHits.length > 0) {
        // 只告警不阻断：内容照推，告警只是即时提醒；持久事实在 lastPiiScan / piiAlertLog
        alert(
          "warn",
          "SYNC_PII_ALERTED",
          `${alertHits.length} 处低置信 PII 命中（已放行；明细：pnpm sync:op pii）`,
        );
      }
      return await withSyncLock(() => pushLocked(files));
    } catch (err) {
      return failFast(err instanceof Error ? err.message : String(err));
    }
  }

  /** 锁内部分：镜像 → commit → push（含一次 rebase 重试）。 */
  function pushLocked(files: SyncFileEntry[]): SyncResult {
    const ensured = ensureRepo();
    if (!ensured.ok) return failFast(`clone 失败：${ensured.error ?? "无输出"}`);

    for (const f of files) {
      const dest = join(workdir, f.repoPath);
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(f.localPath, dest);
    }
    // 本地已删、远端仍有的同步文件：从镜像里删掉，让下面的 add -A 把删除写进提交（issue #21）
    const pruned = pruneDeletedFromWorkdir(files);

    const status = runner.exec(["git", "status", "--porcelain"], workdir);
    const noFileDiff = status.ok && status.stdout.trim() === "";
    // issue #12：无文件差异不等于无事可做——断网期攒下的未推提交也必须在这里推出去。
    // 无条件先数一次未推提交（不看 status），>0 就一定要真的 git push。
    // count 为 null（workdir 未 clone / 无上游 / git 不可用）→ fail-open：不据此短路，走完整流程。
    const unsynced = countUnsyncedCommits();
    if (unsynced !== null) unsyncedCommits = unsynced;
    if (noFileDiff && unsynced === 0) {
      // 通道正常但确实无改动，同样算恢复：销瞬时故障账（SYNC_PII_BLOCKED / SYNC_CONFLICT 需人工，不在此销）
      opts.alerts.resolve("SYNC_ERROR");
      opts.alerts.resolve("SYNC_PUSH_FAILED");
      save();
      return { ok: true, kind: "no-change", message: "无改动（无文件差异且无未推提交）" };
    }

    // 有未推提交但没有新文件差异 → 不造空提交，直接走到 push 把积压送出去。
    let message = "";
    if (noFileDiff) {
      message = `memx@${config.machineName}: 补推 ${unsynced ?? "?"} 个未推提交`;
    } else {
      runner.exec(["git", "add", "-A"], workdir);
      const num = runner.exec(["git", "diff", "--cached", "--numstat"], workdir);
      message = `memx@${config.machineName}: ${summarizeNumstat(num.stdout)}`;
      const commit = runner.exec(commitCommand(message), workdir);
      if (!commit.ok) return failFast(`commit 失败：${commit.stderr.trim() || commit.reason || "无输出"}`);
    }

    let pushRes = runner.exec(["git", "push", "origin", config.branch], workdir);
    if (!pushRes.ok) {
      // 非快进（或任何 push 失败）→ fetch + rebase + 重试一次；不进入重试风暴
      runner.exec(["git", "fetch", "origin", config.branch], workdir);
      const rebase = runner.exec(["git", ...SYNC_IDENTITY_ARGS, "rebase", `origin/${config.branch}`], workdir);
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
        lastError = `push 重试仍失败：${pushRes.stderr.trim() || pushRes.reason || "无输出"}`;
        alert("warn", "SYNC_PUSH_FAILED", lastError);
        consecutiveFailures++;
        save();
        return { ok: false, kind: "error", message: lastError };
      }
    }

    // 成功即销账：SYNC_ERROR / SYNC_PUSH_FAILED 是瞬时故障账，恢复即清。
    // SYNC_PII_BLOCKED / SYNC_CONFLICT 不自动销——需人工处置（改文件 / 解冲突），见下。
    opts.alerts.resolve("SYNC_ERROR");
    opts.alerts.resolve("SYNC_PUSH_FAILED");
    lastPushAt = new Date().toISOString();
    lastError = "";
    consecutiveFailures = 0;
    // push 成功 = 本地提交已全部出门（含这次顺带补推的积压）→ 归零，别让状态面板继续报旧数
    unsyncedCommits = 0;
    // 远端 tip 此刻 == 本次镜像结果：记下来供 pull 的删除基线与前置短路使用。
    // 不记的话，下一次 pull 的 diff 基线还停在 push 之前，可能把"push 后又本地重建"的文件当成远端删除。
    lastRemoteSha = readOriginSha() ?? lastRemoteSha;
    save();
    const prunedNote = pruned > 0 ? `；传播删除 ${pruned} 个` : "";
    return { ok: true, kind: "pushed", message: `${message}${prunedNote}` };
  }

  async function pull(pullOpts?: { force?: boolean }): Promise<SyncResult> {
    if (!active) return { ok: false, kind: "error", message: "sync 未启用（enabled=false 或 machineName 为空）" };
    try {
      return await withSyncLock(() => pullLocked(pullOpts));
    } catch (err) {
      return failFast(err instanceof Error ? err.message : String(err));
    }
  }

  /** 锁内部分：fetch + rebase → 镜像回本地（覆盖前备份）。
   *  前置短路：记得上次成功的远端 sha 且与远端一致 → 一次 `ls-remote` 就收工（省夜里空转）。 */
  function pullLocked(pullOpts?: { force?: boolean }): SyncResult {
    const ensured = ensureRepo();
    if (!ensured.ok) return failFast(`clone 失败：${ensured.error ?? "无输出"}`);

    // 短路只敢在"完全确定"时开：有 sha 记忆 + 上次 pull 是成功的（无 lastError、无失败累计）。
    // 任何一项不满足都不探远端，直接走完整流程——first run / 上一轮失败后必须真拉。
    if (!pullOpts?.force && lastRemoteSha !== null && consecutiveFailures === 0 && lastError === "") {
      const ls = runner.exec(["git", "ls-remote", "origin", `refs/heads/${config.branch}`], workdir);
      const remoteSha = ls.ok ? parseLsRemoteSha(ls.stdout) : "";
      if (remoteSha !== "" && remoteSha === lastRemoteSha) {
        // 只刷新时间戳（状态面板"活着"的语义）。跳过不是一次真拉取：不销账、不动 lastError/consecutiveFailures。
        lastPullAt = new Date().toISOString();
        save();
        return { ok: true, kind: "no-change", message: `远端无新提交，跳过拉取（${remoteSha.slice(0, 7)}）` };
      }
      // ls-remote 失败 / 远端变了 / 解析不出 sha → fail-open：继续走原来的完整 pull，绝不因优化中断。
    }

    const fetched = runner.exec(["git", "fetch", "origin", config.branch], workdir);
    if (!fetched.ok) return failFast(`fetch 失败：${fetched.stderr.trim() || fetched.reason || "无输出"}`);

    const rebase = runner.exec(["git", ...SYNC_IDENTITY_ARGS, "rebase", `origin/${config.branch}`], workdir);
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
    let backedUp = 0;
    // 远端删除先于回拷：先把"远端已删"的本地副本删掉（带 .bak），再按远端镜像回拷新增/修改。
    const removed = propagateRemoteDeletions();
    backedUp += removed.backedUp;
    for (const f of listFromWorkdir(workdir)) {
      const src = join(workdir, f.repoPath);
      mkdirSync(dirname(f.localPath), { recursive: true });
      if (existsSync(f.localPath)) {
        let differs = true;
        try {
          differs = readFileSync(f.localPath, "utf8") !== readFileSync(src, "utf8");
        } catch {
          differs = true;
        }
        if (differs) {
          backupBeforeOverwrite(f.localPath);
          backedUp++;
        }
      }
      copyFileSync(src, f.localPath);
      copied++;
    }

    // 成功即销账（同 pushLocked）：瞬时故障恢复即清；SYNC_PII_BLOCKED / SYNC_CONFLICT 需人工处置，不在此销
    opts.alerts.resolve("SYNC_ERROR");
    opts.alerts.resolve("SYNC_PUSH_FAILED");
    lastPullAt = new Date().toISOString();
    lastError = "";
    consecutiveFailures = 0;
    // 记下这次拉到哪个远端 sha：下次 pull 的前置短路拿它做比对（取不到 → null = 未知，下次真拉）
    lastRemoteSha = readOriginSha();
    // 顺手刷一次未推提交数（rebase 之后本地积压可能变化；取不到就保持旧值，不拿 null 覆盖）
    unsyncedCommits = countUnsyncedCommits() ?? unsyncedCommits;
    save();
    const deletedNote = removed.deleted > 0 ? `，移除 ${removed.deleted} 个远端已删文件` : "";
    const backupNote = backedUp > 0 ? `（${backedUp} 个本地差异件已备份为 .bak.<时间戳>）` : "";
    return { ok: true, kind: "pulled", message: `已拉取 ${copied} 个文件${deletedNote}${backupNote}` };
  }

  /** 只读状态：pendingFiles 现算（本地镜像 + 待传播删除），unsyncedCommits 用最近一次观测值。
   *  pendingDeletions 需要 `git ls-tree` 读基线树——纯本地、不联网；workdir 不在时为 0。
   *  （不在状态查询里跑 fetch/push 那类网络动作：doctor/status 的高频调用不该被远端拖住。） */
  function status(): SyncStatus {
    const localFiles = listToSync();
    const rev = deletionBaselineRev();
    const pendingDeletions = rev === null ? 0 : listPendingDeletions({ rev, workdir, runner }).length;
    return {
      lastPushAt,
      lastPullAt,
      lastError,
      pendingFiles: localFiles.length + pendingDeletions,
      pendingDeletions,
      consecutiveFailures,
      unsyncedCommits,
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
