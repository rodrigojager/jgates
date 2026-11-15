<?php

return [
    'driver' => env('SESSION_DRIVER', 'file'),
    'lifetime' => 120,
    'secure' => true,
    'http_only' => true,
];
