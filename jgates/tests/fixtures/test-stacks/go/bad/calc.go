package calc

// Add returns the sum of a and b.
func Add(a, b int) int {
	return a + b
}

// Clamp keeps value between low and high.
func Clamp(value, low, high int) int {
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

// Sign returns -1, 0 or 1.
func Sign(x int) int {
	if x > 0 {
		return 1
	}
	if x < 0 {
		return -1
	}
	return 0
}
