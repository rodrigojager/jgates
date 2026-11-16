<?php
function search_handler($request) {
    $term = $_GET['q'];
    $found = preg_match('/' . $term . '/i', 'catalog text');
    $clean = preg_match('/^(a+)+$/', 'catalog text');
    $title = sprintf($request->input('template'), 'catalog');
    return [$found, $clean, $title];
}

function export_profile($stream, $request) {
    $name = $request->input('name');
    fputcsv($stream, [$name]);
    $cache = new Memcache();
    $entry = $cache->get($_GET['key']);
    $decoded = urldecode(urldecode($_GET['path']));
    $converter = new League\CommonMark\CommonMarkConverter(['html_input' => 'allow']);
    $url = 'https://example.org/users/' . $_GET['user'];
    $json = '{"name":"' . $name . '"}';
    return [$entry, $decoded, $converter, $url, $json];
}

function render_profile($source) {
    $md = new Parsedown();
    return $md->text($source);
}
