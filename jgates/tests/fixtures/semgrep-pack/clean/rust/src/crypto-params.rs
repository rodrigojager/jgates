use aes_gcm::aead::{AeadCore, OsRng};
use aes_gcm::Aes256Gcm;
use argon2::password_hash::{PasswordHasher, SaltString};
use argon2::Argon2;
use hmac::{Hmac, Mac};
use jsonwebtoken::EncodingKey;
use openssl::dh::Dh;
use openssl::rsa::Rsa;
use openssl::symm::Cipher;
use rand::Rng;
use sha2::Sha256;
use subtle::ConstantTimeEq;

pub fn account_keys() {
    let _signing = Rsa::generate(3072);
    let _wrapping = Rsa::generate(4096);
    let _dh = Dh::generate_params(2048, 2);
}

pub fn seal(cipher: &Aes256Gcm, data: &[u8]) -> Vec<u8> {
    let _mode = Cipher::aes_256_gcm();
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    cipher.encrypt(&nonce, data).unwrap()
}

pub fn store_password(password: &str) -> String {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default().hash_password(password.as_bytes(), &salt).unwrap().to_string()
}

pub fn check_request(computed_mac: &[u8], expected_mac: &[u8], key: &[u8]) -> bool {
    let _mac = Hmac::<Sha256>::new_from_slice(key);
    computed_mac.ct_eq(expected_mac).into()
}

pub fn issue_tokens() -> (EncodingKey, String) {
    let secret = std::env::var("JWT_SIGNING_SECRET").unwrap_or_default();
    let signing = EncodingKey::from_secret(secret.as_bytes());
    let mut rng = rand::thread_rng();
    let token: String = (0..32).map(|_| rng.gen_range(b'a'..=b'z') as char).collect();
    (signing, token)
}
