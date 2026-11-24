import http from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { control, controlType, tokenMatches } from './protocol.js'

/**
 * A small, self-hostable relay. The Cloudflare Worker in cloudflare/ does the same job, but this
 * one is handy for local testing (and for a VPS where you terminate TLS with a reverse proxy).
 *
 * Rooms hold at most one `camera` agent (next to PTZ Pilot) and one `remote` client. A single
 * remote client keeps PTZ Pilot's per-connection hold-to-move safety intact: one `stop` can never
 * cancel another client's `move`.
 */
export function createRelayServer({
	token,
	host = '127.0.0.1',
	port = 8787,
	heartbeatMs = 5000,
	timeoutMs = 15000,
	log = (message) => console.log(`[relay] ${message}`),
} = {}) {
	if (!token) throw new Error('A shared token is required')

	const rooms = new Map()

	const server = http.createServer((req, res) => {
		if (new URL(req.url ?? '/', 'http://localhost').pathname === '/health') {
			res.writeHead(200, { 'content-type': 'text/plain' })
			res.end('ok\n')
		} else {
			res.writeHead(404)
			res.end()
		}
	})

	const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 })

	server.on('upgrade', (req, socket, head) => {
		let url
		try {
			url = new URL(req.url ?? '/', 'http://localhost')
		} catch {
			socket.destroy()
			return
		}
		const match = /^\/edge\/(camera|remote)$/.exec(url.pathname)
		if (!match || !tokenMatches(url.searchParams.get('token'), token)) {
			socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
			socket.destroy()
			return
		}
		wss.handleUpgrade(req, socket, head, (ws) => {
			ws.role = match[1]
			ws.room = url.searchParams.get('room') || 'stage'
			ws.lastSeen = Date.now()
			wss.emit('connection', ws, req)
		})
	})

	function roomFor(name) {
		let room = rooms.get(name)
		if (!room) {
			room = { camera: null, remote: null }
			rooms.set(name, room)
		}
		return room
	}

	function peerOf(room, ws) {
		return room[ws.role === 'camera' ? 'remote' : 'camera']
	}

	function announce(room) {
		const ready = !!(room.camera && room.remote)
		for (const ws of [room.camera, room.remote]) {
			if (ws && ws.readyState === WebSocket.OPEN) {
				const peer = peerOf(room, ws)
				ws.send(control(ready ? 'ready' : 'waiting', { peer: ready ? peer.role : null }))
			}
		}
	}

	wss.on('connection', (ws) => {
		const room = roomFor(ws.room)
		if (room[ws.role]) {
			ws.send(control('error', { message: `A ${ws.role} is already connected to room "${ws.room}"` }))
			ws.close(1008, 'room busy')
			return
		}
		room[ws.role] = ws
		log(`${ws.role} joined ${ws.room}`)
		announce(room)

		ws.on('message', (data, isBinary) => {
			ws.lastSeen = Date.now()
			if (isBinary) return
			const text = data.toString()
			const type = controlType(text)
			if (type === 'ping') {
				if (ws.readyState === WebSocket.OPEN) ws.send(control('pong'))
				return
			}
			// Replay requests and fail-safe notices are end-to-end control frames: a new remote
			// client needs hello/state again, and a lost PTZ Pilot must drop its remote peer.
			if (type === 'refresh' || type === 'peer-gone') {
				const peer = peerOf(room, ws)
				if (peer && peer.readyState === WebSocket.OPEN) peer.send(text)
				return
			}
			if (type) return // other control frames are local to one leg

			const peer = peerOf(room, ws)
			if (peer && peer.readyState === WebSocket.OPEN) peer.send(text)
		})

		function leave() {
			if (room[ws.role] === ws) room[ws.role] = null
			const peer = peerOf(room, ws)
			if (peer && peer.readyState === WebSocket.OPEN) {
				peer.send(control('peer-gone', { role: ws.role }))
				peer.close(1000, 'peer left')
			}
			if (!room.camera && !room.remote) rooms.delete(ws.room)
			log(`${ws.role} left ${ws.room}`)
		}
		ws.on('close', leave)
		ws.on('error', (error) => console.warn(`[relay] ${ws.role} error: ${error.message}`))
	})

	const heartbeat = setInterval(() => {
		const now = Date.now()
		for (const room of rooms.values()) {
			for (const ws of [room.camera, room.remote]) {
				if (ws && now - ws.lastSeen > timeoutMs) ws.terminate()
			}
		}
	}, heartbeatMs)
	heartbeat.unref?.()

	return {
		address: () => server.address(),
		async start() {
			await new Promise((resolve, reject) => {
				server.once('error', reject)
				server.listen(port, host, () => {
					server.off('error', reject)
					resolve()
				})
			})
			log(`listening on ws://${host}:${server.address().port}`)
			return this
		},
		async stop() {
			clearInterval(heartbeat)
			for (const ws of wss.clients) ws.terminate()
			await new Promise((resolve) => wss.close(resolve))
			await new Promise((resolve) => server.close(resolve))
		},
	}
}
