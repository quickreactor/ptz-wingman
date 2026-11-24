# PTZ Wingman

A personal fork of [PTZ Pilot](https://github.com/josephdadams/ptz-pilot) — fly PTZ cameras with a
game controller, now with **Windows builds** and an **outbound relay for fully remote control**.

MIT licensed, as upstream.

## What's here

| Path | What it is |
| --- | --- |
| Root (`src/`, `docs/`, `package.json`, …) | Upstream PTZ Pilot source, plus Windows NSIS packaging |
| `relay/` | Outbound WebSocket relay + browser controller (no extra control software needed) |
| `FINDINGS.md` | Research notes, remote-control options and tradeoffs |

Verified on Windows: `npm install`, `npm run build`, `npm test` (104 tests), and
`npx electron-builder --win` → `release/ptz-pilot-v1.1.0-win-x64.exe`.

## Build the Windows app

```powershell
npm install
npm run build
npm test
npm run dist:win        # NSIS installer in release/
```

## Remote control

The camera PC runs PTZ Pilot plus the relay's camera agent. The remote computer just opens
`relay/web/index.html` in Chrome. Both connect **outbound** to a Cloudflare Worker, so no inbound
ports, VPN or port forwarding are needed.

1. Create the Worker once:

   ```powershell
   cd relay\cloudflare
   npx wrangler login
   npx wrangler secret put RELAY_TOKEN
   npx wrangler deploy
   ```

2. On the camera PC, with PTZ Pilot running:

   ```powershell
   cd relay
   npm install
   set "RELAY_TOKEN=<your secret>"
   set "RELAY_URL=https://ptz-pilot-relay.<account>.workers.dev"
   node src\index.js camera
   ```

3. On the remote computer, open `relay/web/index.html`, enter the same `wss://`/`https://` relay
   URL, room `stage` and token, then click Connect.

Full step-by-step, local test and troubleshooting: `relay/README.md`.

## Keeping in sync

`origin` is this fork; `upstream` is the original repo:

```powershell
git fetch upstream
git merge upstream/main      # bring in original releases
git push origin main         # push your changes to this fork
```

On another computer: `git clone https://github.com/quickreactor/ptz-wingman.git`, then add
`upstream` as shown above.
