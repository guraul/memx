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
  echo "[1/5] Repo exists, pulling latest..."
  git -C "$REPO_PATH" pull --ff-only
else
  echo "[1/5] Cloning repo..."
  git clone https://github.com/guraul/memx.git "$REPO_PATH"
fi
echo ""

# Step 2: Install dependencies
echo "[2/5] Installing dependencies..."
cd "$REPO_PATH"
npm install
echo ""

# Step 3: Create plugin entry
echo "[3/5] Creating plugin entry..."
mkdir -p "$OCP_CONFIG_DIR/plugins"
cat > "$OCP_CONFIG_DIR/plugins/memx.ts" <<EOF
export { MemxPlugin } from "$REPO_PATH/src/index";
EOF
echo "  -> $OCP_CONFIG_DIR/plugins/memx.ts"
echo ""

# Step 4: Ensure package.json has dependencies
echo "[4/5] Ensuring dependencies declared..."
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

# Step 5: Add instructions to opencode.json
echo "[5/5] Configuring instructions in opencode.json..."
OCP_JSON="$OCP_CONFIG_DIR/opencode.json"

if [ ! -f "$OCP_JSON" ]; then
  # Create new config
  cat > "$OCP_JSON" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "instructions": ["~/.opencode/USER.md", "~/.opencode/MEMORY.md"]
}
EOF
  echo "  -> Created $OCP_JSON with instructions"
elif grep -q '"instructions"' "$OCP_JSON"; then
  echo "  -> $OCP_JSON already has instructions field"
  echo "     Please ensure it includes: \"~/.opencode/USER.md\" and \"~/.opencode/MEMORY.md\""
else
  echo "  -> $OCP_JSON exists but has no instructions field"
  echo "     Please add this line manually:"
  echo '     "instructions": ["~/.opencode/USER.md", "~/.opencode/MEMORY.md"],'
fi
echo ""

# Done
echo "=== Installation complete ==="
echo ""
echo "Next steps:"
echo "  1. Restart OpenCode"
echo "  2. Run /status to verify memx is loaded"
echo "  3. (Optional) Create ~/.config/opencode/AGENTS.md with the signal marking prompts"
echo "     See: https://github.com/guraul/memx#installation"
