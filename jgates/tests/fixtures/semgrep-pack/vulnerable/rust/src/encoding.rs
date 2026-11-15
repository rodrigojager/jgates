use axum::extract::Query;
use regex::Regex;

async fn find(Query(q): Query<Search>) -> usize {
    let re = Regex::new(&format!("^{}$", q.term)).unwrap();
    re.find_iter("sample text").count()
}
