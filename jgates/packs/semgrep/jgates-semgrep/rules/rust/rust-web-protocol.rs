use actix_web::{web, HttpRequest, HttpResponse};
use async_graphql::{EmptyMutation, EmptySubscription, Schema};
use axum::extract::Query;
use axum::response::Redirect;
use rocket::shield::{Frame, Hsts, Shield};
use tokio_tungstenite::connect_async;
use tungstenite::client::IntoClientRequest;

// security-headers-disabled
fn shields() {
    // ruleid: jgates.rust.security-headers-disabled
    let _a = Shield::new();
    // ruleid: jgates.rust.security-headers-disabled
    let _b = Shield::default().disable::<Frame>();
    // ruleid: jgates.rust.security-headers-disabled
    let _c = Shield::default().disable::<Hsts>();
    // ok: jgates.rust.security-headers-disabled
    let _d = Shield::default();
    // ok: jgates.rust.security-headers-disabled
    let _e = Shield::default().enable(Hsts::default());
}

// csp-unsafe-directive
fn csp_headers() {
    // ruleid: jgates.rust.csp-unsafe-directive
    let _a = HttpResponse::Ok().insert_header(("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'")).finish();
    // ruleid: jgates.rust.csp-unsafe-directive
    let _b = HttpResponse::Ok().append_header((header::CONTENT_SECURITY_POLICY, "script-src * ; object-src 'none'")).finish();
    // ruleid: jgates.rust.csp-unsafe-directive
    let _c = SetResponseHeaderLayer::overriding(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static("default-src 'self' 'unsafe-eval'"));
    // ok: jgates.rust.csp-unsafe-directive
    let _d = HttpResponse::Ok().insert_header(("Content-Security-Policy", "default-src 'self'; script-src 'self' 'nonce-abc123'; object-src 'none'")).finish();
    // ok: jgates.rust.csp-unsafe-directive
    let _e = HttpResponse::Ok().insert_header(("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'")).finish();
    // ok: jgates.rust.csp-unsafe-directive
    let _f = HttpResponse::Ok().insert_header(("X-Frame-Options", "script-src 'unsafe-inline'")).finish();
}

// websocket-without-tls
async fn dial() {
    // ruleid: jgates.rust.websocket-without-tls
    let _a = connect_async("ws://chat.example.com/feed").await;
    // ruleid: jgates.rust.websocket-without-tls
    let _b = tungstenite::connect("ws://10.0.0.5:8080/ws");
    // ruleid: jgates.rust.websocket-without-tls
    let _c = "ws://feed.example.com/live".into_client_request();
    // ok: jgates.rust.websocket-without-tls
    let _d = connect_async("wss://chat.example.com/feed").await;
    // ok: jgates.rust.websocket-without-tls
    let _e = connect_async("ws://localhost:8080/feed").await;
    // ok: jgates.rust.websocket-without-tls
    let _f = tungstenite::connect("ws://127.0.0.1:9000/ws");
}

// graphql-without-depth-limit
fn graphql_schemas(q: Query, m: EmptyMutation, s: EmptySubscription) {
    // ruleid: jgates.rust.graphql-without-depth-limit
    let _a = Schema::build(q, m, s).finish();
    // ruleid: jgates.rust.graphql-without-depth-limit
    let _b = Schema::build(q, m, s).data(1).finish();
    // ok: jgates.rust.graphql-without-depth-limit
    let _c = Schema::build(q, m, s).limit_depth(10).finish();
    // ok: jgates.rust.graphql-without-depth-limit
    let _d = Schema::build(q, m, s).data(1).limit_complexity(200).finish();
}

// open-redirect
async fn go(Query(params): Query<Next>) -> Redirect {
    // ruleid: jgates.rust.open-redirect
    Redirect::to(&params.next)
}

async fn go_actix(q: web::Query<Next>) -> HttpResponse {
    // ruleid: jgates.rust.open-redirect
    HttpResponse::Found().insert_header(("Location", q.next.clone())).finish()
}

async fn go_safe(Query(params): Query<Next>) -> Redirect {
    // ok: jgates.rust.open-redirect
    let _a = Redirect::to("/dashboard");
    // ok: jgates.rust.open-redirect
    let _b = HttpResponse::Found().insert_header(("Location", "/home")).finish();
    // ok: jgates.rust.open-redirect
    Redirect::to(safe_redirect_target(&params.next))
}

// client-ip-from-forwarded-header
fn client_ip(req: HttpRequest, headers: HeaderMap) {
    // ruleid: jgates.rust.client-ip-from-forwarded-header
    let _a = headers.get("x-forwarded-for");
    // ruleid: jgates.rust.client-ip-from-forwarded-header
    let _b = req.headers().get("X-Real-IP");
    // ruleid: jgates.rust.client-ip-from-forwarded-header
    let _c = req.connection_info().realip_remote_addr();
    // ok: jgates.rust.client-ip-from-forwarded-header
    let _d = req.peer_addr();
    // ok: jgates.rust.client-ip-from-forwarded-header
    let _e = headers.get("user-agent");
}

// host-header-in-url
fn host_links(req: HttpRequest) {
    // ruleid: jgates.rust.host-header-in-url
    let _a = format!("https://{}/reset?token=abc", req.connection_info().host());
    // ruleid: jgates.rust.host-header-in-url
    let _b = format!("https://{}/verify", req.headers().get("host").unwrap().to_str().unwrap());
    // ok: jgates.rust.host-header-in-url
    let _c = format!("https://{}/reset?token=abc", "app.example.com");
    // ok: jgates.rust.host-header-in-url
    let _d = format!("request for host {}", req.connection_info().host());
}
