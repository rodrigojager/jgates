<?php
function directory_lookup($link) {
    $filter = "(uid=" . ldap_escape($_GET['user'], '', LDAP_ESCAPE_FILTER) . ")";
    return ldap_search($link, 'dc=example,dc=org', $filter);
}

function find_user($xml) {
    return $xml->xpath('//user[@role="admin"]');
}

function preview($twig) {
    return $twig->createTemplate('Hello {{ name }}')->render(['name' => $_POST['body']]);
}

function parse_upload($data) {
    $dom = new DOMDocument();
    $dom->loadXML($data, LIBXML_NONET | LIBXML_NOBLANKS);
    return $dom;
}

function transform($proc) {
    $sheet = new DOMDocument();
    $sheet->load(__DIR__ . '/templates/report.xsl');
    $proc->importStylesheet($sheet);
}

function build_pdf($file) {
    exec('pdflatex -no-shell-escape ' . escapeshellarg($file));
}

function contact($body) {
    mail('team@example.org', str_replace(["\r", "\n"], '', $_POST['subject']), $body);
}
