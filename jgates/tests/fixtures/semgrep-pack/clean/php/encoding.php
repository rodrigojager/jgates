<?php
function search_handler($request) {
    $term = $_GET['q'];
    $found = preg_match('/' . preg_quote($term, '/') . '/i', 'catalog text');
    $clean = preg_match('/^a+$/', 'catalog text');
    $title = sprintf('Catalog %s', $request->input('template'));
    return [$found, $clean, $title];
}
