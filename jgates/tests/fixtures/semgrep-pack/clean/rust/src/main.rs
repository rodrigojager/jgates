use axum::{extract::Query, response::Html, routing::get, Router};
use sha2::{Digest, Sha256};
use std::process::Command;

#[derive(serde::Deserialize)]
struct Params {
    name: String,
    url: String,
    file: String,
}

fn validate_url(url: &str) -> String {
    url.to_string()
}

async fn lookup(pool: &sqlx::PgPool, Query(params): Query<Params>) {
    let _rows = sqlx::query("SELECT * FROM users WHERE name = $1")
        .bind(params.name)
        .fetch_all(pool)
        .await;
}

async fn ping(Query(params): Query<Params>) {
    Command::new("ping").arg("-c").arg("1").arg(params.name).output().unwrap();
}

async fn run_tool() {
    Command::new("git").arg("status").output().unwrap();
}

async fn fetch(Query(params): Query<Params>) -> String {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).redirect(reqwest::redirect::Policy::none()).build().unwrap();
    client.get(validate_url(&params.url)).send().await.unwrap().text().await.unwrap()
}

async fn read_file(Query(params): Query<Params>) -> String {
    std::fs::read_to_string(sanitize_filename::sanitize(&params.file)).unwrap()
}

async fn greet(Query(params): Query<Params>) -> Html<String> {
    Html(format!("<h1>Hello {}</h1>", html_escape::encode_text(&params.name)))
}

fn static_markup() {
    let _m = maud::PreEscaped("<hr>");
}

async fn import(body: axum::body::Bytes) {
    let _v: serde_json::Value = serde_json::from_slice(&body).unwrap();
}

fn fingerprint(data: &[u8]) {
    let _h = Sha256::digest(data);
    let _c = openssl::symm::Cipher::aes_256_gcm();
    let _client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build();
}

#[tokio::main]
async fn main() {
    let _app: Router = Router::new().route("/lookup", get(|| async { "ok" }));
}
