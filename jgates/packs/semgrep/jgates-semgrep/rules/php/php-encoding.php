<?php
function regex_cases($request) {
    // ruleid: jgates.php.regex-from-request
    preg_match($_GET['pattern'], 'subject');
    // ruleid: jgates.php.regex-from-request
    preg_match('/' . $request->query->get('q') . '/i', 'subject');
    $term = $_POST['term'];
    // ruleid: jgates.php.regex-from-request
    preg_replace("/$term/", 'x', 'subject');
    // ok: jgates.php.regex-from-request
    preg_match('/' . preg_quote($_GET['q'], '/') . '/i', 'subject');
    // ok: jgates.php.regex-from-request
    preg_match('/^[a-z]+$/', $_GET['q']);
    // ok: jgates.php.regex-from-request
    preg_split('/' . preg_quote($request->input('sep'), '/') . '/', 'a,b');
}

function redos_cases($s) {
    // ruleid: jgates.php.redos-nested-quantifier
    preg_match('/^(a+)+$/', $s);
    // ruleid: jgates.php.redos-nested-quantifier
    preg_match('/^(\w*)*x/', $s);
    // ruleid: jgates.php.redos-nested-quantifier
    preg_replace('/(?:\d+)*;/', '', $s);
    // ok: jgates.php.redos-nested-quantifier
    preg_match('/^a+$/', $s);
    // ok: jgates.php.redos-nested-quantifier
    preg_match('/^(ab)+$/', $s);
    // ok: jgates.php.redos-nested-quantifier
    preg_match('/^(a+)b$/', $s);
}

function format_cases($request) {
    // ruleid: jgates.php.format-string-from-request
    printf($_GET['fmt'], 1);
    // ruleid: jgates.php.format-string-from-request
    $line = sprintf($request->input('template'), 'x');
    $fmt = $_POST['fmt'];
    // ruleid: jgates.php.format-string-from-request
    vsprintf($fmt, [1, 2]);
    // ok: jgates.php.format-string-from-request
    printf('%s', $_GET['fmt']);
    // ok: jgates.php.format-string-from-request
    $line = sprintf('Hello %s', $request->input('name'));
    // ok: jgates.php.format-string-from-request
    printf(str_replace('%', '%%', $_GET['fmt']));
}
