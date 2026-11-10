package calc

// Add returns the sum of a and b.
func Add(a, b int) int {
	return a + b
}

// Abs returns the absolute value of x.
func Abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}
