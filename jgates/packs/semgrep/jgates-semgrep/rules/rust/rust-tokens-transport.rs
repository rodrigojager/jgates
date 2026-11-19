use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};

fn signature(token: &str, key: &DecodingKey) {
    // ruleid: jgates.rust.jwt-signature-not-verified
    let _a = jsonwebtoken::dangerous::insecure_decode::<Claims>(token);
    // ruleid: jgates.rust.jwt-signature-not-verified
    let _b = insecure_decode::<Claims>(token);
    // ruleid: jgates.rust.jwt-signature-not-verified
    let _c = jsonwebtoken::dangerous_insecure_decode::<Claims>(token);
    let mut v = Validation::new(Algorithm::HS256);
    // ruleid: jgates.rust.jwt-signature-not-verified
    v.insecure_disable_signature_validation();
    // ok: jgates.rust.jwt-signature-not-verified
    let _d = decode::<Claims>(token, key, &Validation::new(Algorithm::HS256));
    // ok: jgates.rust.jwt-signature-not-verified
    let _e = decode::<Claims>(token, key, &Validation::default());
}

fn algorithm(token: &str, key: &DecodingKey) {
    let header = decode_header(token).unwrap();
    // ruleid: jgates.rust.jwt-algorithm-not-restricted
    let _a = Validation::new(header.alg);
    let mut v = Validation::default();
    // ruleid: jgates.rust.jwt-algorithm-not-restricted
    v.algorithms = vec![header.alg];
    // ok: jgates.rust.jwt-algorithm-not-restricted
    let _b = Validation::new(Algorithm::RS256);
    let mut w = Validation::default();
    // ok: jgates.rust.jwt-algorithm-not-restricted
    w.algorithms = vec![Algorithm::ES256, Algorithm::RS256];
}

fn key_from_header(token: &str) {
    let header = jsonwebtoken::decode_header(token).unwrap();
    // ruleid: jgates.rust.jwt-key-from-token-header
    let _a = reqwest::get(header.jku.unwrap());
    // ruleid: jgates.rust.jwt-key-from-token-header
    let _b = ureq::get(&header.x5u.unwrap());
    // ok: jgates.rust.jwt-key-from-token-header
    let _c = reqwest::get("https://issuer.example.com/.well-known/jwks.json");
    // ok: jgates.rust.jwt-key-from-token-header
    let _d = ureq::get(&JWKS_URL);
}

fn expiry() {
    let mut v = Validation::new(Algorithm::HS256);
    // ruleid: jgates.rust.jwt-expiry-not-validated
    v.validate_exp = false;
    let mut w = Validation::default();
    // ruleid: jgates.rust.jwt-expiry-not-validated
    w.validate_exp = false;
    let mut x = Validation::default();
    // ok: jgates.rust.jwt-expiry-not-validated
    x.validate_exp = true;
    // ok: jgates.rust.jwt-expiry-not-validated
    x.leeway = 5;
}

fn audience() {
    let mut v = Validation::new(Algorithm::HS256);
    // ruleid: jgates.rust.jwt-audience-not-validated
    v.validate_aud = false;
    let mut w = Validation::default();
    // ruleid: jgates.rust.jwt-audience-not-validated
    w.validate_aud = false;
    let mut x = Validation::default();
    // ok: jgates.rust.jwt-audience-not-validated
    x.set_audience(&["my-service"]);
    // ok: jgates.rust.jwt-audience-not-validated
    x.validate_aud = true;
}

fn oauth(client_id: &str, redirect: &str) {
    // ruleid: jgates.rust.oauth-request-without-state
    let _a = format!("https://idp.example.com/authorize?response_type=code&client_id={}&redirect_uri={}", client_id, redirect);
    // ruleid: jgates.rust.oauth-request-without-state
    let _b = Url::parse("https://idp.example.com/authorize?response_type=token&client_id=abc");
    // ok: jgates.rust.oauth-request-without-state
    let _c = format!("https://idp.example.com/authorize?response_type=code&client_id={}&state={}", client_id, new_state());
    // ok: jgates.rust.oauth-request-without-state
    let _d = format!("https://idp.example.com/authorize?response_type=code&client_id={}&code_challenge={}&code_challenge_method=S256", client_id, challenge());
}

fn tls_version() {
    let mut a = SslConnector::builder(SslMethod::tls()).unwrap();
    // ruleid: jgates.rust.tls-old-protocol-version
    a.set_min_proto_version(Some(SslVersion::TLS1)).unwrap();
    // ruleid: jgates.rust.tls-old-protocol-version
    a.set_min_proto_version(Some(openssl::ssl::SslVersion::SSL3)).unwrap();
    let mut n = native_tls::TlsConnector::builder();
    // ruleid: jgates.rust.tls-old-protocol-version
    n.min_protocol_version(Some(Protocol::Tlsv10));
    // ruleid: jgates.rust.tls-old-protocol-version
    let _r = reqwest::Client::builder().min_tls_version(tls::Version::TLS_1_1);
    // ok: jgates.rust.tls-old-protocol-version
    a.set_min_proto_version(Some(SslVersion::TLS1_2)).unwrap();
    // ok: jgates.rust.tls-old-protocol-version
    n.min_protocol_version(Some(Protocol::Tlsv12));
    // ok: jgates.rust.tls-old-protocol-version
    let _s = reqwest::Client::builder().min_tls_version(tls::Version::TLS_1_2);
}

fn tls_ciphers() {
    let mut a = SslAcceptor::mozilla_intermediate(SslMethod::tls()).unwrap();
    // ruleid: jgates.rust.tls-weak-cipher-suite
    a.set_cipher_list("RC4-SHA:AES128-SHA").unwrap();
    // ruleid: jgates.rust.tls-weak-cipher-suite
    a.set_cipher_list("DES-CBC3-SHA").unwrap();
    // ruleid: jgates.rust.tls-weak-cipher-suite
    a.set_cipher_list("ECDHE-RSA-AES256-GCM-SHA384:eNULL").unwrap();
    // ok: jgates.rust.tls-weak-cipher-suite
    a.set_cipher_list("ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-CHACHA20-POLY1305").unwrap();
    // ok: jgates.rust.tls-weak-cipher-suite
    a.set_cipher_list("HIGH:!aNULL:!RC4:!3DES").unwrap();
    // ok: jgates.rust.tls-weak-cipher-suite
    a.set_ciphersuites("TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256").unwrap();
}

async fn cleartext() {
    let client = reqwest::Client::new();
    // ruleid: jgates.rust.cleartext-http-url
    let _a = reqwest::get("http://api.example.com/data").await;
    // ruleid: jgates.rust.cleartext-http-url
    let _b = client.post("http://api.example.com/submit").send().await;
    // ruleid: jgates.rust.cleartext-http-url
    let _c = ureq::get("ftp://files.example.com/report.csv").call();
    // ruleid: jgates.rust.cleartext-http-url
    let _d = reqwest::Client::new().get("http://api.example.com/x");
    // ok: jgates.rust.cleartext-http-url
    let _e = reqwest::get("https://api.example.com/data").await;
    // ok: jgates.rust.cleartext-http-url
    let _f = client.post("https://api.example.com/submit").send().await;
    // ok: jgates.rust.cleartext-http-url
    let _g = reqwest::get("http://localhost:8080/health").await;
    // ok: jgates.rust.cleartext-http-url
    let _h = ureq::get("http://127.0.0.1:9000/metrics").call();
}
