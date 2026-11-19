<?php
function password_cases($password, $checksumInput) {
    // ruleid: jgates.php.weak-hash
    $digest = md5($password);
    // ruleid: jgates.php.weak-hash
    $legacy = sha1($_POST['password']);
    // ok: jgates.php.weak-hash
    $stored = password_hash($password, PASSWORD_DEFAULT);
    // ok: jgates.php.weak-hash
    $matches = password_verify($password, $stored);
    // Non-password checksums are outside this rule.
    // ok: jgates.php.weak-hash
    $checksum = md5($checksumInput);
}
function cipher_cases($plaintext, $key, $nonce) {
    // ruleid: jgates.php.weak-cipher
    openssl_encrypt($plaintext, 'aes-128-ecb', $key);
    // ruleid: jgates.php.weak-cipher
    openssl_encrypt($plaintext, 'AES-256-ECB', $key);
    // ok: jgates.php.weak-cipher
    openssl_encrypt($plaintext, 'aes-128-gcm', $key, 0, $nonce, $tag);
    // ok: jgates.php.weak-cipher
    openssl_encrypt($plaintext, 'aes-256-gcm', $key, 0, $nonce, $tag);
}
function tls_cases($handle) {
    // ruleid: jgates.php.tls-verification-disabled
    curl_setopt($handle, CURLOPT_SSL_VERIFYPEER, false);
    // ruleid: jgates.php.tls-verification-disabled
    curl_setopt($handle, CURLOPT_SSL_VERIFYHOST, 0);
    // ruleid: jgates.php.tls-verification-disabled
    curl_setopt_array($handle, [CURLOPT_SSL_VERIFYPEER => false]);
    // ruleid: jgates.php.tls-verification-disabled
    curl_setopt_array($handle, [CURLOPT_SSL_VERIFYHOST => 0]);
    // ok: jgates.php.tls-verification-disabled
    curl_setopt($handle, CURLOPT_SSL_VERIFYPEER, true);
    // ok: jgates.php.tls-verification-disabled
    curl_setopt($handle, CURLOPT_SSL_VERIFYHOST, 2);
    // ok: jgates.php.tls-verification-disabled
    curl_setopt_array($handle, [CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2]);
}
