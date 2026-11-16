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

function csv_cases($stream, $request) {
    // ruleid: jgates.php.csv-formula-injection
    fputcsv($stream, [$_GET['name']]);
    $name = $request->input('name');
    // ruleid: jgates.php.csv-formula-injection
    fputcsv($stream, ['record', $name]);
    // ok: jgates.php.csv-formula-injection
    fputcsv($stream, ["'" . $_GET['name']]);
    // ok: jgates.php.csv-formula-injection
    fputcsv($stream, ['record', "'" . $name]);
}

function cache_cases($request) {
    $cache = new Memcache();
    // ruleid: jgates.php.memcache-key-from-request
    $cache->get($_GET['key']);
    $pool = new Memcached();
    // ruleid: jgates.php.memcache-key-from-request
    $pool->set($request->input('key'), 'entry');
    // ok: jgates.php.memcache-key-from-request
    $cache->get(hash('sha256', $_GET['key']));
    // ok: jgates.php.memcache-key-from-request
    $pool->set(rawurlencode($request->input('key')), 'entry');
}

function decode_cases($value) {
    // ruleid: jgates.php.double-decoding
    $a = urldecode(urldecode($value));
    // ruleid: jgates.php.double-decoding
    $b = base64_decode(base64_decode($value, true), true);
    // ruleid: jgates.php.double-decoding
    $c = html_entity_decode(html_entity_decode($value));
    // ruleid: jgates.php.double-decoding
    $d = rawurldecode(rawurldecode($value));
    $first = urldecode($value);
    // ruleid: jgates.php.double-decoding
    $second = urldecode($first);
    // ok: jgates.php.double-decoding
    $a = urldecode($value);
    // ok: jgates.php.double-decoding
    $b = base64_decode($value, true);
}

function markdown_explicit_cases() {
    // ruleid: jgates.php.markdown-raw-html-enabled
    $converter = new League\CommonMark\CommonMarkConverter(['html_input' => 'allow']);
    // ruleid: jgates.php.markdown-raw-html-enabled
    $environment = new League\CommonMark\Environment\Environment(['html_input' => 'allow']);
    // ok: jgates.php.markdown-raw-html-enabled
    $escaped = new League\CommonMark\CommonMarkConverter(['html_input' => 'escape']);
    // ok: jgates.php.markdown-raw-html-enabled
    $stripped = new League\CommonMark\Environment\Environment(['html_input' => 'strip']);
}

function markdown_default_one($source) {
    $md = new Parsedown();
    // ruleid: jgates.php.markdown-raw-html-enabled-by-default
    return $md->text($source);
}
function markdown_default_two($source) {
    $renderer = new Parsedown();
    // ruleid: jgates.php.markdown-raw-html-enabled-by-default
    $html = $renderer->text($source);
    return $html;
}
function markdown_safe($source) {
    $md = new Parsedown();
    $md->setSafeMode(true);
    // ok: jgates.php.markdown-raw-html-enabled-by-default
    return $md->text($source);
}
function markdown_explicit_unsafe($source) {
    $md = new Parsedown();
    // ruleid: jgates.php.markdown-raw-html-enabled
    $md->setSafeMode(false);
    // ok: jgates.php.markdown-raw-html-enabled-by-default
    return $md->text($source);
}
function markdown_sanitized($source) {
    $md = new Parsedown();
    // ok: jgates.php.markdown-raw-html-enabled-by-default
    $html = $md->text($source);
    $purifier = new HTMLPurifier();
    return $purifier->purify($html);
}
function markdown_sanitized_inline($source) {
    $md = new Parsedown();
    $purifier = new HTMLPurifier();
    // ok: jgates.php.markdown-raw-html-enabled-by-default
    return $purifier->purify($md->text($source));
}

function url_cases($request) {
    // ruleid: jgates.php.url-parameter-unencoded
    $url = 'https://example.org/search?q=' . $_GET['q'];
    // ruleid: jgates.php.url-parameter-unencoded
    $path = 'https://example.org/users/' . $request->input('user');
    // ok: jgates.php.url-parameter-unencoded
    $url = 'https://example.org/search?q=' . urlencode($_GET['q']);
    // ok: jgates.php.url-parameter-unencoded
    $path = 'https://example.org/users/' . rawurlencode($request->input('user'));
    // ok: jgates.php.url-parameter-unencoded
    $query = 'https://example.org/search?' . http_build_query(['q' => $_GET['q']]);
}

function json_cases($request) {
    // ruleid: jgates.php.json-built-by-concatenation
    $json = '{"name":"' . $_GET['name'] . '"}';
    // ruleid: jgates.php.json-built-by-concatenation
    $array = '["' . $request->input('name') . '"]';
    // ok: jgates.php.json-built-by-concatenation
    $json = json_encode(['name' => $_GET['name']]);
    // ok: jgates.php.json-built-by-concatenation
    $array = '[' . json_encode($request->input('name')) . ']';
}
