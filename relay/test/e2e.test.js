import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket, WebSocketServer } from 'ws'
import { createRelayServer } from '../src/server.js'
import { createCameraAgent } from '../src/camera-agent.js'
import { relayUrl } from '../src/protocol.js'

const TOKEN = 'a-long-random-test-secret'
const silent = () => {}

function waitFor(predicate, timeout = 8000, label = 'condition') {
	const start = Date.now()
	return new Promise((resolve, reject) => {
		const tick = () => {
			let value
			try {
				value = predicate()
			} catch (error) {
				reject(error)
				return
			}
			if (value) return resolve(value)
			if (Date.now() - start > timeout) return reject(new Error(`timed out waiting for ${label}`))
			setTimeout(tick, 20)
		}
		tick()
	})
}

function connect(url) {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url)
		ws.once('open', () => resolve(ws))
		ws.once('error', reject)
	})
}

function listening(server) {
	if (server.address()) return Promise.resolve()
	return new Promise((resolve, reject) => {
		server.once('listening', resolve)
		server.once('error', reject)
	})
}

/** Fake PTZ Pilot + relay + camera agent, with a helper for real remote clients. */
async function harness(t) {
	const received = []
	const pilotClients = new Set()
	const pilotWss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
	pilotWss.on('connection', (ws) => {
		pilotClients.add(ws)
		ws.send(JSON.stringify({ type: 'hello', app: 'PTZ Pilot', version: '1.1.0', apiVersion: 1 }))
		ws.send(JSON.stringify({ type: 'state', activeCamera: 'c1', cameras: [], controllers: [] }))
		ws.on('message', (data) => received.push(JSON.parse(data.toString())))
		ws.on('close', () => pilotClients.delete(ws))
	})
	await listening(pilotWss)

	const relay = createRelayServer({ token: TOKEN, host: '127.0.0.1', port: 0, log: silent })
	await relay.start()
	const baseUrl = `ws://127.0.0.1:${relay.address().port}`

	const camera = createCameraAgent({
		relayUrl: baseUrl,
		room: 'stage',
		token: TOKEN,
		pilotUrl: `ws://127.0.0.1:${pilotWss.address().port}`,
		log: silent,
	})
	camera.start()
	await waitFor(() => camera.pilotConnected, 8000, 'camera agent to reach PTZ Pilot')

	t.after(async () => {
		camera.stop()
		await relay.stop()
		for (const ws of pilotClients) ws.terminate()
		await new Promise((resolve) => pilotWss.close(resolve))
	})

	return {
		received,
		pilotClients,
		connectRemote: () => connect(relayUrl(baseUrl, 'remote', 'stage', TOKEN)),
	}
}

test('a remote client gets state and commands reach PTZ Pilot unchanged', async (t) => {
	const h = await harness(t)
	const remote = await h.connectRemote()
	t.after(() => remote.terminate())

	const fromPilot = []
	remote.on('message', (data) => fromPilot.push(JSON.parse(data.toString())))
	remote.send(JSON.stringify({ __relay: 'refresh' }))
	await waitFor(() => fromPilot.length >= 2, 5000, 'hello and state from PTZ Pilot')
	assert.equal(fromPilot[0].type, 'hello')
	assert.equal(fromPilot[0].apiVersion, 1)
	assert.equal(fromPilot[1].type, 'state')

	remote.send(JSON.stringify({ __relay: 'ping' }))
	await waitFor(() => fromPilot.some((m) => m.__relay === 'pong'), 3000, 'relay pong')

	remote.send(JSON.stringify({ type: 'getState', id: 1 }))
	remote.send(JSON.stringify({ type: 'move', camera: 1, pan: -0.5, id: 2 }))
	remote.send(JSON.stringify({ type: 'stop', camera: 1, id: 3 }))
	await waitFor(() => h.received.length >= 3, 5000, 'requests reaching PTZ Pilot')

	assert.deepEqual(
		h.received.map((m) => m.type),
		['getState', 'move', 'stop'],
	)
	assert.equal(h.received[1].pan, -0.5)
	assert.equal(h.received[1].id, 2)
})

test('a lost PTZ Pilot connection warns the remote client so it can release held moves', async (t) => {
	const h = await harness(t)
	const remote = await h.connectRemote()
	t.after(() => remote.terminate())

	const notices = []
	remote.on('message', (data) => notices.push(JSON.parse(data.toString())))

	remote.send(JSON.stringify({ type: 'move', camera: 1, zoom: 1 }))
	await waitFor(() => h.received.some((m) => m.type === 'move'), 5000, 'move reaching PTZ Pilot')

	for (const ws of h.pilotClients) ws.close()
	await waitFor(() => notices.some((m) => m.__relay === 'peer-gone'), 5000, 'peer-gone notice')
	assert.equal(notices.find((m) => m.__relay === 'peer-gone').role, 'pilot')
})

test('the relay rejects a wrong token', async () => {
	const relay = createRelayServer({ token: TOKEN, host: '127.0.0.1', port: 0 })
	await relay.start()
	try {
		const url = relayUrl(`ws://127.0.0.1:${relay.address().port}`, 'remote', 'stage', 'wrong-secret')
		await assert.rejects(connect(url), /Unexpected server response: 401/)
	} finally {
		await relay.stop()
	}
})

test('only one remote client per room is accepted', async (t) => {
	const h = await harness(t)
	const first = await h.connectRemote()
	t.after(() => first.terminate())

	const base = first.url.match(/^ws:\/\/[^/]+/)[0]
	const url = relayUrl(base, 'remote', 'stage', TOKEN)
	const duplicate = await new Promise((resolve) => {
		const ws = new WebSocket(url)
		ws.on('close', (code) => resolve(code))
		ws.on('error', () => {})
	})
	assert.equal(duplicate, 1008)
})
