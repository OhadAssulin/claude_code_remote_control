- once you change the extnesion, please reinstall it
- the right way to rebuild: # 1. Remove old extension folder completely
rm -rf ~/.vscode/extensions/shift-left.shift-left-claude-code-0.1.0

# 2. Reinstall from the marketplace
code --install-extension shift-left.shift-left-claude-code

# 3. Go into the extension directory (version may change after reinstall)
cd ~/.vscode/extensions/shift-left.shift-left-claude-code-*

# 4. Fresh install deps
rm -rf node_modules
npm ci

# 5. Rebuild node-pty for VS Code’s Electron runtime (arm64)
npx @electron/rebuild -f -w node-pty -v 34.2.0 -a arm64
- you should not open new vs code, I will reload the window when needed