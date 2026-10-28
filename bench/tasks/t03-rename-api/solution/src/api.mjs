export const API_VERSION = '1.0.0'

export function getUser(id) {
	return { id, name: `user-${id}` }
}
