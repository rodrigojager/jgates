use axum::extract::Query;
use regex::{Regex, RegexBuilder};

async fn search(Query(q): Query<Search>) {
    // ruleid: jgates.rust.regex-from-request
    let _a = Regex::new(&q.term).unwrap();
    // ruleid: jgates.rust.regex-from-request
    let _b = Regex::new(&format!("^{}$", q.term)).unwrap();
    // ok: jgates.rust.regex-from-request
    let _c = Regex::new("^[a-z]+$").unwrap();
    // ok: jgates.rust.regex-from-request
    let _d = Regex::new(&regex::escape(&q.term)).unwrap();
}

async fn builder(body: web::Query<Search>) {
    let term = body.term.clone();
    // ruleid: jgates.rust.regex-from-request
    let _e = RegexBuilder::new(&term).case_insensitive(true).build();
    // ok: jgates.rust.regex-from-request
    let _f = RegexBuilder::new(&regex::escape(&term)).case_insensitive(true).build();
    // ok: jgates.rust.regex-from-request
    let _g = RegexBuilder::new("^abc$").build();
}
