use axum::http::HeaderMap;
use cookie::{Cookie, SameSite};
use tower_http::cors::{Any, CorsLayer};

fn session_cookie(value: String) -> Cookie<'static> {
    Cookie::build(("sid", value)).path("/").build()
}

fn explicitly_insecure_cookie(value: String) -> Cookie<'static> {
    Cookie::build(("__Host-sid", value)).secure(false).http_only(false).same_site(SameSite::Strict).build()
}

#[post("/account")]
async fn update_account(form: Form<Account>) -> HttpResponse {
    save_account(form);
    HttpResponse::Ok().finish()
}

fn cors() -> CorsLayer {
    CorsLayer::new().allow_origin(Any).allow_credentials(true)
}

async fn echo_origin(headers: HeaderMap, resp: Builder) -> Response {
    let origin = headers.get("origin").unwrap();
    resp.header("Access-Control-Allow-Origin", origin).body(Body::empty()).unwrap()
}

fn mirror_layer() -> CorsLayer {
    CorsLayer::very_permissive()
}

async fn script_response(Query(q): Query<Params>, data: String) -> String {
    format!("{}({})", q.callback, data)
}

fn report_url(key: &str) -> String {
    format!("https://reports.example.com/export?api_key={}", key)
}
