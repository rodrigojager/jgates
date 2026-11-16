<?php
use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use Lcobucci\JWT\Configuration;
use Lcobucci\JWT\Signer;

function session_user($jwt, $key, $header) {
    $config = Configuration::forSymmetricSigner(new Signer\Hmac\Sha256(), $key);
    $claims = JWT::decode($jwt, new Key($key, 'RS256'));
    if ($claims->aud !== 'api') { throw new RuntimeException('Audience mismatch'); }
    $expected = 'ES256';
    $other = JWT::decode($jwt, new Key($key, $expected));
    if ($other->aud !== 'api') { throw new RuntimeException('Audience mismatch'); }
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

function validate_session($validator, $token, $signer, $key, $header, $clock) {
    $selectedKey = file_get_contents('https://issuer.example/keys');
    return $validator->validate($token, new SignedWith($signer, $key), new StrictValidAt($clock), new PermittedFor('api'));
}

function authorize_session($clientId, $sessionState) {
    return 'https://issuer.example/authorize?' . http_build_query(['response_type' => 'code', 'client_id' => $clientId, 'state' => $sessionState]);
}
