use axum::http::HeaderMap;
use cookie::{Cookie, SameSite};
use tower_http::cors::CorsLayer;

fn session_cookie(value: String) -> Cookie<'static> {
    Cookie::build(("__Host-sid", value))
        .path("/")
        .secure(true)
        .http_only(true)
        .same_site(SameSite::Strict)
        .build()
}

fn cors() -> CorsLayer {
    CorsLayer::new()
        .allow_origin("https://app.example.com".parse::<HeaderValue>().unwrap())
        .allow_credentials(true)
}

fn explicitly_secure_cookie(value: String) -> Cookie<'static> {
    Cookie::build(("__Host-sid", value)).secure(true).http_only(true).same_site(SameSite::Strict).build()
}

#[post("/account")]
async fn update_account(form: Form<Account>, csrf: Protector, token: Token, cookie: Token) -> Result<HttpResponse, Error> {
    csrf.verify_token_pair(&token, &cookie)?;
    save_account(form);
    Ok(HttpResponse::Ok().finish())
}

async fn echo_origin(headers: HeaderMap, resp: Builder) -> Response {
    let origin = headers.get("origin").unwrap();
    let origin = allowed_origin(origin);
    resp.header("Access-Control-Allow-Origin", origin).body(Body::empty()).unwrap()
}

fn fixed_layer() -> CorsLayer {
    CorsLayer::new().allow_origin("https://app.example.com".parse::<HeaderValue>().unwrap())
}

async fn json_response(Query(q): Query<Params>, data: String) -> String {
    format!("{{\"page\":{},\"data\":{}}}", q.page, data)
}

fn report_request(client: Client, key: &str) -> RequestBuilder {
    client.get("https://reports.example.com/export").header("X-Api-Key", key)
}
