use md5::Md5;
use sha1::Sha1;
use sha2::{Digest, Sha256};

fn hashes(data: &[u8]) {
    // ruleid: jgates.rust.weak-hash
    let _a = md5::compute(data);
    // ruleid: jgates.rust.weak-hash
    let _b = Sha1::new();
    // ruleid: jgates.rust.weak-hash
    let _c = openssl::hash::MessageDigest::md5();
    // ok: jgates.rust.weak-hash
    let _d = Sha256::new();
    // ok: jgates.rust.weak-hash
    let _e = Sha256::digest(data);
}

fn ciphers(key: &[u8]) {
    // ruleid: jgates.rust.weak-cipher
    let _a = Des::new_from_slice(key);
    // ruleid: jgates.rust.weak-cipher
    let _b = Cipher::aes_128_ecb();
    // ruleid: jgates.rust.weak-cipher
    let _c = Rc4::new(key.into());
    // ok: jgates.rust.weak-cipher
    let _d = Cipher::aes_256_gcm();
    // ok: jgates.rust.weak-cipher
    let _e = Aes256Gcm::new_from_slice(key);
}

fn clients() {
    // ruleid: jgates.rust.tls-verification-disabled
    let _a = reqwest::Client::builder().danger_accept_invalid_certs(true).build();
    // ruleid: jgates.rust.tls-verification-disabled
    let _b = native_tls::TlsConnector::builder().danger_accept_invalid_hostnames(true).build();
    // ruleid: jgates.rust.tls-verification-disabled
    let _c = builder.set_verify(SslVerifyMode::NONE);
    // ok: jgates.rust.tls-verification-disabled
    let _d = reqwest::Client::builder().danger_accept_invalid_certs(false).build();
    // ok: jgates.rust.tls-verification-disabled
    let _e = builder.set_verify(SslVerifyMode::PEER);
}
