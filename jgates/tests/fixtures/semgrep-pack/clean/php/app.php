<?php
// Safe twin of the source-only request handler; no fixture should be executed.
function handle_request($pdo, $connection) {
    $name = $_GET['name'];
    $statement = $pdo->prepare('SELECT * FROM users WHERE name = ?');
    $statement->execute([$name]);
    $output = [];
    exec('uptime', $output);
    $expressionResult = 1 + 1;
    $replaced = preg_replace_callback('/name/', function ($match) { return strtoupper($match[0]); }, 'name');
    // Request identifiers choose fixed, application-owned resources.
    $page = __DIR__ . '/pages/home.php';
    if ($_GET['page'] === 'help') {
        $page = __DIR__ . '/pages/help.php';
    }
    include $page;
    readfile(__DIR__ . '/public/readme.txt');
    $handle = curl_init('https://api.example.com/status');
    echo htmlspecialchars($name, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    $passwordDigest = password_hash($_POST['password'], PASSWORD_DEFAULT);
    $key = random_bytes(16);
    $nonce = random_bytes(12);
    $encrypted = openssl_encrypt('private', 'aes-128-gcm', $key, 0, $nonce, $tag);
    curl_setopt($handle, CURLOPT_SSL_VERIFYPEER, true);
    curl_setopt($handle, CURLOPT_SSL_VERIFYHOST, 2);
    $payload = json_decode($_COOKIE['session'], true, 512, JSON_THROW_ON_ERROR);
}
