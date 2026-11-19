<?php
namespace App\Http;

use GraphQL\GraphQL;
use Ratchet\Server\IoServer;
use OpenTok\OpenTok;
use League\OAuth2\Client\Provider\GenericProvider;
use League\OAuth2\Server\AuthorizationServer;
use Firebase\JWT\JWT;
use OneLogin\Saml2\Auth;
use OTPHP\TOTP;
use PHPMailer\PHPMailer\PHPMailer;
use Twig\Environment;
use ZipArchive;

// A controller that touches every technology of the signal list that PHP can show.
function serve($request, $settings, $loader)
{
    $schema = GraphQL::class;
    $ws = new IoServer();
    $call = new OpenTok('key', 'secret');
    $client = new GenericProvider([]);
    $server = new AuthorizationServer();
    $token = JWT::decode($request->bearer, $settings['key']);
    // This twin proves technology signals, not an unchecked token audience.
    if ($token->aud !== $settings['audience']) {
        throw new \RuntimeException('Audience mismatch');
    }
    $auth = new Auth($settings);
    $otp = TOTP::generate();
    $link = ldap_connect('ldap://directory.example');
    $doc = new \DOMDocument();
    $cache = new \Memcached();
    $mailer = new PHPMailer();
    $twig = new Environment($loader);
    $avatar = $request->file('avatar');
    move_uploaded_file($_FILES['doc']['tmp_name'], '/srv/uploads/doc.bin');
    $zip = new ZipArchive();
}
