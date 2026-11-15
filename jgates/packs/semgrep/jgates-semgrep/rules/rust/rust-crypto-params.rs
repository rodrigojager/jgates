use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use hmac::{Hmac, Mac};
use openssl::dh::Dh;
use openssl::ec::EcGroup;
use openssl::nid::Nid;
use openssl::pkey::PKey;
use openssl::rsa::Rsa;
use openssl::sign::Signer;
use openssl::symm::{encrypt, Cipher};
use rand::rngs::SmallRng;
use rand::{Rng, RngCore, SeedableRng};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use uuid::Uuid;

fn key_sizes(rng: &mut OsRng) {
    // ruleid: jgates.rust.weak-key-size
    let _a = Rsa::generate(1024);
    // ruleid: jgates.rust.weak-key-size
    let _b = RsaPrivateKey::new(rng, 512);
    // ruleid: jgates.rust.weak-key-size
    let _c = EcGroup::from_curve_name(Nid::SECP160R1);
    // ruleid: jgates.rust.weak-key-size
    let _d = Dsa::generate(1024);
    // ok: jgates.rust.weak-key-size
    let _e = Rsa::generate(3072);
    // ok: jgates.rust.weak-key-size
    let _f = RsaPrivateKey::new(rng, 4096);
    // ok: jgates.rust.weak-key-size
    let _g = EcGroup::from_curve_name(Nid::X9_62_PRIME256V1);
}

fn rsa_3072(rng: &mut OsRng) {
    // ruleid: jgates.rust.rsa-key-below-3072
    let _a = Rsa::generate(2048);
    // ruleid: jgates.rust.rsa-key-below-3072
    let _b = RsaPrivateKey::new(rng, 3000);
    // ok: jgates.rust.rsa-key-below-3072
    let _c = Rsa::generate(3072);
    // ok: jgates.rust.rsa-key-below-3072
    let _d = RsaPrivateKey::new(rng, 4096);
}

fn nonces(cipher: &Aes256Gcm, key: &[u8], iv: &[u8], data: &[u8]) {
    // ruleid: jgates.rust.static-iv-or-nonce
    let _a = cipher.encrypt(Nonce::from_slice(b"unique nonce"), data);
    // ruleid: jgates.rust.static-iv-or-nonce
    let _b = cipher.encrypt(Nonce::from_slice(&[0u8; 12]), data);
    // ruleid: jgates.rust.static-iv-or-nonce
    let _c = encrypt(Cipher::chacha20(), key, Some(b"0123456789abcdef"), data);
    // ok: jgates.rust.static-iv-or-nonce
    let _d = cipher.encrypt(Nonce::from_slice(iv), data);
    // ok: jgates.rust.static-iv-or-nonce
    let _e = encrypt(Cipher::chacha20(), key, Some(iv), data);
}

fn modes(key: &[u8], iv: &[u8]) {
    // ruleid: jgates.rust.cipher-mode-without-authentication
    let _a = Cipher::aes_256_cbc();
    // ruleid: jgates.rust.cipher-mode-without-authentication
    let _b = Cipher::aes_128_ctr();
    // ruleid: jgates.rust.cipher-mode-without-authentication
    let _c = cbc::Encryptor::<aes::Aes128>::new(key.into(), iv.into());
    // ok: jgates.rust.cipher-mode-without-authentication
    let _d = Cipher::aes_256_gcm();
    // ok: jgates.rust.cipher-mode-without-authentication
    let _e = Cipher::chacha20_poly1305();
}

fn work_factors(pw: &[u8], salt: &[u8], out: &mut [u8]) {
    // ruleid: jgates.rust.weak-kdf-parameters
    pbkdf2_hmac(pw, salt, 1000, MessageDigest::sha256(), out);
    // ruleid: jgates.rust.weak-kdf-parameters
    pbkdf2_hmac::<Sha256>(pw, salt, 5000, out);
    // ruleid: jgates.rust.weak-kdf-parameters
    let _a = bcrypt::hash(pw, 4);
    // ruleid: jgates.rust.weak-kdf-parameters
    let _b = scrypt::Params::new(10, 8, 1, 32);
    // ruleid: jgates.rust.weak-kdf-parameters
    let _c = Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::new(4096, 3, 1, None).unwrap());
    // ruleid: jgates.rust.weak-kdf-parameters
    let _d = Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::new(65536, 1, 1, None).unwrap());
    // ruleid: jgates.rust.weak-kdf-parameters
    pbkdf2::derive(pbkdf2::PBKDF2_HMAC_SHA256, NonZeroU32::new(1000).unwrap(), salt, pw, out);
    // ok: jgates.rust.weak-kdf-parameters
    pbkdf2_hmac(pw, salt, 600000, MessageDigest::sha256(), out);
    // ok: jgates.rust.weak-kdf-parameters
    pbkdf2_hmac::<Sha256>(pw, salt, 600_000, out);
    // ok: jgates.rust.weak-kdf-parameters
    let _e = bcrypt::hash(pw, 12);
    // ok: jgates.rust.weak-kdf-parameters
    let _f = bcrypt::hash(pw, bcrypt::DEFAULT_COST);
    // ok: jgates.rust.weak-kdf-parameters
    let _g = scrypt::Params::new(15, 8, 1, 32);
    // ok: jgates.rust.weak-kdf-parameters
    let _h = Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::new(19456, 2, 1, None).unwrap());
}

fn password_storage(password: &str, user_password: &str, salt: &SaltString, data: &[u8]) {
    // ruleid: jgates.rust.password-hash-with-fast-hash
    let _a = Sha256::digest(password.as_bytes());
    // ruleid: jgates.rust.password-hash-with-fast-hash
    let _b = Sha256::new().chain_update(user_password);
    let mut hasher = Sha256::new();
    // ruleid: jgates.rust.password-hash-with-fast-hash
    hasher.update(password);
    // ok: jgates.rust.password-hash-with-fast-hash
    let _c = Argon2::default().hash_password(password.as_bytes(), salt);
    // ok: jgates.rust.password-hash-with-fast-hash
    let _d = Sha256::digest(data);
}

fn comparisons(computed_mac: &[u8], expected_mac: &[u8], signature: &[u8], provided: &[u8], sig: &[u8]) {
    // ruleid: jgates.rust.timing-unsafe-comparison
    if computed_mac == expected_mac {}
    // ruleid: jgates.rust.timing-unsafe-comparison
    if signature != provided {}
    // ruleid: jgates.rust.timing-unsafe-comparison
    if provided == sig.to_vec() {}
    // ok: jgates.rust.timing-unsafe-comparison
    if computed_mac.ct_eq(expected_mac).into() {}
    // ok: jgates.rust.timing-unsafe-comparison
    if verify_slice_eq(signature, provided).is_ok() {}
    // ok: jgates.rust.timing-unsafe-comparison
    if sig.len() == 64 {}
}

fn signatures(key: &[u8], pkey: &PKey<Private>) {
    // ruleid: jgates.rust.weak-signature-hash
    let _a = Hmac::<Sha1>::new_from_slice(key);
    // ruleid: jgates.rust.weak-signature-hash
    let _b = Pkcs1v15Sign::new::<Sha1>();
    // ruleid: jgates.rust.weak-signature-hash
    let _c = hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, key);
    // ruleid: jgates.rust.weak-signature-hash
    let _d = Signer::new(MessageDigest::sha1(), pkey);
    // ok: jgates.rust.weak-signature-hash
    let _e = Hmac::<Sha256>::new_from_slice(key);
    // ok: jgates.rust.weak-signature-hash
    let _f = Pkcs1v15Sign::new::<Sha256>();
    // ok: jgates.rust.weak-signature-hash
    let _g = Signer::new(MessageDigest::sha256(), pkey);
}

fn dh_groups() {
    // ruleid: jgates.rust.weak-dh-parameters
    let _a = Dh::generate_params(1024, 2);
    // ruleid: jgates.rust.weak-dh-parameters
    let _b = Dh::get_1024_160();
    // ok: jgates.rust.weak-dh-parameters
    let _c = Dh::generate_params(2048, 2);
    // ok: jgates.rust.weak-dh-parameters
    let _d = Dh::get_2048_256();
}

fn keys(key_bytes: &[u8], secret: &str, iv: &[u8], data: &[u8]) {
    // ruleid: jgates.rust.hardcoded-encryption-key
    let _a = Aes256Gcm::new_from_slice(b"0123456789abcdef0123456789abcdef");
    // ruleid: jgates.rust.hardcoded-encryption-key
    let _b = EncodingKey::from_secret(b"my-signing-secret");
    // ruleid: jgates.rust.hardcoded-encryption-key
    let _c = hmac::Key::new(hmac::HMAC_SHA256, b"hmac-secret");
    // ruleid: jgates.rust.hardcoded-encryption-key
    let _d = Hmac::<Sha256>::new_from_slice("shared secret".as_bytes());
    // ruleid: jgates.rust.hardcoded-encryption-key
    let _e = encrypt(Cipher::chacha20(), &[0u8; 32], Some(iv), data);
    // ok: jgates.rust.hardcoded-encryption-key
    let _f = Aes256Gcm::new_from_slice(key_bytes);
    // ok: jgates.rust.hardcoded-encryption-key
    let _g = EncodingKey::from_secret(secret.as_bytes());
    // ok: jgates.rust.hardcoded-encryption-key
    let _h = Key::<Aes256Gcm>::from_slice(key_bytes);
}

fn randomness() {
    let mut rng = SmallRng::from_entropy();
    // ruleid: jgates.rust.insecure-random-for-secret
    let token: String = (0..32).map(|_| rng.sample(Alphanumeric) as char).collect();
    // ruleid: jgates.rust.insecure-random-for-secret
    let session_id = fastrand::u64(..);
    let mut api_key = [0u8; 32];
    // ruleid: jgates.rust.insecure-random-for-secret
    rng.fill_bytes(&mut api_key);
    // ruleid: jgates.rust.insecure-random-for-secret
    let reset_code = SmallRng::seed_from_u64(42).gen::<u64>();
    let mut strong = rand::thread_rng();
    // ok: jgates.rust.insecure-random-for-secret
    let ok_token: String = (0..32).map(|_| strong.sample(Alphanumeric) as char).collect();
    let mut os_key = [0u8; 32];
    // ok: jgates.rust.insecure-random-for-secret
    OsRng.fill_bytes(&mut os_key);
    // ok: jgates.rust.insecure-random-for-secret
    let dice_roll = fastrand::u32(1..7);
    // ok: jgates.rust.insecure-random-for-secret
    let jitter = rng.gen_range(0..100);
}

fn uuids() {
    // ruleid: jgates.rust.uuid-as-secret-token
    let session_token = Uuid::new_v4().to_string();
    // ruleid: jgates.rust.uuid-as-secret-token
    let reset_code = uuid::Uuid::new_v4().simple().to_string();
    // ok: jgates.rust.uuid-as-secret-token
    let request_id = Uuid::new_v4().to_string();
    let mut raw = [0u8; 32];
    OsRng.fill_bytes(&mut raw);
    // ok: jgates.rust.uuid-as-secret-token
    let token = hex::encode(raw);
}
