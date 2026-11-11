use std::hint::black_box;
use std::time::Duration;

use criterion::{criterion_group, criterion_main, Criterion};

fn bench_fib(c: &mut Criterion) {
    c.bench_function("fib_20", |b| b.iter(|| fib::fib(black_box(20))));
}

criterion_group! {
    name = benches;
    config = Criterion::default().sample_size(10).warm_up_time(Duration::from_millis(300)).measurement_time(Duration::from_secs(1));
    targets = bench_fib
}
criterion_main!(benches);
