<?php
function html_cases($request) {
    // ruleid: jgates.php.request-xss
    echo $_GET['name'];
    // ruleid: jgates.php.request-xss
    print $request->query->get('message');
    $label = $_POST['label'];
    // ruleid: jgates.php.request-xss
    echo '<b>' . $label . '</b>';
    // ok: jgates.php.request-xss
    echo htmlspecialchars($_GET['name'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    // ok: jgates.php.request-xss
    print htmlentities($request->input('message'), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    // ok: jgates.php.request-xss
    echo '<b>Welcome</b>';
}
