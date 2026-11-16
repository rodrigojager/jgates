<?php
function search_handler($request) {
    $term = $_GET['q'];
    $found = preg_match('/' . preg_quote($term, '/') . '/i', 'catalog text');
    $clean = preg_match('/^a+$/', 'catalog text');
    $title = sprintf('Catalog %s', $request->input('template'));
    return [$found, $clean, $title];
}

function export_profile($stream, $request) {
    $name = $request->input('name');
    fputcsv($stream, ["'" . $name]);
    $cache = new Memcache();
    $entry = $cache->get(hash('sha256', $_GET['key']));
    $decoded = urldecode($_GET['path']);
    $converter = new League\CommonMark\CommonMarkConverter(['html_input' => 'escape']);
    $url = 'https://example.org/users/' . rawurlencode($_GET['user']);
    $json = json_encode(['name' => $name]);
    return [$entry, $decoded, $converter, $url, $json];
}

function render_profile($source) {
    $md = new Parsedown();
    $md->setSafeMode(true);
    return $md->text($source);
}
