use axum::extract::Query;
use std::path::Path;

async fn proxy(Query(params): Query<Target>) -> String {
    // ruleid: jgates.rust.ssrf
    reqwest::get(params.url).await.unwrap().text().await.unwrap()
}

async fn webhook(client: &reqwest::Client, form: web::Form<Callback>) {
    let target = form.callback.clone();
    // ruleid: jgates.rust.ssrf
    let _ = client.post(target).send().await;
}

async fn status(client: &reqwest::Client, Query(params): Query<Target>) -> String {
    // ok: jgates.rust.ssrf
    let _ = reqwest::get("https://api.example.com/status").await;
    // ok: jgates.rust.ssrf
    let _ = client.get("https://api.example.com/health").send().await;
    // ok: jgates.rust.ssrf
    let _ = reqwest::get(validate_url(&params.url)).await;
    params.label
}

async fn download(Query(params): Query<FileParams>) -> Vec<u8> {
    // ruleid: jgates.rust.path-traversal
    std::fs::read(params.name).unwrap()
}

async fn show(Query(params): Query<FileParams>) -> String {
    let full = format!("static/{}", params.file);
    // ruleid: jgates.rust.path-traversal
    tokio::fs::read_to_string(&full).await.unwrap()
}

async fn join_only(Query(params): Query<FileParams>) {
    // ruleid: jgates.rust.path-traversal
    let target = Path::new("static").join(&params.name);
    drop(target);
}

async fn safe_files(Query(params): Query<FileParams>) -> Vec<u8> {
    // ok: jgates.rust.path-traversal
    let _ = std::fs::read(sanitize_filename::sanitize(&params.name));
    // ok: jgates.rust.path-traversal
    let _ = std::fs::read(Path::new(&params.name).file_name().unwrap());
    // ok: jgates.rust.path-traversal
    tokio::fs::read("static/readme.txt").await.unwrap()
}
