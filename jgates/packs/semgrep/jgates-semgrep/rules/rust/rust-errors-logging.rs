use log::{info, warn};
use std::time::Duration;

fn login(user: &str, password: &str, api_key: &str, user_id: u64) {
    // ruleid: jgates.rust.sensitive-data-logged
    info!("login attempt {} {}", user, password);
    // ruleid: jgates.rust.sensitive-data-logged
    warn!("using key {}", api_key);
    // ruleid: jgates.rust.sensitive-data-logged
    tracing::info!(token = %api_key, "calling upstream");
    // ok: jgates.rust.sensitive-data-logged
    info!("login attempt for user {}", user_id);
    // ok: jgates.rust.sensitive-data-logged
    tracing::info!(user = %user, "calling upstream");
    // ok: jgates.rust.sensitive-data-logged
    println!("{}", password.len());
}

fn error_responses(result: Result<(), std::io::Error>) {
    match result {
        Ok(_) => {},
        Err(e) => {
            // ruleid: jgates.rust.error-detail-in-response
            HttpResponse::InternalServerError().body(e.to_string());
            // ruleid: jgates.rust.error-detail-in-response
            (StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
            // ok: jgates.rust.error-detail-in-response
            HttpResponse::InternalServerError().body("Internal error");
            // ok: jgates.rust.error-detail-in-response
            (StatusCode::INTERNAL_SERVER_ERROR, "Internal error");
        }
    }
}

fn handle_errors(result: Result<(), std::io::Error>) {
    // ruleid: jgates.rust.swallowed-exception
    match result { Ok(_) => {}, Err(_) => {} }
    // ruleid: jgates.rust.swallowed-exception
    if let Err(_) = save() {}
    // ok: jgates.rust.swallowed-exception
    match save() { Ok(_) => {}, Err(e) => { report(e); } }
    // ok: jgates.rust.swallowed-exception
    if let Err(e) = save() { report(e); }
    // ok: jgates.rust.swallowed-exception
    let _ = save();
    // ok: jgates.rust.swallowed-exception
    save().ok();
}

async fn proxy(Query(params): Query<Params>) -> Result<(), reqwest::Error> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(10)).build()?;
    // ruleid: jgates.rust.outbound-request-follows-redirects
    client.get(&params.url).send().await?;
    // ok: jgates.rust.outbound-request-follows-redirects
    client.get("https://example.com/health").send().await?;
    let safe = reqwest::Client::builder().timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none()).build()?;
    // ok: jgates.rust.outbound-request-follows-redirects
    safe.get(&params.url).send().await?;
    Ok(())
}

async fn blocking_proxy(params: web::Query<Params>) -> Result<(), reqwest::Error> {
    let client = reqwest::blocking::Client::builder().timeout(Duration::from_secs(10)).build()?;
    // ruleid: jgates.rust.outbound-request-follows-redirects
    client.get(&params.url).send()?;
    let safe = reqwest::blocking::Client::builder().timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none()).build()?;
    // ok: jgates.rust.outbound-request-follows-redirects
    safe.get(&params.url).send()?;
    Ok(())
}

async fn fetch(url: &str) {
    // ruleid: jgates.rust.http-client-without-timeout
    let _a = reqwest::get(url).await;
    // ruleid: jgates.rust.http-client-without-timeout
    let _b = reqwest::Client::new();
    // ruleid: jgates.rust.http-client-without-timeout
    let _c = reqwest::Client::builder().user_agent("jg").build();
    // ok: jgates.rust.http-client-without-timeout
    let _d = reqwest::Client::builder().timeout(Duration::from_secs(10)).build();
    // ok: jgates.rust.http-client-without-timeout
    let _e = reqwest::blocking::Client::builder().connect_timeout(Duration::from_secs(5)).user_agent("jg").build();
}
