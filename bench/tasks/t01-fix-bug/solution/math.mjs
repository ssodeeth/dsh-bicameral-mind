export function sum(values) {
	let total = 0
	for (const value of values) total += value
	return total
}

export function average(values) {
	if (values.length === 0) return 0
	return sum(values) / values.length
}

export function median(values) {
	if (values.length === 0) return 0
	const sorted = [...values].sort((a, b) => a - b)
	const middle = Math.floor(sorted.length / 2)
	if (sorted.length % 2 === 1) return sorted[middle]
	return (sorted[middle - 1] + sorted[middle]) / 2
}
