<?php
function deserialize_cases($request) {
    // ruleid: jgates.php.unsafe-deserialization
    $session = unserialize($_COOKIE['session']);
    // ruleid: jgates.php.unsafe-deserialization
    $payload = unserialize($request->input('payload'));
    // allowed_classes does not turn untrusted native serialization into JSON.
    // ruleid: jgates.php.unsafe-deserialization
    $limited = unserialize($_POST['payload'], ['allowed_classes' => false]);
    // ok: jgates.php.unsafe-deserialization
    $data = json_decode($_POST['payload'], true, 512, JSON_THROW_ON_ERROR);
    // ok: jgates.php.unsafe-deserialization
    $fixed = unserialize('a:1:{s:4:"name";s:5:"guest";}');
}
