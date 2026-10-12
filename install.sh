#!/usr/bin/env bash
set -euo pipefail

# memx installer
# Usage: bash install.sh [repo-path]
# Default repo-path: ~/.config/memx

REPO_PATH="${1:-$HOME/.config/memx}"
OCP_CONFIG_DIR="$HOME/.config/opencode"
OCP_DATA_DIR="$HOME/.opencode"

echo "=== memx installer ==="
echo "Repo path: $REPO_PATH"
echo "Config dir: $OCP_CONFIG_DIR"
echo ""

# Step 1: Clone repo
if [ -d "$REPO_PATH/.git" ]; then
  echo "[1/6] Repo exists, pulling latest..."
  git -C "$REPO_PATH" pull --ff-only
else
  echo "[1/6] Cloning repo..."
  git clone https://github.com/guraul/memx.git "$REPO_PATH"
fi
echo ""

# Step 2: Install dependencies
echo "[2/6] Installing dependencies..."
cd "$REPO_PATH"
npm install
echo ""

# Step 3: Create plugin entry
echo "[3/6] Creating plugin entry..."
mkdir -p "$OCP_CONFIG_DIR/plugins"
cat > "$OCP_CONFIG_DIR/plugins/memx.ts" <<EOF
export { default } from "$REPO_PATH/src/hosts/opencode/index";
EOF
echo "  -> $OCP_CONFIG_DIR/plugins/memx.ts"
echo ""

# Step 4: Ensure package.json has dependencies
echo "[4/6] Ensuring dependencies declared..."
if [ ! -f "$OCP_CONFIG_DIR/package.json" ]; then
  cat > "$OCP_CONFIG_DIR/package.json" <<EOF
{
  "dependencies": {
    "zod": "^4.4.3",
    "@opencode-ai/plugin": "^1.18.11"
  }
}
EOF
  echo "  -> Created $OCP_CONFIG_DIR/package.json"
else
  echo "  -> $OCP_CONFIG_DIR/package.json already exists, skip (ensure zod + @opencode-ai/plugin are listed)"
fi
echo ""

# Step 5: Write the signal protocol file from the single source of truth
# 协议正文只存在于 src/core/protocol-template.ts，这里跑同步脚本落盘（内容一致则不重写）。
# 协议必须独立于 USER.md：USER.md 是 memx 每次提炼都会重写的数据文件，协议放在那里会被抹掉
# （历史上真发生过：首次成功写盘就把协议块冲掉，之后所有信号捕获静默失效）。
echo "[5/6] Writing signal protocol file..."
PROTOCOL_MD="$OCP_DATA_DIR/memx-protocol.md"
if command -v node >/dev/null 2>&1; then
  # 同步脚本用 .ts 扩展名 import，需 Node 22.6+（原生 strip types）；旧版给明确指引而不是崩
  if node "$REPO_PATH/scripts/sync-protocol.ts" "$PROTOCOL_MD"; then
    echo "  -> $PROTOCOL_MD"
  else
    echo "  !! Failed to write $PROTOCOL_MD. On Node < 22.6 upgrade Node, or run manually:"
    echo "     node --experimental-strip-types $REPO_PATH/scripts/sync-protocol.ts $PROTOCOL_MD"
    exit 1
  fi
else
  echo "  !! node not found on PATH; cannot generate $PROTOCOL_MD. Install Node 22.6+ and re-run."
  exit 1
fi
echo ""

# Step 6: Register instructions in opencode.json
# 三个条目各司其职：前两个注入累积数据（画像 / 记忆），第三个注入协议（怎么发信号）。
# 幂等：已存在的条目不重复添加，别的条目不重排；opencode.json 不存在则新建；坏 JSON 直接报错
# 退出，绝不覆盖用户配置。
echo "[6/6] Configuring instructions in opencode.json..."
OCP_JSON="$OCP_CONFIG_DIR/opencode.json"

if ! command -v node >/dev/null 2>&1; then
  echo "  !! node not found on PATH; cannot edit $OCP_JSON. Add manually:"
  echo '     "instructions": ["~/.opencode/USER.md", "~/.opencode/MEMORY.md", "~/.opencode/memx-protocol.md"]'
  exit 1
fi

node - "$OCP_JSON" <<'NODE'
const fs = require("fs");
const path = require("path");
const file = process.argv[2];

let cfg;
if (fs.existsSync(file)) {
  cfg = JSON.parse(fs.readFileSync(file, "utf8"));
} else {
  // 目录可能也不存在（纯净机器 / 容器），先建出来再写
  fs.mkdirSync(path.dirname(file), { recursive: true });
  cfg = { $schema: "https://opencode.ai/config.json" };
  console.log("  -> created new config");
}
if (cfg.instructions !== undefined && !Array.isArray(cfg.instructions)) {
  throw new Error(file + ': "instructions" exists but is not an array - fix by hand, nothing written');
}
if (!Array.isArray(cfg.instructions)) cfg.instructions = [];

const managed = [
  "~/.opencode/USER.md",          // Track 1 累积画像
  "~/.opencode/MEMORY.md",        // Track 2 记忆索引
  "~/.opencode/memx-protocol.md", // 信号协议（两条轨）
];
const added = [];
for (const entry of managed) {
  if (!cfg.instructions.includes(entry)) {
    cfg.instructions.push(entry);
    added.push(entry);
  }
}
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
console.log(added.length ? "  -> added: " + added.join(", ") : "  -> instructions already up to date");
NODE
echo "  -> $OCP_JSON"
echo ""

# Done
echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "  1. Restart OpenCode (instructions load at session start, not mid-session)"
echo "  2. Run /status to verify memx is loaded"
echo "  3. Upgrading from an older install? Delete any hand-written signal-protocol block"
echo "     from ~/.opencode/USER.md - the protocol now lives in memx-protocol.md, and"
echo "     USER.md is rewritten by every refinement."
echo "  4. Your reply UI must hide HTML comments. Verify no <!-- STYLE_SIGNAL --> text"
echo "     reaches users; see https://github.com/guraul/memx#installation"