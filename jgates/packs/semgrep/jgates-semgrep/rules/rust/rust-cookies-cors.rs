use actix_cors::Cors;
use actix_session::SessionMiddleware;
use axum::http::{header, HeaderMap};
use cookie::{Cookie, SameSite};
use tower_http::cors::{Any, AllowOrigin, CorsLayer};
use tower_sessions::SessionManagerLayer;

fn good_builder(value: String) -> Cookie<'static> {
    // ok: jgates.rust.cookie-without-httponly
    // ok: jgates.rust.cookie-without-secure-by-default, jgates.rust.cookie-without-secure, jgates.rust.cookie-without-httponly, jgates.rust.cookie-without-httponly-by-default, jgates.rust.cookie-without-samesite, jgates.rust.cookie-name-without-prefix
    Cookie::build(("__Host-sid", value)).path("/").secure(true).http_only(true).same_site(SameSite::Strict).build()
}

fn good_setters(value: String) -> Cookie<'static> {
    // ok: jgates.rust.cookie-without-httponly-by-default, jgates.rust.cookie-without-httponly, jgates.rust.cookie-without-secure, jgates.rust.cookie-without-secure-by-default, jgates.rust.cookie-without-samesite, jgates.rust.cookie-name-without-prefix
    let mut c = Cookie::new("__Secure-sid", value);
    c.set_secure(true);
    c.set_http_only(true);
    c.set_same_site(SameSite::Lax);
    c
}

fn bad_builder_default(value: String) -> Cookie<'static> {
    // ok: jgates.rust.cookie-without-secure, jgates.rust.cookie-without-httponly
    // ruleid: jgates.rust.cookie-without-secure-by-default, jgates.rust.cookie-without-httponly-by-default, jgates.rust.cookie-without-samesite, jgates.rust.cookie-name-without-prefix
    Cookie::build(("sid", value)).path("/").build()
}

fn bad_new_default(value: String) -> Cookie<'static> {
    // ok: jgates.rust.cookie-without-secure, jgates.rust.cookie-without-httponly
    // ruleid: jgates.rust.cookie-without-httponly-by-default, jgates.rust.cookie-without-secure-by-default, jgates.rust.cookie-without-samesite, jgates.rust.cookie-name-without-prefix
    Cookie::new("session", value)
}

fn bad_explicit_off(value: String) -> Cookie<'static> {
    // ok: jgates.rust.cookie-without-secure-by-default, jgates.rust.cookie-without-httponly-by-default
    // ruleid: jgates.rust.cookie-without-secure, jgates.rust.cookie-without-httponly, jgates.rust.cookie-without-samesite
    Cookie::build(("__Host-sid", value)).secure(false).http_only(false).same_site(SameSite::None).build()
}

fn bad_setters_off(value: String) -> Cookie<'static> {
    // ok: jgates.rust.cookie-name-without-prefix, jgates.rust.cookie-without-secure-by-default, jgates.rust.cookie-without-httponly-by-default
    let mut c = Cookie::new("__Host-sid", value);
    // ruleid: jgates.rust.cookie-without-secure
    c.set_secure(false);
    // ruleid: jgates.rust.cookie-without-httponly
    c.set_http_only(false);
    // ruleid: jgates.rust.cookie-without-samesite
    c.set_same_site(SameSite::None);
    c
}

fn actix_session_bad(store: Store, key: Key) {
    // ruleid: jgates.rust.cookie-without-samesite, jgates.rust.cookie-without-secure, jgates.rust.cookie-without-httponly, jgates.rust.cookie-name-without-prefix
    let _m = SessionMiddleware::builder(store, key).cookie_secure(false).cookie_http_only(false).cookie_same_site(SameSite::None).cookie_name("sid".to_string()).build();
}

fn actix_session_good(store: Store, key: Key) {
    // ok: jgates.rust.cookie-without-samesite, jgates.rust.cookie-without-secure, jgates.rust.cookie-without-httponly, jgates.rust.cookie-name-without-prefix
    let _m = SessionMiddleware::builder(store, key).cookie_secure(true).cookie_http_only(true).cookie_same_site(SameSite::Strict).cookie_name("__Host-sid".to_string()).build();
}

fn tower_session_bad(store: Store) {
    // ruleid: jgates.rust.cookie-name-without-prefix, jgates.rust.cookie-without-secure, jgates.rust.cookie-without-httponly, jgates.rust.cookie-without-samesite
    let _l = SessionManagerLayer::new(store).with_secure(false).with_http_only(false).with_same_site(SameSite::None).with_name("sid");
}

fn tower_session_good(store: Store) {
    // ok: jgates.rust.cookie-name-without-prefix, jgates.rust.cookie-without-secure, jgates.rust.cookie-without-httponly, jgates.rust.cookie-without-samesite
    let _l = SessionManagerLayer::new(store).with_secure(true).with_http_only(true).with_same_site(SameSite::Lax).with_name("__Host-id");
}

fn cors_credentials_bad() {
    // ruleid: jgates.rust.cors-any-origin-with-credentials
    let _a = CorsLayer::new().allow_origin(Any).allow_credentials(true);
    // ruleid: jgates.rust.cors-any-origin-with-credentials
    let _b = Cors::default().allow_any_origin().supports_credentials();
}

fn cors_credentials_good() {
    // ok: jgates.rust.cors-any-origin-with-credentials
    let _a = CorsLayer::new().allow_origin(Any);
    // ok: jgates.rust.cors-any-origin-with-credentials
    let _b = CorsLayer::new().allow_origin("https://app.example.com".parse::<HeaderValue>().unwrap()).allow_credentials(true);
    // ok: jgates.rust.cors-any-origin-with-credentials
    let _c = Cors::default().allowed_origin("https://app.example.com").supports_credentials();
}

fn cors_allow_all_bad() {
    // ruleid: jgates.rust.cors-origin-reflected-allow-all
    let _a = CorsLayer::new().allow_origin(AllowOrigin::mirror_request());
    // ruleid: jgates.rust.cors-origin-reflected-allow-all
    let _b = Cors::default().allow_origin_fn(|_origin, _req| true);
    // ruleid: jgates.rust.cors-origin-reflected-allow-all
    let _c = CorsLayer::very_permissive();
}

fn cors_allow_all_good() {
    // ok: jgates.rust.cors-origin-reflected-allow-all
    let _a = CorsLayer::new().allow_origin(AllowOrigin::exact("https://app.example.com".parse().unwrap()));
    // ok: jgates.rust.cors-origin-reflected-allow-all
    let _b = Cors::default().allow_origin_fn(|origin, _req| origin.as_bytes().ends_with(b".example.com"));
}

async fn reflect_bad(headers: HeaderMap, resp: Builder) -> Response {
    let origin = headers.get("origin").unwrap();
    // ruleid: jgates.rust.cors-origin-reflected
    resp.header("Access-Control-Allow-Origin", origin).body(Body::empty()).unwrap()
}

async fn reflect_bad_actix(req: HttpRequest) -> HttpResponse {
    let origin = req.headers().get(header::ORIGIN).unwrap();
    // ruleid: jgates.rust.cors-origin-reflected
    HttpResponse::Ok().insert_header((header::ACCESS_CONTROL_ALLOW_ORIGIN, origin.clone())).finish()
}

async fn reflect_good(headers: HeaderMap, resp: Builder) -> Response {
    let origin = headers.get("origin").unwrap();
    let origin = allowed_origin(origin);
    // ok: jgates.rust.cors-origin-reflected
    resp.header("Access-Control-Allow-Origin", origin).body(Body::empty()).unwrap()
}

async fn reflect_good_fixed(resp: Builder) -> Response {
    // ok: jgates.rust.cors-origin-reflected
    resp.header("Access-Control-Allow-Origin", "https://app.example.com").body(Body::empty()).unwrap()
}

async fn jsonp_bad(Query(q): Query<Params>, data: String) -> String {
    // ruleid: jgates.rust.jsonp-enabled
    format!("{}({})", q.callback, data)
}

async fn jsonp_bad_semicolon(Query(q): Query<Params>, data: String) -> String {
    // ruleid: jgates.rust.jsonp-enabled
    format!("{}({});", q.callback, data)
}

async fn json_good(Query(q): Query<Params>, data: String) -> String {
    // ok: jgates.rust.jsonp-enabled
    format!("{{\"page\":{},\"data\":{}}}", q.page, data)
}

async fn json_good_plain(data: String) -> String {
    // ok: jgates.rust.jsonp-enabled
    data
}

fn urls_bad(client: Client, mut url: Url, key: String) {
    // ruleid: jgates.rust.sensitive-query-parameter
    let _a = "https://api.example.com/v1/items?api_key=abc123";
    // ruleid: jgates.rust.sensitive-query-parameter
    let _b = format!("https://example.com/login?user=ann&password={}", key);
    // ruleid: jgates.rust.sensitive-query-parameter
    url.query_pairs_mut().append_pair("client_secret", &key);
    // ruleid: jgates.rust.sensitive-query-parameter
    let _c = client.get("https://example.com/data").query(&[("password", key.as_str())]);
}

fn urls_good(client: Client, mut url: Url, key: String) {
    // ok: jgates.rust.sensitive-query-parameter
    let _a = "https://api.example.com/v1/items?page=2";
    // ok: jgates.rust.sensitive-query-parameter
    let _b = format!("https://example.com/items?page={}", key);
    // ok: jgates.rust.sensitive-query-parameter
    url.query_pairs_mut().append_pair("page", &key);
    // ok: jgates.rust.sensitive-query-parameter
    let _c = client.get("https://example.com/data").header("X-Api-Key", key.as_str());
}

// ruleid: jgates.rust.csrf-protection-disabled
#[post("/account")]
async fn update_account(form: Form<Account>) -> HttpResponse {
    save_account(form);
    HttpResponse::Ok().finish()
}

// ruleid: jgates.rust.csrf-protection-disabled
#[put("/profile")]
async fn update_profile(form: Form<Profile>) -> HttpResponse {
    save_profile(form);
    HttpResponse::Ok().finish()
}

// ok: jgates.rust.csrf-protection-disabled
#[post("/account")]
async fn protected_account(form: Form<Account>, csrf: Protector, token: Token, cookie: Token) -> Result<HttpResponse, Error> {
    csrf.verify_token_pair(&token, &cookie)?;
    save_account(form);
    Ok(HttpResponse::Ok().finish())
}

// ok: jgates.rust.csrf-protection-disabled
#[put("/profile")]
async fn protected_profile(form: Form<Profile>, csrf: Protector, token: Token, cookie: Token) -> Result<HttpResponse, Error> {
    csrf.verify_token_pair(&token, &cookie)?;
    save_profile(form);
    Ok(HttpResponse::Ok().finish())
}
