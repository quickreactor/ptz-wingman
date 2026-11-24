import WebSocket from 'ws'
import { createRelayLink } from './agent.js'
import { control, parse } from './protocol.js'

const DEFAULT_LOG = (message) => console.log(`[camera] ${message}`)

/**
 * Runs next to PTZ Pilot on the locked-down PC. It dials OUT to the relay, then bridges the relay
 * to PTZ Pilot's local WebSocket API. If either side drops, the local API socket is closed, which
 * makes PTZ Pilot clear that client's held movements.
 */
export function createCameraAgent({ relayUrl, room, token, pilotUrl = 'ws://127.0.0.1:8765', log = DEFAULT_LOG }) {
	let pilot
	let pilotRetry
	let pilotBackoff = 1000
	let stopped = false
	// PTZ Pilot sends hello/state once per connection. A Companion client that arrives later
	// needs them too, so keep the last copy and replay it on request.
	const snapshot = new Map()

	function stopPilot(reason) {
		if (!pilot) return
		log(`closing PTZ Pilot connection (${reason})`)
		const closing = pilot
		pilot = undefined
		closing.removeAllListeners('message')
		closing.close(1000, reason)
	}

	function openPilot() {
		if (stopped || pilot || pilotRetry) return
		const url = pilotUrl
		log(`connecting to PTZ Pilot at ${url}`)
		const ws = new WebSocket(url, { handshakeTimeout: 5000 })
		pilot = ws

		ws.on('open', () => {
			log('PTZ Pilot connected')
			pilotBackoff = 1000
		})

		ws.on('message', (data, isBinary) => {
			if (isBinary) return
			const text = data.toString()
			const message = parse(text)
			if (message && (message.type === 'hello' || message.type === 'state')) snapshot.set(message.type, text)
			if (!link.send(text)) log('dropped PTZ Pilot message: relay is down')
		})

		ws.on('close', () => {
			if (pilot !== ws) return
			pilot = undefined
			log('PTZ Pilot disconnected')
			// The remote client must not keep a held move showing as live when PTZ Pilot is gone.
			link.send(control('peer-gone', { role: 'pilot' }))
			if (stopped) return
			pilotRetry = setTimeout(() => {
				pilotRetry = undefined
				openPilot()
			}, pilotBackoff)
			pilotBackoff = Math.min(pilotBackoff * 2, 10000)
		})

		ws.on('error', (error) => {
			log(`PTZ Pilot error: ${error.message}`)
			if (ws.readyState === WebSocket.CONNECTING) ws.terminate()
		})
	}

	const link = createRelayLink({
		baseUrl: relayUrl,
		role: 'camera',
		room,
		token,
		log,
		onOpen: () => openPilot(),
		onClose: () => stopPilot('relay down'),
		onControl(type) {
			if (type === 'peer-gone') stopPilot('remote client left')
			if (type === 'error') log('relay rejected the connection')
			if (type === 'refresh') {
				for (const key of ['hello', 'state']) {
					const text = snapshot.get(key)
					if (text && !link.send(text)) log(`could not replay ${key}: relay is down`)
				}
			}
		},
		onData(text) {
			if (pilot?.readyState === WebSocket.OPEN) pilot.send(text)
			else log('dropped remote command: PTZ Pilot is not connected')
		},
	})

	return {
		start() {
			stopped = false
			link.start()
		},
		stop() {
			stopped = true
			clearTimeout(pilotRetry)
			link.stop()
			stopPilot('shutting down')
		},
		/** For tests and diagnostics */
		get pilotConnected() {
			return pilot?.readyState === WebSocket.OPEN
		},
	}
}
