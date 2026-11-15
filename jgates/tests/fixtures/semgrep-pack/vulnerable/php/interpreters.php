<?php
function directory_lookup($link) {
    $filter = "(uid=" . $_GET['user'] . ")";
    return ldap_search($link, 'dc=example,dc=org', $filter);
}

function find_user($xml) {
    return $xml->xpath("//user[@name='" . $_GET['name'] . "']");
}

function preview($twig) {
    return $twig->createTemplate($_POST['body']);
}

function parse_upload($data) {
    $dom = new DOMDocument();
    $dom->loadXML($data, LIBXML_NOENT | LIBXML_DTDLOAD);
    return $dom;
}

function transform($proc) {
    $sheet = new DOMDocument();
    $sheet->loadXML($_POST['xsl']);
    $proc->importStylesheet($sheet);
}

function build_pdf($file) {
    exec('pdflatex -shell-escape ' . escapeshellarg($file));
}

function contact($body) {
    mail('team@example.org', $_POST['subject'], $body);
}
