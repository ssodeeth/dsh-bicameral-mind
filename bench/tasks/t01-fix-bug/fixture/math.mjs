export function sum(values) {
	let total = 0
	for (const value of values) total += value
	return total
}

export function average(values) {
	return sum(values) / values.length
}
