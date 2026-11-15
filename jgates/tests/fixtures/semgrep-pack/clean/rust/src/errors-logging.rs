use log::info;
use std::time::Duration;

pub fn login(user: &str, _password: &str, user_id: u64) {
    info!("login attempt {} for id {}", user, user_id);
}

pub async fn fetch(url: &str) -> Result<String, reqwest::Error> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;
    client.get(url).send().await?.text().await
}
