use log::info;

pub fn login(user: &str, password: &str) {
    info!("login attempt {} {}", user, password);
}

pub fn error_response(result: Result<(), std::io::Error>) {
    match result {
        Ok(_) => {},
        Err(e) => { HttpResponse::InternalServerError().body(e.to_string()); }
    }
}

pub fn persist() {
    if let Err(_) = save() {}
}

pub async fn proxy(Query(params): Query<Params>) -> Result<(), reqwest::Error> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build()?;
    let url = allowed_url(&params.url)?;
    client.get(url).send().await?;
    Ok(())
}

pub async fn fetch(url: &str) -> Result<String, reqwest::Error> {
    let client = reqwest::Client::new();
    client.get(url).send().await?.text().await
}
