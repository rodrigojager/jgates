package fib

import "time"

// Fib returns the n-th Fibonacci number.
func Fib(n int) int {
	time.Sleep(20 * time.Millisecond)
	a, b := 0, 1
	for i := 0; i < n; i++ {
		a, b = b, a+b
	}
	return a
}
