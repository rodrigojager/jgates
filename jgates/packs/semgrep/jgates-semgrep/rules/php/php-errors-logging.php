<?php

use GuzzleHttp\Client;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Symfony\Component\HttpFoundation\Response;

// ---- sensitive-data-logged ----
function logging_cases($logger, $user, $request, string $password, string $apiToken, string $orderId)
{
    // ruleid: jgates.php.sensitive-data-logged
    error_log("login failed for password " . $password);
    // ruleid: jgates.php.sensitive-data-logged
    $logger->info('token issued', ['token' => $apiToken]);
    // ruleid: jgates.php.sensitive-data-logged
    Log::debug('credentials', ['pwd' => $user->password]);
    // ruleid: jgates.php.sensitive-data-logged
    $logger->warning('auth header ' . $request->header('Authorization'));
    // ruleid: jgates.php.sensitive-data-logged
    logger($_POST['password']);
    // ok: jgates.php.sensitive-data-logged
    $logger->info('token issued', ['order_id' => $orderId]);
    // ok: jgates.php.sensitive-data-logged
    Log::info('login failed', ['user_id' => $user->id]);
    // ok: jgates.php.sensitive-data-logged
    $logger->info('credentials rotated', ['password' => '[redacted]']);
    // ok: jgates.php.sensitive-data-logged
    error_log('password check failed for user ' . $orderId);
    // ok: jgates.php.sensitive-data-logged
    $hash = hash('sha256', $password);
}

// ---- stack-trace-in-response ----
function trace_cases(\Throwable $e, $response)
{
    // ruleid: jgates.php.stack-trace-in-response
    echo $e->getTraceAsString();
    // ruleid: jgates.php.stack-trace-in-response
    echo json_encode(['error' => 'failed', 'trace' => $e->getTrace()]);
    // ruleid: jgates.php.stack-trace-in-response
    $r = new Response('Error: ' . $e->getTraceAsString(), 500);
    // ruleid: jgates.php.stack-trace-in-response
    $response->getBody()->write($e->getTraceAsString());
    // ruleid: jgates.php.stack-trace-in-response
    die(print_r(debug_backtrace(), true));
    // ok: jgates.php.stack-trace-in-response
    error_log($e->getTraceAsString());
    // ok: jgates.php.stack-trace-in-response
    echo 'Something went wrong';
    // ok: jgates.php.stack-trace-in-response
    $r2 = new Response('Internal error', 500);
    // ok: jgates.php.stack-trace-in-response
    $response->getBody()->write(json_encode(['error' => 'Internal error']));
}

// ---- error-detail-in-response ----
function detail_cases(\Exception $e, $ex, $response)
{
    // ruleid: jgates.php.error-detail-in-response
    echo 'Failed: ' . $e->getMessage();
    // ruleid: jgates.php.error-detail-in-response
    $r = new Response($ex->getMessage(), 500);
    // ruleid: jgates.php.error-detail-in-response
    $response->getBody()->write(json_encode(['error' => $e->getMessage()]));
    // ok: jgates.php.error-detail-in-response
    error_log($e->getMessage());
    // ok: jgates.php.error-detail-in-response
    echo 'The request could not be completed';
    // ok: jgates.php.error-detail-in-response
    $r2 = new Response('The request could not be completed', 500);
}

// ---- swallowed-exception ----
function swallow_cases($logger, $pdo)
{
    // ruleid: jgates.php.swallowed-exception
    try {
        $pdo->exec('DELETE FROM sessions');
    } catch (\Exception $e) {
    }
    // ruleid: jgates.php.swallowed-exception
    try {
        $pdo->exec('DELETE FROM sessions');
    } catch (\PDOException $pe) {
    }
    // ruleid: jgates.php.swallowed-exception
    try {
        $pdo->exec('DELETE FROM sessions');
    } catch (\Throwable $e) {
        return null;
    }
    // ok: jgates.php.swallowed-exception
    try {
        $pdo->exec('DELETE FROM sessions');
    } catch (\Exception $e) {
        $logger->error('cleanup failed', ['exception' => $e]);
    }
    // ok: jgates.php.swallowed-exception
    try {
        $pdo->exec('DELETE FROM sessions');
    } catch (\Exception $e) {
        throw new \RuntimeException('cleanup failed', 0, $e);
    }
}

// ---- http-client-without-timeout ----
function client_cases(string $url)
{
    // ruleid: jgates.php.http-client-without-timeout
    $client = new Client();
    // ruleid: jgates.php.http-client-without-timeout
    $client2 = new \GuzzleHttp\Client(['base_uri' => 'https://api.example.com']);
    // ok: jgates.php.http-client-without-timeout
    $client3 = new Client(['base_uri' => 'https://api.example.com', 'timeout' => 5]);
}

function curl_without_timeout(string $url)
{
    // ruleid: jgates.php.http-client-without-timeout
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    return curl_exec($ch);
}

function curl_with_timeout(string $url)
{
    // ok: jgates.php.http-client-without-timeout
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    return curl_exec($ch);
}

function curl_with_array_timeout(string $url)
{
    // ok: jgates.php.http-client-without-timeout
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT_MS => 5000]);
    return curl_exec($ch);
}

// ---- outbound-request-follows-redirects ----
function redirect_cases($httpClient, $request)
{
    // ruleid: jgates.php.outbound-request-follows-redirects
    $httpClient->get($_GET['url']);
    // ruleid: jgates.php.outbound-request-follows-redirects
    $httpClient->request('GET', $request->input('target'));
    // ruleid: jgates.php.outbound-request-follows-redirects
    Http::get($_POST['callback']);
    // ok: jgates.php.outbound-request-follows-redirects
    $httpClient->get($_GET['url'], ['allow_redirects' => false]);
    // ok: jgates.php.outbound-request-follows-redirects
    $httpClient->request('GET', $request->input('target'), ['allow_redirects' => false]);
    // ok: jgates.php.outbound-request-follows-redirects
    Http::withoutRedirecting()->get($_POST['callback']);
    // ok: jgates.php.outbound-request-follows-redirects
    $httpClient->get('https://api.example.com/status');
}
