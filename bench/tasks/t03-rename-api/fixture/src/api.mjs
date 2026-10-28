export const API_VERSION = '1.0.0'

export function fetchUser(id) {
	return { id, name: `user-${id}` }
}
