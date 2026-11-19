<?php

use Symfony\Component\HttpFoundation\JsonResponse;

class SessionController
{
    private const ALLOWED_ORIGINS = ['https://app.example.com', 'https://admin.example.com'];

    public function remember(string $token): void
    {
        setcookie('__Host-remember', $token, ['secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
        setcookie('__Host-remember-explicit', $token, ['secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
    }

    public function preferences(string $theme): void
    {
        setcookie('__Host-theme', $theme, ['secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
        setcookie('__Host-theme-explicit', $theme, ['secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
    }

    public function language(string $lang): void
    {
        setcookie('__Host-lang', $lang, ['secure' => true, 'httponly' => true, 'samesite' => 'Strict']);
    }

    public function login(string $sessionId): void
    {
        setcookie('__Host-sid', $sessionId, ['secure' => true, 'httponly' => true, 'samesite' => 'Lax']);
    }

    public function openApi(): void
    {
        header('Access-Control-Allow-Origin: https://app.example.com');
        header('Access-Control-Allow-Credentials: true');
    }

    public function echoOrigin(): void
    {
        $origin = $_SERVER['HTTP_ORIGIN'];
        if (in_array($origin, self::ALLOWED_ORIGINS, true)) {
            header('Access-Control-Allow-Origin: ' . $origin);
        }
    }

    public function anyHost(): array
    {
        return ['allowed_origins_patterns' => ['#^https://[a-z]+\.example\.com$#']];
    }

    public function feed(array $data): JsonResponse
    {
        return new JsonResponse($data);
    }

    public function wrapped($response, array $data)
    {
        $response->getBody()->write(json_encode($data));
        return $response;
    }

    public function fetchPrices(string $key): string
    {
        $context = stream_context_create(['http' => ['header' => 'X-Api-Key: ' . $key]]);
        return file_get_contents('https://api.example.com/v1/prices', false, $context);
    }
}

class VerifyCsrfToken extends BaseVerifier
{
    protected $except = ['webhook/payments'];
}
