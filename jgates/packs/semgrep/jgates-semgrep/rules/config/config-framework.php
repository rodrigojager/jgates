<?php

return [
    // ruleid: jgates.config.cookie-without-secure
    'secure' => false,
    // ok: jgates.config.cookie-without-secure
    'secure' => env('SESSION_SECURE_COOKIE', true),
    // ruleid: jgates.config.cookie-without-httponly
    'http_only' => false,
    // ok: jgates.config.cookie-without-httponly
    'http_only' => true,
    // ruleid: jgates.config.debug-mode-enabled
    'debug' => true,
    // ok: jgates.config.debug-mode-enabled
    'debug' => env('APP_DEBUG', false),
    // ruleid: jgates.config.csrf-protection-disabled
    'csrf_protection' => false,
    // ruleid: jgates.config.csrf-protection-disabled
    'enable_csrf' => false,
    // ok: jgates.config.csrf-protection-disabled
    'csrf_protection' => true,
];
