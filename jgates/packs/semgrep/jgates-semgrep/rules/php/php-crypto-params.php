<?php
function key_size_cases($path) {
    // ruleid: jgates.php.weak-key-size
    $a = openssl_pkey_new(['private_key_bits' => 1024, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
    // ruleid: jgates.php.weak-key-size
    $b = openssl_pkey_new(["private_key_bits" => 512]);
    // ruleid: jgates.php.weak-key-size
    $c = RSA::createKey(1024);
    // ruleid: jgates.php.weak-key-size
    $d = openssl_pkey_new(['curve_name' => 'secp160r1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
    // ok: jgates.php.weak-key-size
    $e = openssl_pkey_new(['private_key_bits' => 4096, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
    // ok: jgates.php.weak-key-size
    $f = openssl_pkey_new(['curve_name' => 'prime256v1', 'private_key_type' => OPENSSL_KEYTYPE_EC]);
    // ok: jgates.php.weak-key-size
    $g = RSA::createKey(3072);
}
function key_below_3072_cases() {
    // ruleid: jgates.php.rsa-key-below-3072
    $a = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
    // ruleid: jgates.php.rsa-key-below-3072
    $b = RSA::createKey(2048);
    // ok: jgates.php.rsa-key-below-3072
    $c = openssl_pkey_new(['private_key_bits' => 3072]);
    // ok: jgates.php.rsa-key-below-3072
    $d = RSA::createKey(4096);
    // ok: jgates.php.rsa-key-below-3072
    $e = openssl_pkey_new(['curve_name' => 'prime256v1']);
}
function static_iv_cases($data, $key, $message) {
    // ruleid: jgates.php.static-iv-or-nonce
    openssl_encrypt($data, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, '1234567890123456', $tag);
    // ruleid: jgates.php.static-iv-or-nonce
    openssl_encrypt($data, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, str_repeat("\0", 12), $tag);
    // ruleid: jgates.php.static-iv-or-nonce
    openssl_decrypt($data, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, hex2bin('000000000000000000000000'), $tag);
    // ruleid: jgates.php.static-iv-or-nonce
    sodium_crypto_secretbox($message, 'aaaaaaaaaaaaaaaaaaaaaaaa', $key);
    $zero = str_repeat("\0", 16);
    // ruleid: jgates.php.static-iv-or-nonce
    openssl_encrypt($data, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $zero, $tag);
    // ok: jgates.php.static-iv-or-nonce
    openssl_encrypt($data, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, random_bytes(12), $tag);
    $iv = random_bytes(12);
    // ok: jgates.php.static-iv-or-nonce
    openssl_encrypt($data, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
    $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
    // ok: jgates.php.static-iv-or-nonce
    sodium_crypto_secretbox($message, $nonce, $key);
}
function cipher_mode_cases($data, $key, $iv) {
    // ruleid: jgates.php.cipher-mode-without-authentication
    openssl_encrypt($data, 'aes-256-cbc', $key, OPENSSL_RAW_DATA, $iv);
    // ruleid: jgates.php.cipher-mode-without-authentication
    openssl_decrypt($data, 'AES-128-CTR', $key, OPENSSL_RAW_DATA, $iv);
    // ruleid: jgates.php.cipher-mode-without-authentication
    openssl_encrypt($data, 'aes-256-cfb', $key, 0, $iv);
    // ok: jgates.php.cipher-mode-without-authentication
    openssl_encrypt($data, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
    // ok: jgates.php.cipher-mode-without-authentication
    openssl_encrypt($data, 'chacha20-poly1305', $key, OPENSSL_RAW_DATA, $iv, $tag);
}
function kdf_cases($password, $salt) {
    // ruleid: jgates.php.weak-kdf-parameters
    hash_pbkdf2('sha256', $password, $salt, 1000, 32);
    // ruleid: jgates.php.weak-kdf-parameters
    openssl_pbkdf2($password, $salt, 32, 5000, 'sha256');
    // ruleid: jgates.php.weak-kdf-parameters
    password_hash($password, PASSWORD_BCRYPT, ['cost' => 4]);
    // ruleid: jgates.php.weak-kdf-parameters
    password_hash($password, PASSWORD_ARGON2ID, ['memory_cost' => 1024, 'time_cost' => 4]);
    // ruleid: jgates.php.weak-kdf-parameters
    password_hash($password, PASSWORD_ARGON2ID, ['time_cost' => 1]);
    // ruleid: jgates.php.weak-kdf-parameters
    sodium_crypto_pwhash(32, $password, $salt, 1, 67108864);
    // ok: jgates.php.weak-kdf-parameters
    hash_pbkdf2('sha256', $password, $salt, 600000, 32);
    // ok: jgates.php.weak-kdf-parameters
    password_hash($password, PASSWORD_DEFAULT);
    // ok: jgates.php.weak-kdf-parameters
    password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]);
    // ok: jgates.php.weak-kdf-parameters
    password_hash($password, PASSWORD_ARGON2ID, ['memory_cost' => 65536, 'time_cost' => 3]);
    // ok: jgates.php.weak-kdf-parameters
    sodium_crypto_pwhash(32, $password, $salt, SODIUM_CRYPTO_PWHASH_OPSLIMIT_INTERACTIVE, SODIUM_CRYPTO_PWHASH_MEMLIMIT_INTERACTIVE);
}
function fast_hash_cases($password, $fileContents) {
    // ruleid: jgates.php.password-hash-with-fast-hash
    $a = hash('sha256', $password);
    // ruleid: jgates.php.password-hash-with-fast-hash
    $b = hash('sha512', $_POST['password']);
    // ruleid: jgates.php.password-hash-with-fast-hash
    $c = hash('md5', $passwd);
    // ok: jgates.php.password-hash-with-fast-hash
    $d = password_hash($password, PASSWORD_DEFAULT);
    // ok: jgates.php.password-hash-with-fast-hash
    $e = hash('sha256', $fileContents);
    // ok: jgates.php.password-hash-with-fast-hash
    $f = hash_pbkdf2('sha256', $password, random_bytes(16), 600000, 32);
}
function comparison_cases($payload, $secret, $userSignature, $expectedMac) {
    $computedHmac = hash_hmac('sha256', $payload, $secret);
    // ruleid: jgates.php.timing-unsafe-comparison
    if ($computedHmac === $userSignature) { return true; }
    // ruleid: jgates.php.timing-unsafe-comparison
    if ($expectedMac == $_GET['mac']) { return true; }
    // ruleid: jgates.php.timing-unsafe-comparison
    if (hash_hmac('sha256', $payload, $secret) !== $userSignature) { return false; }
    // ok: jgates.php.timing-unsafe-comparison
    if (hash_equals($computedHmac, $userSignature)) { return true; }
    // ok: jgates.php.timing-unsafe-comparison
    if ($userSignature === null) { return false; }
    // ok: jgates.php.timing-unsafe-comparison
    if ($computedHmac === '') { return false; }
    // ok: jgates.php.timing-unsafe-comparison
    if ($payload === $secret) { return false; }
}
function signature_hash_cases($payload, $secret, $privateKey, $publicKey, $signature) {
    // ruleid: jgates.php.weak-signature-hash
    $a = hash_hmac('md5', $payload, $secret);
    // ruleid: jgates.php.weak-signature-hash
    $b = hash_hmac('sha1', $payload, $secret);
    // ruleid: jgates.php.weak-signature-hash
    openssl_sign($payload, $sig, $privateKey, OPENSSL_ALGO_SHA1);
    // ruleid: jgates.php.weak-signature-hash
    openssl_verify($payload, $signature, $publicKey);
    // ok: jgates.php.weak-signature-hash
    $c = hash_hmac('sha256', $payload, $secret);
    // ok: jgates.php.weak-signature-hash
    openssl_sign($payload, $sig, $privateKey, OPENSSL_ALGO_SHA256);
    // ok: jgates.php.weak-signature-hash
    openssl_verify($payload, $signature, $publicKey, 'sha512');
}
function hardcoded_key_cases($data, $iv, $payload, $message, $nonce) {
    // ruleid: jgates.php.hardcoded-encryption-key
    openssl_encrypt($data, 'aes-256-gcm', 'k3y-for-the-vault-0123456789abc', OPENSSL_RAW_DATA, $iv, $tag);
    // ruleid: jgates.php.hardcoded-encryption-key
    hash_hmac('sha256', $payload, 'my-shared-secret');
    // ruleid: jgates.php.hardcoded-encryption-key
    JWT::encode($payload, 'jwt-signing-secret', 'HS256');
    // ruleid: jgates.php.hardcoded-encryption-key
    sodium_crypto_secretbox($message, $nonce, hex2bin('00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'));
    // ruleid: jgates.php.hardcoded-encryption-key
    $verifier = new Key('another-literal-secret', 'HS256');
    // ok: jgates.php.hardcoded-encryption-key
    openssl_encrypt($data, 'aes-256-gcm', getenv('APP_ENC_KEY'), OPENSSL_RAW_DATA, $iv, $tag);
    // ok: jgates.php.hardcoded-encryption-key
    hash_hmac('sha256', $payload, $_ENV['HMAC_KEY']);
    // ok: jgates.php.hardcoded-encryption-key
    JWT::encode($payload, getenv('JWT_SECRET'), 'HS256');
    // ok: jgates.php.hardcoded-encryption-key
    sodium_crypto_secretbox($message, $nonce, sodium_crypto_secretbox_keygen());
}
function random_secret_cases() {
    // ruleid: jgates.php.insecure-random-for-secret
    $token = md5(uniqid(mt_rand(), true));
    // ruleid: jgates.php.insecure-random-for-secret
    $resetCode = rand(100000, 999999);
    $n = mt_rand();
    // ruleid: jgates.php.insecure-random-for-secret
    $salt = substr(md5($n), 0, 16);
    // ruleid: jgates.php.insecure-random-for-secret
    $record = ['api_token' => str_shuffle('abcdefghijklmnopqrstuvwxyz0123456789')];
    // ok: jgates.php.insecure-random-for-secret
    $token2 = bin2hex(random_bytes(32));
    // ok: jgates.php.insecure-random-for-secret
    $resetCode2 = random_int(100000, 999999);
    // ok: jgates.php.insecure-random-for-secret
    $dice = mt_rand(1, 6);
    // ok: jgates.php.insecure-random-for-secret
    $tempName = uniqid('upload_');
    // ok: jgates.php.insecure-random-for-secret
    $key = array_rand($record);
}
function uuid_secret_cases() {
    // ruleid: jgates.php.uuid-as-secret-token
    $token = Uuid::uuid4()->toString();
    // ruleid: jgates.php.uuid-as-secret-token
    $resetToken = Str::uuid();
    // ok: jgates.php.uuid-as-secret-token
    $requestId = Uuid::uuid4()->toString();
    // ok: jgates.php.uuid-as-secret-token
    $token2 = bin2hex(random_bytes(32));
}
