import WebSocket from 'ws'
import { control, controlType, relayUrl } from './protocol.js'

const PING_MS = 5000
const MAX_BACKOFF_MS = 10000

/** Outbound WebSocket to the relay, with reconnect, heartbeat and JSON control frames. */
export function createRelayLink({ baseUrl, role, room, token, onControl, onData, onOpen, onClose, log = () => {} }) {
	let socket
	let ping
	let retry
	let stopped = false
	let backoff = 1000
	let didOpen = false

	function connect() {
		if (stopped) return
		const url = relayUrl(baseUrl, role, room, token)
		log(`connecting to ${new URL(url).origin} as ${role} (room ${room})`)
		socket = new WebSocket(url, { handshakeTimeout: 5000 })

		socket.on('open', () => {
			didOpen = true
			backoff = 1000
			log('relay connected')
			ping = setInterval(() => {
				if (socket?.readyState === WebSocket.OPEN) socket.send(control('ping'))
			}, PING_MS)
			onOpen?.()
		})

		socket.on('message', (data, isBinary) => {
			if (isBinary) return
			const text = data.toString()
			const type = controlType(text)
			if (type === 'ping') {
				if (socket.readyState === WebSocket.OPEN) socket.send(control('pong'))
			} else if (type) {
				onControl?.(type, text)
			} else {
				onData?.(text)
			}
		})

		const lost = (reason) => {
			clearInterval(ping)
			if (!didOpen) log(`relay unavailable (${reason})`)
			else log(`relay lost (${reason})`)
			onClose?.(reason)
			if (stopped) return
			retry = setTimeout(connect, backoff)
			backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
		}
		socket.on('close', (code) => lost(`close ${code}`))
		socket.on('error', (error) => {
			log(`relay error: ${error.message}`)
			if (socket?.readyState === WebSocket.CONNECTING) socket.terminate()
		})
	}

	return {
		send(text) {
			if (socket?.readyState !== WebSocket.OPEN) return false
			socket.send(text)
			return true
		},
		start() {
			stopped = false
			connect()
		},
		stop() {
			stopped = true
			clearInterval(ping)
			clearTimeout(retry)
			didOpen = false
			socket?.removeAllListeners()
			if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) socket.terminate()
			socket = undefined
		},
	}
}
