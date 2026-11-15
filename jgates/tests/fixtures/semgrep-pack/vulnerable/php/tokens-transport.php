<?php
use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use Lcobucci\JWT\Configuration;

function session_user($jwt, $key, $header) {
    $unchecked = Configuration::forUnsecuredSigner();
    $claims = JWT::decode($jwt, new Key($key, 'none'));
    $alg = $header['alg'];
    $other = JWT::decode($jwt, new Key($key, $alg));
    return [$unchecked, $claims, $other];
}

function fetch_profile($url) {
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    curl_setopt($ch, CURLOPT_SSLVERSION, CURL_SSLVERSION_TLSv1_0);
    curl_setopt($ch, CURLOPT_SSL_CIPHER_LIST, 'ECDHE-RSA-AES128-GCM-SHA256:RC4-SHA');
    curl_setopt($ch, CURLOPT_URL, 'http://profiles.example.com/api/me');
    return curl_exec($ch);
}
