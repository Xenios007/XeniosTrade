#!/bin/sh
set -eu
app=/home/xenios/app
release=/home/xenios/app-backups/consolidated-20260913
cd "$app"
# Refuse to replace a baseline that changed since inspection.
echo 'c07b25f2999f243a5d1a1af97ff4519759eda8356f9725d449e2e9d30ba80ff9  server/mock-trading-server.js
0ccb6200201e9736adf49ddc779c2cb2c2b1b92b76c2957d653bb656c66f043f  src/App.jsx
979feb7677968ec3b3d295b30eefcb0a5922544a22275b4360c530f41ca4c319  src/components/shell/navItems.js
7816a1e4548ed2b09a1303e48fcb10d046fb63e7bf10b83eac6f379009bf2aee  package.json
7c5c9ac1b207e8d3c6afcf6cb3bca1082e7d683f94dcc38ed2e9e389a961d44b  SESSION_LOG.md' | sha256sum -c -
test ! -e "$release/original.tgz"
test -w /var/www/xeniostrade
tar -czf "$release/original.tgz" server/mock-trading-server.js src/App.jsx src/components/shell/navItems.js package.json SESSION_LOG.md dist
cp /home/xenios/agent.md "$release/agent-original.md"
tar -xf "$release/additions.tar"
tar -xf "$release/integration.tar"
cp "$release/worktree/server/consolidated-testnet.js" server/consolidated-testnet.js
node --check server/mock-trading-server.js
rsync -a "$release/worktree/dist/" dist/
rsync -r --no-times "$release/worktree/dist/" /var/www/xeniostrade/
cp "$release/agent-updated.md" /home/xenios/agent.md
pm2 restart xeniostrade-api
