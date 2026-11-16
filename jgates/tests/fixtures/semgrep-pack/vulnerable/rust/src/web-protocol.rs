use actix_web::{web, HttpRequest, HttpResponse};
use async_graphql::{EmptyMutation, EmptySubscription, Schema};
use rocket::shield::Shield;
use tokio_tungstenite::connect_async;

pub fn shield() -> Shield {
    Shield::new()
}

pub fn csp_page() -> HttpResponse {
    HttpResponse::Ok()
        .insert_header(("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'"))
        .finish()
}

pub async fn open_feed() {
    let _ = connect_async("ws://chat.example.com/feed").await;
}

pub async fn accept_feed(stream: TcpStream) {
    let _ = tokio_tungstenite::accept_async(stream).await;
}

pub fn build_schema(q: Query, m: EmptyMutation, s: EmptySubscription) {
    let _ = Schema::build(q, m, s).finish();
}

pub async fn go(q: web::Query<Next>) -> HttpResponse {
    HttpResponse::Found().insert_header(("Location", q.next.clone())).finish()
}

pub fn caller(req: HttpRequest) -> Option<String> {
    req.connection_info().realip_remote_addr().map(|s| s.to_string())
}

pub fn reset_link(req: HttpRequest) -> String {
    format!("https://{}/reset?token=abc", req.connection_info().host())
}
