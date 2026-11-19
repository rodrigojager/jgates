use log::info;
use std::time::Duration;

pub fn login(user: &str, _password: &str, user_id: u64) {
    info!("login attempt {} for id {}", user, user_id);
}

pub fn error_response(result: Result<(), std::io::Error>) {
    match result {
        Ok(_) => {},
        Err(e) => {
            report(e);
            HttpResponse::InternalServerError().body("Internal error");
        }
    }
}

pub fn persist() {
    if let Err(e) = save() { report(e); }
}

pub async fn proxy(Query(params): Query<Params>) -> Result<(), reqwest::Error> {
    let client = reqwest::Client::builder().timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none()).build()?;
    let url = allowed_url(&params.url)?;
    client.get(url).send().await?;
    Ok(())
}

pub async fn fetch(url: &str) -> Result<String, reqwest::Error> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;
    client.get(url).send().await?.text().await
}
