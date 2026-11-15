<?php
function search_handler($request) {
    $term = $_GET['q'];
    $found = preg_match('/' . $term . '/i', 'catalog text');
    $clean = preg_match('/^(a+)+$/', 'catalog text');
    $title = sprintf($request->input('template'), 'catalog');
    return [$found, $clean, $title];
}
