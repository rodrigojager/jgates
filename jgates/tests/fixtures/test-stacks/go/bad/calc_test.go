package calc

import "testing"

func TestAdd(t *testing.T) {
	if got := Add(2, 2); got != 5 {
		t.Fatalf("Add(2, 2) = %d, want 5", got)
	}
}

func TestAddZero(t *testing.T) {
	if Add(7, 0) != 7 {
		t.Fatal("Add(7, 0) is not 7")
	}
}
