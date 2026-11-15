<?php

use Symfony\Component\HttpFoundation\RedirectResponse;

// ---- security-headers-disabled ----
function headers_cases($response, $symfonyResponse)
{
    // ruleid: jgates.php.security-headers-disabled
    header_remove('X-Frame-Options');
    // ruleid: jgates.php.security-headers-disabled
    header_remove('Strict-Transport-Security');
    // ruleid: jgates.php.security-headers-disabled
    $r = $response->withoutHeader('X-Content-Type-Options');
    // ruleid: jgates.php.security-headers-disabled
    $symfonyResponse->headers->remove('Content-Security-Policy');
    // ruleid: jgates.php.security-headers-disabled
    header('Strict-Transport-Security: max-age=300');
    // ruleid: jgates.php.security-headers-disabled
    header('Strict-Transport-Security: max-age=86400; includeSubDomains');
    // ok: jgates.php.security-headers-disabled
    header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
    // ok: jgates.php.security-headers-disabled
    header('Strict-Transport-Security: max-age=63072000');
    // ok: jgates.php.security-headers-disabled
    header('X-Frame-Options: DENY');
    // ok: jgates.php.security-headers-disabled
    header_remove('X-Powered-By');
    // ok: jgates.php.security-headers-disabled
    $r2 = $response->withoutHeader('Server');
}

// ---- csp-unsafe-directive ----
function csp_cases($response, $symfonyResponse, $policy)
{
    // ruleid: jgates.php.csp-unsafe-directive
    header("Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'");
    // ruleid: jgates.php.csp-unsafe-directive
    header("Content-Security-Policy: script-src 'self' 'unsafe-eval'");
    // ruleid: jgates.php.csp-unsafe-directive
    header("Content-Security-Policy: script-src *");
    // ruleid: jgates.php.csp-unsafe-directive
    $r = $response->withHeader('Content-Security-Policy', "default-src https: 'self'");
    // ruleid: jgates.php.csp-unsafe-directive
    $symfonyResponse->headers->set('Content-Security-Policy', "script-src 'self' 'unsafe-inline'");
    // ruleid: jgates.php.csp-unsafe-directive
    $policy->addDirective(Directive::SCRIPT, Keyword::UNSAFE_INLINE);
    // ok: jgates.php.csp-unsafe-directive
    header("Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-abc123'");
    // ok: jgates.php.csp-unsafe-directive
    $r2 = $response->withHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'");
    // ok: jgates.php.csp-unsafe-directive
    $policy->addDirective(Directive::SCRIPT, Keyword::SELF);
    // ok: jgates.php.csp-unsafe-directive
    $policy->addDirective(Directive::STYLE, Keyword::UNSAFE_INLINE);
}

// ---- websocket-without-tls ----
function websocket_cases($connector, $loop)
{
    // ruleid: jgates.php.websocket-without-tls
    $c = new WebSocket\Client("ws://feed.example.com/stream");
    // ruleid: jgates.php.websocket-without-tls
    $c2 = new Client('ws://10.0.0.5:8080/chat');
    // ruleid: jgates.php.websocket-without-tls
    $p = Ratchet\Client\connect('ws://feed.example.com/socket');
    // ruleid: jgates.php.websocket-without-tls
    $p2 = $connector->connect('ws://feed.example.com/socket');
    // ok: jgates.php.websocket-without-tls
    $s = new WebSocket\Client("wss://feed.example.com/stream");
    // ok: jgates.php.websocket-without-tls
    $s2 = new Client('ws://localhost:8080/chat');
    // ok: jgates.php.websocket-without-tls
    $s3 = Ratchet\Client\connect('ws://127.0.0.1:9000/socket');
    // ok: jgates.php.websocket-without-tls
    $s4 = $connector->connect('wss://feed.example.com/socket');
}

// ---- open-redirect ----
function redirect_header()
{
    $next = $_GET['next'];
    // ruleid: jgates.php.open-redirect
    header('Location: ' . $next);
}

function redirect_laravel(Request $request)
{
    // ruleid: jgates.php.open-redirect
    return redirect($request->input('next'));
}

function redirect_symfony($request)
{
    $target = $request->query->get('url');
    // ruleid: jgates.php.open-redirect
    return new RedirectResponse($target);
}

function redirect_psr($request, $response)
{
    $to = $_POST['return_to'];
    // ruleid: jgates.php.open-redirect
    return $response->withHeader('Location', $to);
}

function redirect_ok_fixed()
{
    // ok: jgates.php.open-redirect
    header('Location: /dashboard');
    // ok: jgates.php.open-redirect
    return redirect('/dashboard');
}

function redirect_ok_list($allowed)
{
    $next = $_GET['next'];
    if (in_array($next, $allowed, true)) {
        // ok: jgates.php.open-redirect
        header('Location: ' . $next);
    }
}

function redirect_ok_map($routes)
{
    $key = $_GET['page'];
    if (isset($routes[$key])) {
        // ok: jgates.php.open-redirect
        return redirect($key);
    }
}

function redirect_ok_route($request)
{
    // ok: jgates.php.open-redirect
    return redirect()->route('home', ['tab' => $request->input('tab')]);
}

// ---- client-ip-from-forwarded-header ----
function client_ip_cases($request)
{
    // ruleid: jgates.php.client-ip-from-forwarded-header
    $ip = $_SERVER['HTTP_X_FORWARDED_FOR'];
    // ruleid: jgates.php.client-ip-from-forwarded-header
    $ip2 = $_SERVER["HTTP_CLIENT_IP"];
    // ruleid: jgates.php.client-ip-from-forwarded-header
    $ip3 = $request->header('X-Forwarded-For');
    // ruleid: jgates.php.client-ip-from-forwarded-header
    $ip4 = $request->headers->get('X-Real-IP');
    // ruleid: jgates.php.client-ip-from-forwarded-header
    $ip5 = $request->getHeaderLine('X-Forwarded-For');
    // ok: jgates.php.client-ip-from-forwarded-header
    $a = $_SERVER['REMOTE_ADDR'];
    // ok: jgates.php.client-ip-from-forwarded-header
    $b = $request->ip();
    // ok: jgates.php.client-ip-from-forwarded-header
    $c = $request->getClientIp();
    // ok: jgates.php.client-ip-from-forwarded-header
    $d = $request->header('User-Agent');
}

// ---- host-header-in-url ----
function host_cases($request)
{
    $host = $_SERVER['HTTP_HOST'];
    // ruleid: jgates.php.host-header-in-url
    $link = "https://" . $host . "/reset?token=abc";
    // ruleid: jgates.php.host-header-in-url
    $link2 = 'http://' . $request->getHost() . '/confirm';
    // ruleid: jgates.php.host-header-in-url
    $link3 = sprintf('https://%s/verify', $request->header('Host'));
    // ok: jgates.php.host-header-in-url
    $safe = rtrim(config('app.url'), '/') . '/reset?token=abc';
    // ok: jgates.php.host-header-in-url
    $safe2 = "https://" . $configuredHost . "/confirm";
    // ok: jgates.php.host-header-in-url
    $safe3 = sprintf('https://%s/verify', APP_HOST);
}
