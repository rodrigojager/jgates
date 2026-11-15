<?php

use Symfony\Component\HttpFoundation\JsonResponse;

class SessionController
{
    public function remember(string $token): void
    {
        setcookie('__Host-remember', $token, ['httponly' => true, 'samesite' => 'Lax']);
    }

    public function preferences(string $theme): void
    {
        setcookie('__Host-theme', $theme, ['secure' => true, 'samesite' => 'Lax']);
    }

    public function language(string $lang): void
    {
        setcookie('__Host-lang', $lang, ['secure' => true, 'httponly' => true]);
    }

    public function login(string $sessionId): void
    {
        setcookie('sid', $sessionId, ['secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
    }

    public function openApi(): void
    {
        header('Access-Control-Allow-Origin: *');
        header('Access-Control-Allow-Credentials: true');
    }

    public function echoOrigin(): void
    {
        $origin = $_SERVER['HTTP_ORIGIN'];
        header('Access-Control-Allow-Origin: ' . $origin);
    }

    public function anyHost(): array
    {
        return ['allowed_origins_patterns' => ['#.*#']];
    }

    public function feed(array $data): JsonResponse
    {
        $resp = new JsonResponse($data);
        $resp->setCallback('handle');
        return $resp;
    }

    public function wrapped($response, array $data)
    {
        $callback = $_GET['callback'];
        $response->getBody()->write($callback . '(' . json_encode($data) . ')');
        return $response;
    }

    public function fetchPrices(string $key): string
    {
        return file_get_contents("https://api.example.com/v1/prices?api_key=" . $key);
    }
}

class VerifyCsrfToken extends BaseVerifier
{
    protected $except = ['*'];
}
