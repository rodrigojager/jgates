<?php

return [
    'security' => [
        'firewalls' => [
            'main' => [
                'form_login' => ['login_path' => 'login', 'enable_csrf' => false],
            ],
        ],
    ],
];
