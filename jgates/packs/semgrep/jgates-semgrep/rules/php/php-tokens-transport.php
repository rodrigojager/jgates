<?php
use Firebase\JWT\JWT;
use Firebase\JWT\Key;
use Lcobucci\JWT\Configuration;
use Lcobucci\JWT\Signer;
use GuzzleHttp\Client;
use Illuminate\Support\Facades\Http;

function signature_cases($jwt, $secret, $config) {
    // ruleid: jgates.php.jwt-signature-not-verified
    $a = Configuration::forUnsecuredSigner();
    // ruleid: jgates.php.jwt-signature-not-verified
    $b = JWT::jsonDecode(JWT::urlsafeB64Decode(explode('.', $jwt)[1]));
    // ok: jgates.php.jwt-signature-not-verified
    $c = JWT::decode($jwt, new Key($secret, 'HS256'));
    if ($c->aud !== 'api') { throw new RuntimeException('Audience mismatch'); }
    // ok: jgates.php.jwt-signature-not-verified
    $d = Configuration::forSymmetricSigner(new Signer\Hmac\Sha256(), $secret);
}

function key_location_cases($header, $headerObject, $trustedKeys) {
    // ruleid: jgates.php.jwt-key-from-token-header
    $remote = file_get_contents($header['jku']);
    // ruleid: jgates.php.jwt-key-from-token-header
    $local = fopen('/keys/' . $headerObject->kid, 'r');
    // ok: jgates.php.jwt-key-from-token-header
    $fixed = file_get_contents('https://issuer.example/keys');
    // ok: jgates.php.jwt-key-from-token-header
    $selected = $trustedKeys[$header['kid']];
}

function time_constraint_cases($validator, $token, $signer, $key, $clock) {
    // ruleid: jgates.php.jwt-expiry-not-validated
    $validator->validate($token, new SignedWith($signer, $key), new PermittedFor('api'));
    // ruleid: jgates.php.jwt-expiry-not-validated
    $validator->validate($token, new \Lcobucci\JWT\Validation\Constraint\SignedWith($signer, $key), new PermittedFor('api'));
    // ok: jgates.php.jwt-expiry-not-validated
    $validator->validate($token, new SignedWith($signer, $key), new LooseValidAt($clock), new PermittedFor('api'));
    // ok: jgates.php.jwt-expiry-not-validated
    $validator->validate($token, new SignedWith($signer, $key), new \Lcobucci\JWT\Validation\Constraint\StrictValidAt($clock), new PermittedFor('api'));
}

function audience_constraint_cases($validator, $token, $signer, $key, $clock) {
    // ruleid: jgates.php.jwt-audience-not-validated
    $validator->validate($token, new SignedWith($signer, $key), new LooseValidAt($clock));
    // ruleid: jgates.php.jwt-audience-not-validated
    $claims = JWT::decode($token, new Key($key, 'RS256'));
    // ok: jgates.php.jwt-audience-not-validated
    $validator->validate($token, new SignedWith($signer, $key), new LooseValidAt($clock), new PermittedFor('api'));
}

function verified_firebase_audience($token, $key) {
    // ok: jgates.php.jwt-audience-not-validated
    $claims = \Firebase\JWT\JWT::decode($token, new Key($key, 'RS256'));
    if ($claims->aud !== 'api') { throw new RuntimeException('Audience mismatch'); }
    return $claims;
}

function authorization_query_cases($clientId, $state, $challenge, $provider) {
    // ruleid: jgates.php.oauth-request-without-state
    $url = 'https://issuer.example/authorize?' . http_build_query(['response_type' => 'code', 'client_id' => $clientId]);
    // ruleid: jgates.php.oauth-request-without-state
    $query = http_build_query(['client_id' => $clientId, 'response_type' => 'code', 'scope' => 'profile'], '', '&');
    // ok: jgates.php.oauth-request-without-state
    $bound = http_build_query(['response_type' => 'code', 'client_id' => $clientId, 'state' => $state]);
    // ok: jgates.php.oauth-request-without-state
    $pkce = http_build_query(['response_type' => 'code', 'client_id' => $clientId, 'code_challenge' => $challenge, 'code_challenge_method' => 'S256']);
    // League generates state by default; callers must retain and check getState() on callback.
    // ok: jgates.php.oauth-request-without-state
    $managed = $provider->getAuthorizationUrl();
}

function algorithm_cases($jwt, $key, $header) {
    // ruleid: jgates.php.jwt-algorithm-not-restricted
    JWT::decode($jwt, new Key($key, 'none'));
    // ruleid: jgates.php.jwt-algorithm-not-restricted
    JWT::decode($jwt, $key, ['HS256', "none"]);
    // ruleid: jgates.php.jwt-algorithm-not-restricted
    $s = new Signer\None();
    // ok: jgates.php.jwt-algorithm-not-restricted
    JWT::decode($jwt, new Key($key, 'RS256'));
    // ok: jgates.php.jwt-algorithm-not-restricted
    JWT::decode($jwt, $key, ['RS256']);
}

function algorithm_header_cases($jwt, $key, $header, $headerObject) {
    $alg = $header['alg'];
    // ruleid: jgates.php.jwt-algorithm-not-restricted-header
    JWT::decode($jwt, new Key($key, $alg));
    // ruleid: jgates.php.jwt-algorithm-not-restricted-header
    JWT::decode($jwt, new Key($key, $headerObject->alg));
    $expected = 'ES256';
    // ok: jgates.php.jwt-algorithm-not-restricted-header
    JWT::decode($jwt, new Key($key, $expected));
    // ok: jgates.php.jwt-algorithm-not-restricted-header
    JWT::decode($jwt, new Key($key, $header['kid'] ? 'RS256' : 'ES256'));
}

function tls_version_cases($ch) {
    // ruleid: jgates.php.tls-old-protocol-version
    curl_setopt($ch, CURLOPT_SSLVERSION, CURL_SSLVERSION_TLSv1_0);
    // ruleid: jgates.php.tls-old-protocol-version
    $ctx = stream_context_create(['ssl' => ['crypto_method' => STREAM_CRYPTO_METHOD_TLSv1_1_CLIENT]]);
    // ruleid: jgates.php.tls-old-protocol-version
    stream_socket_enable_crypto($ch, true, STREAM_CRYPTO_METHOD_SSLv3_CLIENT);
    // ok: jgates.php.tls-old-protocol-version
    curl_setopt($ch, CURLOPT_SSLVERSION, CURL_SSLVERSION_TLSv1_2);
    // ok: jgates.php.tls-old-protocol-version
    stream_socket_enable_crypto($ch, true, STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT);
}

function cipher_cases($ch) {
    // ruleid: jgates.php.tls-weak-cipher-suite
    curl_setopt($ch, CURLOPT_SSL_CIPHER_LIST, 'ECDHE-RSA-AES128-GCM-SHA256:RC4-SHA');
    // ruleid: jgates.php.tls-weak-cipher-suite
    curl_setopt($ch, CURLOPT_SSL_CIPHER_LIST, 'EDH-RSA-DES-CBC3-SHA');
    // ruleid: jgates.php.tls-weak-cipher-suite
    stream_context_create(['ssl' => ['ciphers' => 'ALL:aNULL']]);
    // ok: jgates.php.tls-weak-cipher-suite
    curl_setopt($ch, CURLOPT_SSL_CIPHER_LIST, 'ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-CHACHA20-POLY1305');
    // ok: jgates.php.tls-weak-cipher-suite
    curl_setopt($ch, CURLOPT_SSL_CIPHER_LIST, 'HIGH:!aNULL:!RC4:!3DES');
}

function cleartext_cases($path, $httpClient) {
    // ruleid: jgates.php.cleartext-http-url
    $a = file_get_contents('http://api.example.com/data');
    // ruleid: jgates.php.cleartext-http-url
    $ch = curl_init("http://api.example.com/v1/" . $path);
    // ruleid: jgates.php.cleartext-http-url
    $r = Http::get('http://api.example.com/items');
    // ruleid: jgates.php.cleartext-http-url
    $c = new Client(['base_uri' => 'http://api.example.com/']);
    // ruleid: jgates.php.cleartext-http-url
    $f = fopen('ftp://files.example.com/export.csv', 'r');
    // ruleid: jgates.php.cleartext-http-url
    $g = $httpClient->get('http://api.example.com/ping');
    // ok: jgates.php.cleartext-http-url
    $d = file_get_contents('https://api.example.com/data');
    // ok: jgates.php.cleartext-http-url
    $e = file_get_contents('http://localhost:8080/health');
    // ok: jgates.php.cleartext-http-url
    $h = curl_init('http://127.0.0.1/status');
    // ok: jgates.php.cleartext-http-url
    $i = new Client(['base_uri' => 'https://api.example.com/']);
}
