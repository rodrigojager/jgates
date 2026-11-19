<?php
// Deliberately vulnerable source-only project; never execute this fixture.
function handle_request($pdo, $connection) {
    $name = $_GET['name'];
    mysqli_query($connection, "SELECT * FROM users WHERE name = '" . $name . "'");
    $pdo->query("SELECT * FROM users WHERE name = '$name'");
    exec('ping ' . $_POST['host']);
    eval($_POST['code']);
    preg_replace('/name/e', 'strtoupper("name")', 'name');
    include $_GET['page'];
    readfile($_GET['path']);
    $handle = curl_init($_GET['url']);
    echo $_GET['name'];
    $passwordDigest = md5($_POST['password']);
    $encrypted = openssl_encrypt('private', 'aes-128-ecb', 'fixture-key-only');
    curl_setopt($handle, CURLOPT_SSL_VERIFYPEER, false);
    $payload = unserialize($_COOKIE['session']);
}
