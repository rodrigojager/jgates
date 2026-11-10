use std::collections::HashMap;

#[test]
fn store_round_trip() {
    let mut store = HashMap::new();
    store.insert("total", calc::add(1, 2));
    assert_eq!(store["total"], 3);
}

#[test]
fn sum_of_many() {
    let total = (0..5).fold(0, calc::add);
    assert_eq!(total, 10);
}
