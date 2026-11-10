package calc

import (
	"testing"

	"pgregory.net/rapid"
)

func TestAdd(t *testing.T) {
	if got := Add(2, 3); got != 5 {
		t.Fatalf("Add(2, 3) = %d, want 5", got)
	}
}

func TestAbs(t *testing.T) {
	if Abs(-4) != 4 || Abs(4) != 4 {
		t.Fatal("Abs is wrong")
	}
}

func TestAddIsCommutative(t *testing.T) {
	rapid.Check(t, func(t *rapid.T) {
		a := rapid.IntRange(-1000, 1000).Draw(t, "a")
		b := rapid.IntRange(-1000, 1000).Draw(t, "b")
		if Add(a, b) != Add(b, a) {
			t.Fatalf("Add(%d, %d) != Add(%d, %d)", a, b, b, a)
		}
	})
}
