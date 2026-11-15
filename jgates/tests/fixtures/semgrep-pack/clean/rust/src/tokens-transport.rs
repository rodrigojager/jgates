use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};

pub fn read_claims(token: &str, key: &DecodingKey) -> Option<Claims> {
    let data = decode::<Claims>(token, key, &Validation::new(Algorithm::HS256)).ok()?;
    Some(data.claims)
}

pub fn verify_with_fixed_algorithm(token: &str, key: &DecodingKey) -> Option<Claims> {
    let validation = Validation::new(Algorithm::RS256);
    decode::<Claims>(token, key, &validation).ok().map(|d| d.claims)
}

pub fn fetch_key() -> Option<String> {
    ureq::get("https://issuer.example.com/.well-known/jwks.json").call().ok()?.into_string().ok()
}

pub fn verify_with_expiry(token: &str, key: &DecodingKey) -> Option<Claims> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_exp = true;
    validation.leeway = 5;
    decode::<Claims>(token, key, &validation).ok().map(|d| d.claims)
}

pub fn verify_with_audience(token: &str, key: &DecodingKey) -> Option<Claims> {
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_audience(&["my-service"]);
    decode::<Claims>(token, key, &validation).ok().map(|d| d.claims)
}

pub fn login_url(client_id: &str, redirect: &str, state: &str) -> String {
    format!(
        "https://idp.example.com/authorize?response_type=code&client_id={}&redirect_uri={}&state={}",
        client_id, redirect, state
    )
}

pub fn modern_tls() -> SslConnector {
    let mut builder = SslConnector::builder(SslMethod::tls()).unwrap();
    builder.set_min_proto_version(Some(SslVersion::TLS1_2)).unwrap();
    builder.build()
}

pub fn strong_ciphers() -> SslAcceptor {
    let mut acceptor = SslAcceptor::mozilla_intermediate(SslMethod::tls()).unwrap();
    acceptor.set_cipher_list("ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-CHACHA20-POLY1305").unwrap();
    acceptor.build()
}

pub fn load_partner_data() -> Option<String> {
    ureq::get("https://partner.example.com/data").call().ok()?.into_string().ok()
}
