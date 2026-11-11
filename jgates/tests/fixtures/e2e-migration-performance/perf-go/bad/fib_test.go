package fib

import "testing"

func BenchmarkFib20(b *testing.B) {
	for i := 0; i < b.N; i++ {
		Fib(20)
	}
}
