<?php

class PortalController
{
    public function applySecurityHeaders($response)
    {
        header("Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'");
        header('Strict-Transport-Security: max-age=300');
        return $response;
    }

    public function openFeed()
    {
        return new WebSocket\Client("ws://feed.example.com/stream");
    }

    public function afterLogin()
    {
        $next = $_GET['next'];
        header('Location: ' . $next);
    }

    public function auditAddress()
    {
        return $_SERVER['HTTP_X_FORWARDED_FOR'];
    }

    public function resetLink($token)
    {
        $host = $_SERVER['HTTP_HOST'];
        return "https://" . $host . "/reset?token=" . $token;
    }
}
