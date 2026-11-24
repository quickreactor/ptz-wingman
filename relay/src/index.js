#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { createRelayServer } from './server.js'
import { createCameraAgent } from './camera-agent.js'

const USAGE = `Usage: node src/index.js <server|camera> [options]

The remote side is a browser client: open web/index.html, enter the relay URL,
room and token, and it speaks PTZ Pilot's WebSocket API directly.

Options:
  --relay-url URL   Relay base URL, e.g. wss://ptz-pilot-relay.<account>.workers.dev  (camera)
  --room NAME       Room name shared with the remote client (default: stage)
  --token SECRET    Shared secret (or RELAY_TOKEN)
  --pilot-url URL   PTZ Pilot API in the camera agent (default: ws://127.0.0.1:8765)
  --host ADDRESS    Relay bind address (default: 127.0.0.1)
  --port NUMBER     Relay port (default: 8787)

Environment equivalents: RELAY_URL, RELAY_ROOM, RELAY_TOKEN, PILOT_URL, HOST, PORT.
`

function main() {
	const [command, ...rest] = process.argv.slice(2)
	if (!['server', 'camera'].includes(command)) {
		process.stderr.write(USAGE)
		process.exit(2)
	}

	let values
	try {
		;({ values } = parseArgs({
			args: rest,
			options: {
				'relay-url': { type: 'string' },
				room: { type: 'string' },
				token: { type: 'string' },
				'pilot-url': { type: 'string' },
				host: { type: 'string' },
				port: { type: 'string' },
			},
			strict: true,
		}))
	} catch (error) {
		process.stderr.write(`${error.message}\n${USAGE}`)
		process.exit(2)
	}

	const token = values.token ?? process.env.RELAY_TOKEN
	if (!token) {
		process.stderr.write('A shared secret is required: pass --token or set RELAY_TOKEN.\n')
		process.exit(2)
	}
	const room = values.room ?? process.env.RELAY_ROOM ?? 'stage'
	const host = values.host ?? process.env.HOST ?? '127.0.0.1'
	const port = Number(values.port ?? process.env.PORT ?? 8787)

	let handle
	if (command === 'server') {
		handle = createRelayServer({ token, host, port })
	} else {
		const baseUrl = values['relay-url'] ?? process.env.RELAY_URL
		if (!baseUrl) {
			process.stderr.write('The camera agent needs --relay-url (or RELAY_URL).\n')
			process.exit(2)
		}
		handle = createCameraAgent({
			relayUrl: baseUrl,
			room,
			token,
			pilotUrl: values['pilot-url'] ?? process.env.PILOT_URL ?? 'ws://127.0.0.1:8765',
		})
	}

	handle.start()
	for (const signal of ['SIGINT', 'SIGTERM']) {
		process.on(signal, () => {
			handle.stop()
			setTimeout(() => process.exit(0), 100).unref()
		})
	}
}

main()
