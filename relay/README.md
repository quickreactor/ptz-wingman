# PTZ Pilot outbound relay

Control PTZ Pilot **remotely** when the PC running it is on a locked-down network: no inbound
connections, no port forwards. Both sides connect *out* to a rendezvous point and the relay pipes
PTZ Pilot's own WebSocket API between them. There is no Companion dependency — the remote side is
a small browser page that speaks the API directly.

```
 locked-down PC                    Cloudflare                      remote computer
┌────────────────┐          ┌──────────────────────┐         ┌──────────────────────┐
│ PTZ cameras    │          │ Worker + Durable Obj │         │ web/index.html       │
│   ↓ VISCA      │          │  room "stage"        │         │ browser WebSocket    │
│ PTZ Pilot:8765 │◄─ WSS ──►│  camera ⇄ remote     │◄─ WSS ──►│ move / presets / home│
│ camera-agent   │  outbound│                      │ outbound│ state / telemetry   │
└────────────────┘          └──────────────────────┘         └──────────────────────┘
```

The browser page asks the camera agent for a replay of PTZ Pilot's `hello` and `state`, then sends
ordinary API requests (`move`, `stop`, `presetRecall`, `presetStore`, `home`, `onePushFocus`,
`autoFocus`, `selectCamera`, `getState`). You can drive both cameras by selecting the active camera.

> One remote client per room is intentional: PTZ Pilot scopes hold-to-move commands to a
> connection, so multiplexing two clients over one bridge would let one `stop` cancel another's
> `move`. Use separate rooms for separate remote clients.

## Safety

- PTZ Pilot's API has **no authentication**. Never expose it directly to a network. The shared
  token is the only gate to the relay — generate a long random one and treat the full client URL
  as a credential.
- Always use `wss://` in production (Cloudflare provides it). The self-hosted server speaks
  `ws://` and is for loopback tests or behind a TLS reverse proxy.
- If the browser, the camera agent, PTZ Pilot or the relay connection drops, the bridge is torn
  down so a held `move` cannot keep running. PTZ Pilot also has its own 5-second ping checks.
- The self-hosted relay drops peers that stop answering for 15 seconds.

## Quick local test (no Cloudflare)

Requires Node 20+.

```powershell
cd relay
npm install
npm test                       # end-to-end tests with a fake PTZ Pilot and a real WS client

$env:RELAY_TOKEN = "change-me-to-a-long-random-string"
node src/index.js server       # ws://127.0.0.1:8787
# in a second terminal:
node src/index.js camera --relay-url ws://127.0.0.1:8787 --room stage --pilot-url ws://127.0.0.1:8765
```

Open `relay/web/index.html` in a browser, enter:

- Relay URL: `ws://127.0.0.1:8787`
- Room: `stage`
- Token: the same secret

PTZ Pilot itself must be running with its Remote control API enabled (on by default). With the
camera agent running on the same machine, leave **Allow connections from other computers** off —
the agent connects locally, so the API is never exposed to the LAN.

## Cloudflare deployment

1. Create a Cloudflare account and a Workers project.
2. In `relay/cloudflare/`, run `npx wrangler login`, then `npx wrangler secret put RELAY_TOKEN`
   (use a long random value), then `npx wrangler deploy`.
3. Note the URL, e.g. `https://ptz-pilot-relay.<account>.workers.dev`.
4. Start the camera agent on the locked-down PC (the Windows app is built from this repo's root):

   ```powershell
   $env:RELAY_TOKEN = "<same secret>"
   node src/index.js camera --relay-url wss://ptz-pilot-relay.<account>.workers.dev --room stage
   ```

5. On the remote computer, open `web/index.html` (serve it over HTTPS or locally), enter the
   `wss://` relay URL, room `stage` and the token, then press Connect.

The camera agent reconnects automatically with exponential backoff. `RELAY_URL`, `RELAY_ROOM`,
`RELAY_TOKEN` and `PILOT_URL` can be used instead of flags.

Optional hardening: put Cloudflare Access in front of the Worker. This implementation sends the
shared token in the WebSocket URL rather than service-token headers, so if you use Access you
should either restrict routes to known IPs or extend the client to send headers.

## Alternatives

- **Self-hosted relay**: run `src/index.js server` on a VPS with a TLS reverse proxy. Same protocol.
- **Tailscale**: join both PCs to a tailnet and let the remote page connect to the relay running on
  the camera PC over the private mesh. Lowest latency if a VPN is permitted.
- **Cloudflare Tunnel**: expose the camera PC's `127.0.0.1:8787` relay as `wss://ptz.example.com`.
  No code changes needed — the browser page already uses a full URL.
- Change the room name to run several independent camera sites through the same Worker.

## Files

| Path | Purpose |
| --- | --- |
| `src/protocol.js` | Reserved `__relay` control frames, URL builder, token comparison |
| `src/server.js` | Self-hostable relay server (rooms, auth, heartbeat, peer-gone) |
| `src/agent.js` | Shared outbound WS link with reconnect and heartbeat |
| `src/camera-agent.js` | Camera-side bridge to PTZ Pilot, with hello/state replay |
| `src/index.js` | CLI: `server` and `camera` |
| `web/index.html` | Remote controller page (direct PTZ Pilot API client) |
| `cloudflare/` | Equivalent Worker + Durable Object |
| `test/e2e.test.js` | Loopback integration tests |
