<?php
use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use Lcobucci\JWT\Configuration;
use Lcobucci\JWT\Signer;

function session_user($jwt, $key, $header) {
    $config = Configuration::forSymmetricSigner(new Signer\Hmac\Sha256(), $key);
    $claims = JWT::decode($jwt, new Key($key, 'RS256'));
    $expected = 'ES256';
    $other = JWT::decode($jwt, new Key($key, $expected));
    return [$config, $claims, $other];
}

function fetch_profile($url) {
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    curl_setopt($ch, CURLOPT_SSLVERSION, CURL_SSLVERSION_TLSv1_2);
    curl_setopt($ch, CURLOPT_SSL_CIPHER_LIST, 'ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-CHACHA20-POLY1305');
    curl_setopt($ch, CURLOPT_URL, 'https://profiles.example.com/api/me');
    return curl_exec($ch);
}
