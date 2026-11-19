<?php

class PortalController
{
    public function applySecurityHeaders($response)
    {
        $nonce = base64_encode(random_bytes(16));
        header("Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-$nonce'");
        header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
        return $response;
    }

    public function openFeed()
    {
        return new WebSocket\Client("wss://feed.example.com/stream");
    }

    public function chatHandler(\Ratchet\MessageComponentInterface $chat)
    {
        return new Ratchet\Http\OriginCheck(new Ratchet\WebSocket\WsServer($chat), ['portal.example.com']);
    }

    public function graphqlEndpoint($schema)
    {
        return new GraphQL\Server\StandardServer([
            'schema' => $schema,
            'validationRules' => array_merge(GraphQL\Validator\DocumentValidator::allRules(), [
                new GraphQL\Validator\Rules\DisableIntrospection(),
                new GraphQL\Validator\Rules\QueryDepth(10),
            ]),
        ]);
    }

    public function afterLogin($allowedTargets)
    {
        $next = $_GET['next'];
        if (in_array($next, $allowedTargets, true)) {
            header('Location: ' . $next);
        } else {
            header('Location: /dashboard');
        }
    }

    public function auditAddress()
    {
        return $_SERVER['REMOTE_ADDR'];
    }

    public function resetLink($token)
    {
        return rtrim(APP_URL, '/') . "/reset?token=" . $token;
    }
}
