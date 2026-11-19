use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};

pub fn read_claims(token: &str) -> Option<Claims> {
    let data = jsonwebtoken::dangerous::insecure_decode::<Claims>(token).ok()?;
    Some(data.claims)
}

pub fn verify_with_header_algorithm(token: &str, key: &DecodingKey) -> Option<Claims> {
    let header = decode_header(token).ok()?;
    let validation = Validation::new(header.alg);
    decode::<Claims>(token, key, &validation).ok().map(|d| d.claims)
}

pub fn fetch_key(token: &str) -> Option<String> {
    let header = jsonwebtoken::decode_header(token).ok()?;
    let url = header.jku?;
    ureq::get(&url).call().ok()?.into_string().ok()
}

pub fn verify_without_expiry(token: &str, key: &DecodingKey) -> Option<Claims> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = false;
    decode::<Claims>(token, key, &validation).ok().map(|d| d.claims)
}

pub fn verify_without_audience(token: &str, key: &DecodingKey) -> Option<Claims> {
    let mut validation = Validation::new(Algorithm::RS256);
    validation.validate_aud = false;
    decode::<Claims>(token, key, &validation).ok().map(|d| d.claims)
}

pub fn login_url(client_id: &str, redirect: &str) -> String {
    format!(
        "https://idp.example.com/authorize?response_type=code&client_id={}&redirect_uri={}",
        client_id, redirect
    )
}

pub fn old_tls() -> SslConnector {
    let mut builder = SslConnector::builder(SslMethod::tls()).unwrap();
    builder.set_min_proto_version(Some(SslVersion::TLS1)).unwrap();
    builder.build()
}

pub fn weak_ciphers() -> SslAcceptor {
    let mut acceptor = SslAcceptor::mozilla_intermediate(SslMethod::tls()).unwrap();
    acceptor.set_cipher_list("RC4-SHA:AES128-SHA").unwrap();
    acceptor.build()
}

pub fn load_partner_data() -> Option<String> {
    ureq::get("http://partner.example.com/data").call().ok()?.into_string().ok()
}
