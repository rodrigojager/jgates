<?php

use Symfony\Component\HttpFoundation\Cookie;
use Symfony\Component\HttpFoundation\JsonResponse;

// ---- cookie-without-secure ----
function secure_cases($v)
{
    // ruleid: jgates.php.cookie-without-secure
    setcookie('__Host-a', $v, ['httponly' => true, 'samesite' => 'Lax']);
    // ruleid: jgates.php.cookie-without-secure
    setcookie('__Host-a', $v, ['secure' => false, 'httponly' => true, 'samesite' => 'Lax']);
    // ruleid: jgates.php.cookie-without-secure
    ini_set('session.cookie_secure', '0');
    // ruleid: jgates.php.cookie-without-secure
    header('Set-Cookie: __Host-s=1; Path=/; HttpOnly; SameSite=Lax');
    // ruleid: jgates.php.cookie-without-secure
    $c = new Cookie('__Host-a', $v, 0, '/', null, false, true, false, 'lax');
    // ruleid: jgates.php.cookie-without-secure, jgates.php.cookie-without-samesite
    session_set_cookie_params(0, '/', '', false, true);
    // ok: jgates.php.cookie-without-secure
    setcookie('__Host-a', $v, ['secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
    // ok: jgates.php.cookie-without-secure
    session_set_cookie_params(['secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
    // ok: jgates.php.cookie-without-secure
    ini_set('session.cookie_secure', '1');
    // ok: jgates.php.cookie-without-secure
    header('Set-Cookie: __Host-s=1; Path=/; Secure; HttpOnly; SameSite=Lax');
    // ok: jgates.php.cookie-without-secure
    setcookie('__Host-a', '', time() - 3600);
}

// ---- cookie-without-httponly ----
function httponly_cases($v)
{
    // ruleid: jgates.php.cookie-without-httponly
    setcookie('__Host-b', $v, ['secure' => true, 'samesite' => 'Lax']);
    // ruleid: jgates.php.cookie-without-httponly
    setcookie('__Host-b', $v, ['secure' => true, 'httponly' => false, 'samesite' => 'Lax']);
    // ruleid: jgates.php.cookie-without-httponly
    ini_set('session.cookie_httponly', '0');
    // ruleid: jgates.php.cookie-without-httponly, jgates.php.cookie-without-samesite
    setcookie('__Host-b', $v, time() + 3600, '/', '', true, false);
    // ruleid: jgates.php.cookie-without-httponly
    header('Set-Cookie: __Host-s=1; Path=/; Secure; SameSite=Lax');
    // ok: jgates.php.cookie-without-httponly
    setcookie('__Host-b', $v, ['secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
    // ok: jgates.php.cookie-without-httponly
    ini_set('session.cookie_httponly', '1');
    // ok: jgates.php.cookie-without-httponly
    session_set_cookie_params(['secure' => true, 'httponly' => true, 'samesite' => 'Strict']);
}

// ---- cookie-without-samesite ----
function samesite_cases($v)
{
    // ruleid: jgates.php.cookie-without-samesite
    setcookie('__Host-d', $v, ['secure' => true, 'httponly' => true]);
    // ruleid: jgates.php.cookie-without-samesite
    setcookie('__Host-d', $v, ['secure' => true, 'httponly' => true, 'samesite' => 'None']);
    // ruleid: jgates.php.cookie-without-samesite
    ini_set('session.cookie_samesite', 'None');
    // ruleid: jgates.php.cookie-without-samesite
    header('Set-Cookie: __Host-s=1; Path=/; Secure; HttpOnly');
    // ok: jgates.php.cookie-without-samesite
    setcookie('__Host-d', $v, ['secure' => true, 'httponly' => true, 'samesite' => 'Strict']);
    // ok: jgates.php.cookie-without-samesite
    ini_set('session.cookie_samesite', 'Lax');
    // ok: jgates.php.cookie-without-samesite
    header('Set-Cookie: __Host-s=1; Path=/; Secure; HttpOnly; SameSite=Strict');
}

// ---- cookie-name-without-prefix ----
function prefix_cases($v, $name)
{
    // ruleid: jgates.php.cookie-name-without-prefix
    setcookie('sid', $v, ['secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
    // ruleid: jgates.php.cookie-name-without-prefix
    session_name('PHPSESSID');
    // ruleid: jgates.php.cookie-name-without-prefix
    $c = new Cookie('sid', $v, 0, '/', null, true, true, false, 'lax');
    // ok: jgates.php.cookie-name-without-prefix
    setcookie('__Host-sid', $v, ['secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
    // ok: jgates.php.cookie-name-without-prefix
    setcookie('__Secure-sid', $v, ['secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
    // ok: jgates.php.cookie-name-without-prefix
    session_name('__Host-session');
    // ok: jgates.php.cookie-name-without-prefix
    setcookie($name, $v, ['secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
}

// ---- cors-any-origin-with-credentials ----
function cors_any_any()
{
    // ruleid: jgates.php.cors-any-origin-with-credentials
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Credentials: true');
}

function cors_any_psr($response)
{
    // ruleid: jgates.php.cors-any-origin-with-credentials
    return $response->withHeader('Access-Control-Allow-Origin', '*')->withHeader('Access-Control-Allow-Credentials', 'true');
}

function cors_any_config()
{
    // ruleid: jgates.php.cors-any-origin-with-credentials
    return ['allowed_origins' => ['*'], 'supports_credentials' => true];
}

function cors_any_ok($response)
{
    // ok: jgates.php.cors-any-origin-with-credentials
    header('Access-Control-Allow-Origin: https://app.example.com');
    header('Access-Control-Allow-Credentials: true');
    // ok: jgates.php.cors-any-origin-with-credentials
    return $response->withHeader('Access-Control-Allow-Origin', 'https://app.example.com')->withHeader('Access-Control-Allow-Credentials', 'true');
}

function cors_any_public()
{
    // ok: jgates.php.cors-any-origin-with-credentials
    header('Access-Control-Allow-Origin: *');
}

function cors_any_config_ok()
{
    // ok: jgates.php.cors-any-origin-with-credentials
    return ['allowed_origins' => ['https://app.example.com'], 'supports_credentials' => true];
}

// ---- cors-origin-reflected ----
function cors_reflect_header()
{
    $origin = $_SERVER['HTTP_ORIGIN'];
    // ruleid: jgates.php.cors-origin-reflected
    header('Access-Control-Allow-Origin: ' . $origin);
}

function cors_reflect_interpolated()
{
    $origin = $_SERVER['HTTP_ORIGIN'];
    // ruleid: jgates.php.cors-origin-reflected
    header("Access-Control-Allow-Origin: $origin");
}

function cors_reflect_psr($request, $response)
{
    // ruleid: jgates.php.cors-origin-reflected
    return $response->withHeader('Access-Control-Allow-Origin', $request->getHeaderLine('Origin'));
}

function cors_reflect_ok_list($allowed)
{
    $origin = $_SERVER['HTTP_ORIGIN'];
    if (in_array($origin, $allowed, true)) {
        // ok: jgates.php.cors-origin-reflected
        header('Access-Control-Allow-Origin: ' . $origin);
    }
}

function cors_reflect_ok_map($allowedMap)
{
    $origin = $_SERVER['HTTP_ORIGIN'];
    if (isset($allowedMap[$origin])) {
        // ok: jgates.php.cors-origin-reflected
        header('Access-Control-Allow-Origin: ' . $origin);
    }
}

function cors_reflect_ok_fixed()
{
    // ok: jgates.php.cors-origin-reflected
    header('Access-Control-Allow-Origin: https://app.example.com');
}

// ---- cors-origin-reflected-allow-all ----
function cors_patterns_all()
{
    // ruleid: jgates.php.cors-origin-reflected-allow-all
    return ['allowed_origins_patterns' => ['#.*#']];
}

function cors_patterns_all_slash()
{
    // ruleid: jgates.php.cors-origin-reflected-allow-all
    return ['allowed_origins_patterns' => ['/^.*$/']];
}

function cors_patterns_ok()
{
    // ok: jgates.php.cors-origin-reflected-allow-all
    return ['allowed_origins_patterns' => ['#^https://[a-z]+\.example\.com$#']];
}

function cors_patterns_empty()
{
    // ok: jgates.php.cors-origin-reflected-allow-all
    return ['allowed_origins_patterns' => []];
}

// ---- csrf-protection-disabled ----
class VerifyCsrfToken extends BaseVerifier
{
    // ruleid: jgates.php.csrf-protection-disabled
    protected $except = ['*'];
}

class VerifyCsrfTokenNarrow extends VerifyCsrfToken
{
    // ok: jgates.php.csrf-protection-disabled
    protected $except = ['webhook/payments'];
}

function csrf_cases($controller, $middleware)
{
    // ruleid: jgates.php.csrf-protection-disabled
    Route::post('/profile', $handler)->withoutMiddleware(VerifyCsrfToken::class);
    // ruleid: jgates.php.csrf-protection-disabled
    $form = $controller->createForm(ProfileType::class, $data, ['csrf_protection' => false]);
    // ruleid: jgates.php.csrf-protection-disabled
    $middleware->validateCsrfTokens(except: ['*']);
    // ok: jgates.php.csrf-protection-disabled
    $middleware->validateCsrfTokens(except: ['stripe/*']);
    // ok: jgates.php.csrf-protection-disabled
    $form = $controller->createForm(ProfileType::class, $data, ['csrf_protection' => true]);
    // ok: jgates.php.csrf-protection-disabled
    Route::post('/profile', $handler)->middleware('web');
}

// ---- jsonp-enabled ----
function jsonp_framework($data, $cb)
{
    // ruleid: jgates.php.jsonp-enabled
    return response()->jsonp($cb, $data);
    // ruleid: jgates.php.jsonp-enabled
    return response()->json($data)->withCallback($cb);
}

function jsonp_symfony($data)
{
    $resp = new JsonResponse($data);
    // ruleid: jgates.php.jsonp-enabled
    $resp->setCallback('handle');
    // ruleid: jgates.php.jsonp-enabled
    return (new JsonResponse($data))->setCallback('handle');
}

function jsonp_ok($data)
{
    // ok: jgates.php.jsonp-enabled
    return response()->json($data);
    // ok: jgates.php.jsonp-enabled
    return new JsonResponse($data);
}

// ---- jsonp-enabled-callback ----
function jsonp_echo($data)
{
    $cb = $_GET['callback'];
    // ruleid: jgates.php.jsonp-enabled-callback
    echo $cb . '(' . json_encode($data) . ')';
}

function jsonp_write($request, $response, $data)
{
    // ruleid: jgates.php.jsonp-enabled-callback
    $response->getBody()->write($request->query('callback') . '(' . json_encode($data) . ')');
}

function jsonp_checked($data)
{
    $cb = $_GET['callback'];
    if (preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $cb)) {
        // ok: jgates.php.jsonp-enabled-callback
        echo $cb . '(' . json_encode($data) . ')';
    }
}

function jsonp_plain($data)
{
    // ok: jgates.php.jsonp-enabled-callback
    echo json_encode($data);
    // ok: jgates.php.jsonp-enabled-callback
    echo 'handle(' . json_encode($data) . ')';
}

// ---- sensitive-query-parameter ----
function query_cases($key, $pw, $client, $url)
{
    // ruleid: jgates.php.sensitive-query-parameter
    $u = "https://api.example.com/v1/items?api_key=" . $key;
    // ruleid: jgates.php.sensitive-query-parameter
    $body = file_get_contents("https://example.com/login?user=a&password=$pw");
    // ruleid: jgates.php.sensitive-query-parameter
    $q = http_build_query(['password' => $pw]);
    // ruleid: jgates.php.sensitive-query-parameter
    $r = $client->get($url, ['query' => ['api_key' => $key]]);
    // ok: jgates.php.sensitive-query-parameter
    $u2 = "https://api.example.com/v1/items?page=2";
    // ok: jgates.php.sensitive-query-parameter
    $q2 = http_build_query(['page' => 1]);
    // ok: jgates.php.sensitive-query-parameter
    $r2 = $client->get($url, ['headers' => ['X-Api-Key' => $key]]);
    // ok: jgates.php.sensitive-query-parameter
    $r3 = $client->post($url, ['form_params' => ['password' => $pw]]);
}
