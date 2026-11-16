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

pub async fn accept_feed(stream: TcpStream) {
    let _ = tokio_tungstenite::accept_hdr_async(stream, |req: &Request, response: Response| {
        if req.headers().get("origin").and_then(|v| v.to_str().ok()) != Some("https://app.example.com") {
            return Err(ErrorResponse::new(Some("Origin rejected".to_owned())));
        }
        Ok(response)
    }).await;
}

pub fn build_schema(q: Query, m: EmptyMutation, s: EmptySubscription) {
    let _ = Schema::build(q, m, s).limit_depth(10).limit_complexity(200).disable_introspection().finish();
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
