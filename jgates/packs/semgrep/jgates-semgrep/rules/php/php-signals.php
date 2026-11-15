<?php
// Fixture of php-signals.yaml: one match and one non-match per rule. Never run.
namespace Signals;

// ruleid: jgates.php.uses-graphql
use GraphQL\GraphQL;
// ruleid: jgates.php.uses-graphql
use Nuwave\Lighthouse\Schema\Types\GraphQLType;
// ruleid: jgates.php.uses-graphql
$s = new \GraphQL\Server\StandardServer($config);
// ok: jgates.php.uses-graphql
use App\Notes\GraphqlNotes;
// ok: jgates.php.uses-graphql
// use GraphQL\GraphQL;
// ok: jgates.php.uses-graphql
$q = 'use GraphQL\\GraphQL;';

// ruleid: jgates.php.uses-websocket
use Ratchet\Server\IoServer;
// ruleid: jgates.php.uses-websocket
use Swoole\WebSocket\Server;
// ruleid: jgates.php.uses-websocket
$ws = new \Ratchet\App('localhost', 8080);
// ok: jgates.php.uses-websocket
use App\Notes\WebsocketNotes;
// ok: jgates.php.uses-websocket
// use Ratchet\Server\IoServer;
// ok: jgates.php.uses-websocket
$q = 'new \\Ratchet\\App()';

// ruleid: jgates.php.uses-webrtc
use Agence104\LiveKit\AccessToken;
// ruleid: jgates.php.uses-webrtc
use OpenTok\OpenTok;
// ruleid: jgates.php.uses-webrtc
$g = new \Agence104\LiveKit\VideoGrant();
// ok: jgates.php.uses-webrtc
use App\Notes\RtcNotes;
// ok: jgates.php.uses-webrtc
// use OpenTok\OpenTok;
// ok: jgates.php.uses-webrtc
$q = 'use OpenTok\\OpenTok;';

// ruleid: jgates.php.uses-oauth-client
use League\OAuth2\Client\Provider\GenericProvider;
// ruleid: jgates.php.uses-oauth-client
use Laravel\Socialite\Facades\Socialite;
// ruleid: jgates.php.uses-oauth-client
$c = new \Google_Client();
// ok: jgates.php.uses-oauth-client
use App\Notes\OauthNotes;
// ok: jgates.php.uses-oauth-client
// use League\OAuth2\Client\Provider\GenericProvider;
// ok: jgates.php.uses-oauth-client
$q = 'use Laravel\\Socialite\\Socialite;';

// ruleid: jgates.php.uses-oauth-authorization-server
use League\OAuth2\Server\AuthorizationServer;
// ruleid: jgates.php.uses-oauth-authorization-server
use Laravel\Passport\Passport;
// ruleid: jgates.php.uses-oauth-authorization-server
$s = new \OAuth2\Server($storage);
// ok: jgates.php.uses-oauth-authorization-server
use App\Notes\AuthServerNotes;
// ok: jgates.php.uses-oauth-authorization-server
// use League\OAuth2\Server\AuthorizationServer;
// ok: jgates.php.uses-oauth-authorization-server
$q = 'use Laravel\\Passport\\Passport;';

// ruleid: jgates.php.uses-jwt
use Firebase\JWT\JWT;
// ruleid: jgates.php.uses-jwt
use Lcobucci\JWT\Configuration;
// ruleid: jgates.php.uses-jwt
$t = \Firebase\JWT\JWT::encode($payload, $key, 'HS256');
// ok: jgates.php.uses-jwt
use App\Notes\TokenNotes;
// ok: jgates.php.uses-jwt
// use Firebase\JWT\JWT;
// ok: jgates.php.uses-jwt
$q = 'use Firebase\\JWT\\JWT;';

// ruleid: jgates.php.uses-saml
use OneLogin\Saml2\Auth;
// ruleid: jgates.php.uses-saml
use SimpleSAML\Auth\Simple;
// ruleid: jgates.php.uses-saml
$a = new \OneLogin_Saml2_Auth($settings);
// ok: jgates.php.uses-saml
use App\Notes\AssertionNotes;
// ok: jgates.php.uses-saml
// use OneLogin\Saml2\Auth;
// ok: jgates.php.uses-saml
$q = 'use OneLogin\\Saml2\\Auth;';

// ruleid: jgates.php.uses-totp
use OTPHP\TOTP;
// ruleid: jgates.php.uses-totp
use PragmaRX\Google2FA\Google2FA;
// ruleid: jgates.php.uses-totp
$g = new \Sonata\GoogleAuthenticator\GoogleAuthenticator();
// ok: jgates.php.uses-totp
use App\Notes\SecondFactorNotes;
// ok: jgates.php.uses-totp
// use OTPHP\TOTP;
// ok: jgates.php.uses-totp
$q = 'use OTPHP\\TOTP;';

// ruleid: jgates.php.uses-ldap
use Symfony\Component\Ldap\Ldap;
// ruleid: jgates.php.uses-ldap
use LdapRecord\Models\ActiveDirectory\User;
// ruleid: jgates.php.uses-ldap
$l = ldap_connect('ldap://directory.example');
// ruleid: jgates.php.uses-ldap
ldap_bind($l, $dn, $pw);
// ok: jgates.php.uses-ldap
use App\Notes\DirectoryNotes;
// ok: jgates.php.uses-ldap
// $l = ldap_connect('ldap://directory.example');
// ok: jgates.php.uses-ldap
$q = 'ldap_connect("x")';

// ruleid: jgates.php.uses-xml
use DOMDocument;
// ruleid: jgates.php.uses-xml
$d = new DOMDocument();
// ruleid: jgates.php.uses-xml
$x = simplexml_load_string($body);
// ruleid: jgates.php.uses-xml
$r = new \XMLReader();
// ok: jgates.php.uses-xml
use App\Notes\MarkupNotes;
// ok: jgates.php.uses-xml
// $d = new DOMDocument();
// ok: jgates.php.uses-xml
$q = 'simplexml_load_string($body)';

// ruleid: jgates.php.uses-memcache
use Memcached;
// ruleid: jgates.php.uses-memcache
$m = new \Memcached();
// ruleid: jgates.php.uses-memcache
$c = memcache_connect('cache.example', 11211);
// ok: jgates.php.uses-memcache
use App\Notes\CacheNotes;
// ok: jgates.php.uses-memcache
// $m = new Memcached();
// ok: jgates.php.uses-memcache
$q = 'new Memcached()';

// ruleid: jgates.php.uses-mail
use PHPMailer\PHPMailer\PHPMailer;
// ruleid: jgates.php.uses-mail
use Symfony\Component\Mailer\MailerInterface;
// ruleid: jgates.php.uses-mail
mail($to, $subject, $body);
// ruleid: jgates.php.uses-mail
$m = new \Swift_Mailer($transport);
// ok: jgates.php.uses-mail
use App\Notes\LetterNotes;
// ok: jgates.php.uses-mail
// mail($to, $subject, $body);
// ok: jgates.php.uses-mail
$q = 'mail($to)';

// ruleid: jgates.php.uses-templates
use Twig\Environment;
// ruleid: jgates.php.uses-templates
use Illuminate\Support\Facades\View;
// ruleid: jgates.php.uses-templates
$t = new \Smarty();
// ruleid: jgates.php.uses-templates
return view('home', $data);
// ok: jgates.php.uses-templates
use App\Notes\PageNotes;
// ok: jgates.php.uses-templates
// use Twig\Environment;
// ok: jgates.php.uses-templates
$q = 'use Twig\\Environment;';

// ruleid: jgates.php.uses-file-upload
move_uploaded_file($_FILES['doc']['tmp_name'], $target);
// ruleid: jgates.php.uses-file-upload
$f = $request->file('avatar');
// ruleid: jgates.php.uses-file-upload
use Symfony\Component\HttpFoundation\File\UploadedFile;
// ok: jgates.php.uses-file-upload
use App\Notes\AttachmentNotes;
// ok: jgates.php.uses-file-upload
// move_uploaded_file($tmp, $target);
// ok: jgates.php.uses-file-upload
$q = 'move_uploaded_file($tmp, $target)';

// ruleid: jgates.php.uses-archives
use ZipArchive;
// ruleid: jgates.php.uses-archives
$z = new \ZipArchive();
// ruleid: jgates.php.uses-archives
$p = new PharData($path);
// ruleid: jgates.php.uses-archives
$h = gzopen($path, 'rb');
// ok: jgates.php.uses-archives
use App\Notes\BundleNotes;
// ok: jgates.php.uses-archives
// $z = new ZipArchive();
// ok: jgates.php.uses-archives
$q = 'new ZipArchive()';
