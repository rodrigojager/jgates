<?php

return [
    'driver' => env('SESSION_DRIVER', 'file'),
    'lifetime' => 120,
    'secure' => false,
    'http_only' => false,
];
