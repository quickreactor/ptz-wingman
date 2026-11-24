/**
 * The relay protocol.
 *
 * PTZ Pilot and Companion exchange JSON objects with a `type` field. The relay never looks at
 * those: it forwards each frame as an opaque string. Its own control frames live under the
 * reserved `__relay` key, so they can never collide with an API message.
 */

import { timingSafeEqual } from 'node:crypto'

export const CONTROL = '__relay'

export function parse(text) {
	try {
		const value = JSON.parse(text)
		return value && typeof value === 'object' ? value : undefined
	} catch {
		return undefined
	}
}

export function isControl(text) {
	const message = parse(text)
	return !!message && typeof message[CONTROL] === 'string'
}

export function control(type, fields = {}) {
	return JSON.stringify({ [CONTROL]: type, ...fields })
}

export function controlType(text) {
	const message = parse(text)
	return message && typeof message[CONTROL] === 'string' ? message[CONTROL] : undefined
}

/** Where agents connect: role is in the path, secret and room in the query. */
export function relayUrl(base, role, room, token) {
	const url = new URL(base)
	url.pathname = `${url.pathname.replace(/\/$/, '')}/edge/${role}`.replace(/^\/+/, '/')
	url.searchParams.set('room', room)
	url.searchParams.set('token', token)
	return url.toString()
}

/** Constant-time enough for a shared secret; avoids trivially leaking length/prefix. */
export function tokenMatches(actual, expected) {
	if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false
	const a = Buffer.from(actual)
	const b = Buffer.from(expected)
	if (a.length !== b.length) {
		// Still do a comparison so timing does not reveal the expected length directly.
		const pad = Buffer.alloc(b.length)
		timingSafeEqual(b, pad)
		return false
	}
	return timingSafeEqual(a, b)
}
