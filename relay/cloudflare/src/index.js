import { DurableObject } from 'cloudflare:workers'

const ROLE_PATH = /^\/edge\/(camera|remote)$/

function control(type, fields = {}) {
	return JSON.stringify({ __relay: type, ...fields })
}

function messageType(text) {
	try {
		const value = JSON.parse(text)
		return value && typeof value === 'object' && typeof value.__relay === 'string' ? value.__relay : undefined
	} catch {
		return undefined
	}
}

/** One Durable Object per room: one camera agent and one remote client. */
export class RelayRoom extends DurableObject {
	constructor(state, env) {
		super(state, env)
		this.camera = null
		this.remote = null
	}

	async fetch(request) {
		const match = ROLE_PATH.exec(new URL(request.url).pathname)
		if (!match) return new Response('not found', { status: 404 })
		const role = match[1]
		if (this[role] && this[role].readyState === 1) {
			return new Response(`a ${role} is already connected to this room`, { status: 409 })
		}

		const { 0: client, 1: server } = new WebSocketPair()
		this.ctx.acceptWebSocket(server)
		server.serializeAttachment({ role })
		this[role] = server
		this.announce()
		return new Response(null, { status: 101, webSocket: client })
	}

	peerOf(ws) {
		const role = ws.deserializeAttachment()?.role
		return role === 'camera' ? this.remote : this.camera
	}

	announce() {
		const ready = !!(this.camera && this.remote)
		for (const ws of [this.camera, this.remote]) {
			if (ws && ws.readyState === 1) {
				const peer = this.peerOf(ws)
				ws.send(control(ready ? 'ready' : 'waiting', { peer: ready ? peer.deserializeAttachment()?.role : null }))
			}
		}
	}

	webSocketMessage(ws, message) {
		const text = typeof message === 'string' ? message : new TextDecoder().decode(message)
		const type = messageType(text)
		if (type === 'ping') {
			ws.send(control('pong'))
			return
		}
		if (type === 'refresh' || type === 'peer-gone') {
			const peer = this.peerOf(ws)
			if (peer && peer.readyState === 1) peer.send(text)
			return
		}
		if (type) return

		const peer = this.peerOf(ws)
		if (peer && peer.readyState === 1) peer.send(text)
	}

	webSocketClose(ws) {
		this.leave(ws)
	}

	webSocketError(ws) {
		this.leave(ws)
	}

	leave(ws) {
		const role = ws.deserializeAttachment()?.role
		if (this[role] === ws) this[role] = null
		const peer = this.peerOf(ws)
		if (peer && peer.readyState === 1) {
			peer.send(control('peer-gone', { role }))
			peer.close(1000, 'peer left')
		}
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url)
		if (url.pathname === '/health') return new Response('ok\n', { headers: { 'content-type': 'text/plain' } })

		const match = ROLE_PATH.exec(url.pathname)
		if (!match) return new Response('not found', { status: 404 })

		// TLS is provided by Cloudflare. The token is a high-entropy shared secret in the URL;
		// treat the full client URL (including the query string) as a credential.
		if (url.searchParams.get('token') !== env.RELAY_TOKEN) return new Response('unauthorized', { status: 401 })

		const room = url.searchParams.get('room') || 'stage'
		const id = env.RELAY_ROOM.idFromName(room)
		return env.RELAY_ROOM.get(id).fetch(request)
	},
}
