# PTZ Pilot research: Windows build + remote control

Date: 2026-11-24

## TL;DR

- **PTZ Pilot is not really Mac-only in code** — it is an Electron + TypeScript app. Only the
  release artifacts are Mac-only. The Windows blockers are packaging config, not source code.
- The app has a built-in **WebSocket API on port 8765** that exposes all camera control. That API is
  the whole remote-control story; no extra control software is required.
- The API has **no authentication** and binds only to `127.0.0.1` by default. On a locked-down
  network, do not enable "Allow connections from other computers" — use an outbound relay instead.
- Recommended design: **outbound-only relay**. A camera-side agent dials out to a Cloudflare Worker;
  a browser page on the remote computer also dials out to the same Worker, and the Worker pipes the
  PTZ Pilot API between them. Nothing needs an inbound port.

## What was downloaded

| Path | Source | Notes |
| --- | --- | --- |
| This repo (`quickreactor/ptz-wingman`) | fork of `github.com/josephdadams/ptz-pilot` | MIT, v1.1.0, Electron/TypeScript, 715 kB source |

Releases (`v1.1.0`) contain only Mac DMG/ZIP files. The GitHub workflow
(`.github/workflows/build.yml`) only builds on `macos-latest`.

## 1. Making PTZ Pilot work on PC

The source is cross-platform already:

- `src/main/tray.ts` picks `trayTemplate.png` on macOS and `tray.png` elsewhere.
- `native/input-monitoring.c` is a macOS-only helper for keyboard-like controllers (Magicsee R1).
  `tools/build-native.cjs` is a no-op outside macOS, and `main.ts` guards the prompt with
  `process.platform !== 'darwin'`. Nothing to port.
- Camera transports are UDP/TCP/serial protocols (VISCA, Canon, Panasonic, Hikvision, Hanwha,
  ONVIF, KXWell) — no macOS frameworks.
- Controllers use the standard Gamepad API, `node-hid` and `serialport`, all of which ship Windows
  prebuilds.

Actual blockers:

1. `package.json` only defined `dist:mac`; no `--win` target. Upstream PR
   [josephdadams/ptz-pilot#4](https://github.com/josephdadams/ptz-pilot/pull/4) added it but was
   closed unmerged. Its patch was applied locally.
2. `build.files` excluded **win32** prebuilds for `node-hid` and `serialport`, so a packaged Windows
   app could not load its native bindings. Changed to exclude only Linux/Android.
3. `electron-updater` publishes `latest-mac.yml`; a Windows build needs `latest.yml` plus NSIS
   artifacts for self-update. A `win` NSIS target was added.

Applied changes are in `package.json` at the repo root. Verified on this Windows machine:

```
npm install
npm run build      # tsc + native step (no-op on Windows)
npm test           # 104 tests, all passing
npm run dist:win   # electron-builder --win --dir -> release/win-unpacked/PTZ Pilot.exe
```

A full NSIS installer can be produced with `npx electron-builder --win` once you have a code-signing
certificate; without one SmartScreen will warn on install.

## 2. The WebSocket API (the only thing the remote needs)

From `docs/api.md` and `src/main/api.ts`:

- Server at `ws://127.0.0.1:8765`, configurable port, `0.0.0.0` only when the user ticks
  **Allow connections from other computers**. Enabled by default, bound locally by default.
- **No authentication at all.**
- JSON messages with a `type`. App → client: `hello`, `state`, `telemetry`, `response`.
  Client → app: `getState`, `selectCamera`, `setControllerCamera`, `stepControllerCamera`,
  `presetRecall`, `presetStore`, `home`, `onePushFocus`, `autoFocus`, `move`, `stop`.
- `move` takes each axis as a fraction of top speed, `-1` to `1`, and holds until changed, stopped
  or the client disconnects. `stop` with no camera stops all of that client's movements.
- Ping/pong every 5 seconds; a dead client is dropped so a crashed controller cannot leave a camera
  turning.
- Cameras are addressed by id, name or 1-based number, so two cameras are just two entries in the
  list. `state` carries camera names/statuses and `telemetry` carries live speeds.

## 3. Remote access options

| Option | Inbound on locked LAN? | TLS/auth | Effort | Notes |
| --- | --- | --- | --- | --- |
| **A. Outbound relay via Cloudflare Worker + Durable Object** (implemented) | No — both sides dial out to `wss://` | TLS by default; shared URL token | Medium | No inbound ports, no public DNS, works through NAT. Browser controller talks the API directly. |
| **B. Self-hosted WebSocket relay on a VPS** | No — both dial out | TLS via reverse proxy | Medium | Same protocol as A; run `relay/src/index.js server`. |
| **C. Tailscale / WireGuard** | No — outbound UDP then private mesh | WireGuard encryption | Lowest | Run the relay on the camera PC and open the browser page against its tailnet address. |
| **D. Cloudflare Tunnel** | No — tunnel dials out | Cloudflare edge TLS + your own token | Low | Expose the local relay as `wss://ptz.example.com`; the browser page already accepts a full URL. |
| **E. Port forward + allowRemote** | Yes | None | Low | **Do not use**: unauthenticated camera control exposed to the internet. |

The implemented option A is the best fit because the locked-down PC only needs outbound HTTPS/WSS,
which is normally permitted. A Durable Object keyed by a room name pairs one camera-side agent with
one remote browser client and forwards raw API frames in both directions.

Tradeoffs and notes:

- WebSocket ping/pong is handled on each leg; the relay only forwards API data frames plus a small
  reserved `__relay` control channel (`hello`, `ready`, `waiting`, `peer-gone`, `refresh`, `ping`).
- The camera agent caches `hello` and `state` and replays them when a remote client connects, since
  PTZ Pilot otherwise sends them only once per connection.
- Exactly one remote client per room. PTZ Pilot scopes hold-to-move to a connection, so two clients
  multiplexed over one bridge could cancel each other's `move` with `stop`.
- WAN latency of roughly 30–150 ms is fine for presets and modest joystick speeds; reduce top speed
  in PTZ Pilot for fine control. For sub-20 ms feel use option C.

## 4. What is implemented here

- App source at the repo root — Windows packaging patch applied from upstream PR #4; verified build and tests.
- `relay/` — working, tested outbound relay:
  - `src/server.js` — self-hostable relay with token auth, room pairing, heartbeat and fail-safe
    peer-gone notification.
  - `src/camera-agent.js` — on the locked PC: connects out to the relay and to local PTZ Pilot.
  - `src/index.js` — CLI for `server` and `camera`.
  - `web/index.html` — remote controller page that speaks the PTZ Pilot API directly.
  - `cloudflare/` — equivalent Cloudflare Worker + Durable Object.
  - `test/e2e.test.js` — end-to-end tests with a fake PTZ Pilot and a real WebSocket client.

See `relay/README.md` for run instructions.
