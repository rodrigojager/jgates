use aes_gcm::{Aes256Gcm, Nonce};
use argon2::password_hash::SaltString;
use hmac::{Hmac, Mac};
use jsonwebtoken::EncodingKey;
use openssl::dh::Dh;
use openssl::hash::MessageDigest;
use openssl::pkcs5::pbkdf2_hmac;
use openssl::rsa::Rsa;
use openssl::symm::Cipher;
use rand::rngs::SmallRng;
use rand::{Rng, SeedableRng};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub fn account_keys() {
    let _signing = Rsa::generate(1024);
    let _wrapping = Rsa::generate(2048);
    let _dh = Dh::generate_params(1024, 2);
}

pub fn seal(cipher: &Aes256Gcm, data: &[u8]) -> Vec<u8> {
    let _mode = Cipher::aes_256_cbc();
    cipher.encrypt(Nonce::from_slice(b"unique nonce"), data).unwrap()
}

pub fn store_password(password: &str, salt: &[u8], out: &mut [u8]) {
    pbkdf2_hmac(password.as_bytes(), salt, 1000, MessageDigest::sha256(), out).unwrap();
    let _digest = Sha256::digest(password.as_bytes());
}

pub fn check_request(computed_mac: &[u8], expected_mac: &[u8], key: &[u8]) -> bool {
    let _mac = Hmac::<Sha1>::new_from_slice(key);
    computed_mac == expected_mac
}

pub fn issue_tokens() -> (EncodingKey, String, String) {
    let signing = EncodingKey::from_secret(b"my-signing-secret");
    let mut rng = SmallRng::from_entropy();
    let token: String = (0..32).map(|_| rng.gen_range(b'a'..=b'z') as char).collect();
    let session_token = Uuid::new_v4().to_string();
    (signing, token, session_token)
}
