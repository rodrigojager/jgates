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
