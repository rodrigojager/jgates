use axum::{extract::Query, response::Html, routing::get, Router};
use maud::PreEscaped;
use sha1::Sha1;
use std::process::Command;

#[derive(serde::Deserialize)]
struct Params {
    name: String,
    url: String,
    file: String,
}

async fn lookup(pool: &sqlx::PgPool, Query(params): Query<Params>) {
    let _rows = sqlx::query(&format!("SELECT * FROM users WHERE name = '{}'", params.name))
        .fetch_all(pool)
        .await;
}

async fn ping(Query(params): Query<Params>) {
    let cmd = format!("ping {}", params.name);
    Command::new("sh").arg("-c").arg(&cmd).output().unwrap();
}

async fn run_tool(program: &str) {
    Command::new(program).output().unwrap();
}

async fn fetch(Query(params): Query<Params>) -> String {
    reqwest::get(params.url).await.unwrap().text().await.unwrap()
}

async fn read_file(Query(params): Query<Params>) -> String {
    std::fs::read_to_string(params.file).unwrap()
}

async fn greet(Query(params): Query<Params>) -> Html<String> {
    Html(format!("<h1>Hello {}</h1>", params.name))
}

fn comment_markup(comment: &str) {
    let _m = PreEscaped(comment);
}

async fn import(body: axum::body::Bytes) {
    let _v: serde_pickle::Value = serde_pickle::from_slice(&body, Default::default()).unwrap();
}

fn fingerprint() {
    let _h = Sha1::new();
    let _c = openssl::symm::Cipher::aes_128_ecb();
    let _client = reqwest::Client::builder().danger_accept_invalid_certs(true).build();
}

#[tokio::main]
async fn main() {
    let _app: Router = Router::new().route("/lookup", get(|| async { "ok" }));
}
