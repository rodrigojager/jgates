//go:build integration

package calc

import "testing"

func TestStoreRoundTrip(t *testing.T) {
	store := map[string]int{"total": Add(1, 2)}
	if store["total"] != 3 {
		t.Fatalf("total = %d, want 3", store["total"])
	}
}

func TestSumOfMany(t *testing.T) {
	total := 0
	for value := 0; value < 5; value++ {
		total = Add(total, value)
	}
	if total != 10 {
		t.Fatalf("total = %d, want 10", total)
	}
}
