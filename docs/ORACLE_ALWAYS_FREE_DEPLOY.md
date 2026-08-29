# Oracle Cloud Always Free Deployment

This app is now ready to run on a single Oracle Always Free VM:

- the React frontend is built with `npm run build`
- the Node server serves `dist/` directly in production
- the mock API, SSE stream, auto-trade loop, and frontend all run from one process

## 1. Create the VM

Recommended setup:

- Oracle Cloud Always Free compute instance
- Ubuntu image
- public IPv4 enabled
- open inbound TCP ports `22` and `3001`

If you later place Nginx or Caddy in front, you can expose `80` and `443` instead and keep Node on `3001`.

## 2. Install system packages

```bash
sudo apt update
sudo apt install -y git build-essential curl
```

## 3. Install Node with nvm

```bash
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.nvm/nvm.sh
nvm install --lts
nvm use --lts
node -v
npm -v
```

## 4. Upload the project

Clone or copy the repo to the VM, for example:

```bash
cd /home/ubuntu
git clone <your-repo-url> trade
cd trade
```

## 5. Install and build

```bash
npm install
npm run build
cp .env.example .env
```

Edit `.env` and set the values you want, especially:

```bash
NODE_ENV=production
HOST=0.0.0.0
PORT=3001
SERVE_FRONTEND=true
BINANCE_TESTNET_API_KEY=your_testnet_api_key
BINANCE_TESTNET_SECRET_KEY=your_testnet_secret_key
```

## 6. Test the app manually

```bash
npm start
```

Then open:

- `http://your-vm-public-ip:3001`
- `http://your-vm-public-ip:3001/healthz`

When the app works, stop it with `Ctrl+C` and move on to the service setup.

## 7. Install the systemd service

The template is in:

- `deploy/oracle/xeniostrade.service`

Copy it into systemd:

```bash
sudo cp deploy/oracle/xeniostrade.service /etc/systemd/system/xeniostrade.service
```

If your Linux username or app path differs, update these fields first:

- `User`
- `WorkingDirectory`
- `ExecStart`

Then enable and start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable xeniostrade
sudo systemctl start xeniostrade
sudo systemctl status xeniostrade
```

Useful logs:

```bash
journalctl -u xeniostrade -f
```

## 8. Persistence notes

The mock server writes local JSON files under:

- `server/data/settings.json`
- `server/data/trade-history.json`
- `server/data/auto-trade-log.json`
- `server/data/workflow-review-log.json`

That means:

- your mock-testing data survives process restarts on the same VM
- data is still local to that VM
- taking backups of `server/data/` is a good idea

## 9. Updating the app

```bash
cd /home/ubuntu/trade
git pull
npm install
npm run build
sudo systemctl restart xeniostrade
```

## 10. Optional next step

For a cleaner public URL, put Nginx or Caddy in front and reverse-proxy to `127.0.0.1:3001`.
