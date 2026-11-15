use actix_web::{web, HttpRequest, HttpResponse};
use async_graphql::{EmptyMutation, EmptySubscription, Schema};
use rocket::shield::Shield;
use tokio_tungstenite::connect_async;

pub fn shield() -> Shield {
    Shield::default()
}

pub fn csp_page() -> HttpResponse {
    HttpResponse::Ok()
        .insert_header(("Content-Security-Policy", "default-src 'self'; script-src 'self' 'nonce-abc123'; object-src 'none'"))
        .finish()
}

pub async fn open_feed() {
    let _ = connect_async("wss://chat.example.com/feed").await;
}

pub fn build_schema(q: Query, m: EmptyMutation, s: EmptySubscription) {
    let _ = Schema::build(q, m, s).limit_depth(10).limit_complexity(200).finish();
}

pub async fn go(q: web::Query<Next>) -> HttpResponse {
    let target = safe_redirect_target(&q.next);
    HttpResponse::Found().insert_header(("Location", target)).finish()
}

pub fn caller(req: HttpRequest) -> Option<String> {
    req.peer_addr().map(|a| a.ip().to_string())
}

pub fn reset_link(base_url: &str) -> String {
    format!("{}/reset?token=abc", base_url)
}
