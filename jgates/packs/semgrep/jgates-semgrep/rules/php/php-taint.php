<?php
function inclusion_cases($request) {
    // ruleid: jgates.php.file-inclusion
    include $_GET['page'];
    // ruleid: jgates.php.file-inclusion
    require $request->input('module');
    // ruleid: jgates.php.file-inclusion
    include_once $_REQUEST['page'];
    // ruleid: jgates.php.file-inclusion
    require_once $_COOKIE['module'];
    // ok: jgates.php.file-inclusion
    include __DIR__ . '/pages/home.php';
    // ok: jgates.php.file-inclusion
    require 'bootstrap.php';
}
function path_cases($request, $req) {
    // ruleid: jgates.php.path-traversal
    fopen($_GET['path'], 'r');
    // ruleid: jgates.php.path-traversal
    readfile($request->query->get('file'));
    // ruleid: jgates.php.path-traversal, jgates.php.ssrf
    file_get_contents($req->request->get('path'));
    // Uploaded names and HTTP headers are untrusted paths too.
    // ruleid: jgates.php.path-traversal
    readfile($_FILES['upload']['name']);
    // ruleid: jgates.php.path-traversal
    fopen($_SERVER['HTTP_X_FILE'], 'r');
    // ok: jgates.php.path-traversal
    fopen(__DIR__ . '/public/readme.txt', 'r');
    // ok: jgates.php.path-traversal
    readfile('/srv/public/readme.txt');
    // ok: jgates.php.path-traversal
    readfile($_SERVER['SCRIPT_FILENAME']);
}
function fetch_cases($request) {
    // ruleid: jgates.php.ssrf
    $handle = curl_init($_GET['url']);
    // ruleid: jgates.php.ssrf
    curl_setopt($handle, CURLOPT_URL, $request->input('callback'));
    // ruleid: jgates.php.ssrf
    curl_setopt_array($handle, [CURLOPT_URL => $_POST['url'], CURLOPT_RETURNTRANSFER => true]);
    // ruleid: jgates.php.ssrf, jgates.php.path-traversal
    file_get_contents($_REQUEST['url']);
    // ok: jgates.php.ssrf
    curl_init('https://api.example.com/status');
    // ok: jgates.php.ssrf
    curl_setopt($handle, CURLOPT_URL, 'https://api.example.com/status');
    // ok: jgates.php.ssrf, jgates.php.path-traversal
    file_get_contents(__DIR__ . '/readme.txt');
}
