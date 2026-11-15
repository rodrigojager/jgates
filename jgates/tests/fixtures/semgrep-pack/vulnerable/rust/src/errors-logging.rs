use log::info;

pub fn login(user: &str, password: &str) {
    info!("login attempt {} {}", user, password);
}

pub async fn fetch(url: &str) -> Result<String, reqwest::Error> {
    let client = reqwest::Client::new();
    client.get(url).send().await?.text().await
}
