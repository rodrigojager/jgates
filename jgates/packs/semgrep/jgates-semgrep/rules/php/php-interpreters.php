<?php
function ldap_cases($link, $request) {
    // ruleid: jgates.php.ldap-injection
    ldap_search($link, 'dc=example,dc=org', "(uid=" . $_GET['user'] . ")");
    // ruleid: jgates.php.ldap-injection
    ldap_search($link, 'dc=example,dc=org', "(&(uid={$request->input('user')})(active=1))");
    // ruleid: jgates.php.ldap-injection
    ldap_read($link, $_POST['dn'], '(objectClass=*)');
    // ruleid: jgates.php.ldap-injection
    ldap_list($link, 'ou=people,dc=example,dc=org', '(cn=' . $_REQUEST['name'] . ')');
    // ok: jgates.php.ldap-injection
    ldap_search($link, 'dc=example,dc=org', '(uid=' . ldap_escape($_GET['user'], '', LDAP_ESCAPE_FILTER) . ')');
    // ok: jgates.php.ldap-injection
    ldap_read($link, 'cn=' . ldap_escape($_POST['dn'], '', LDAP_ESCAPE_DN) . ',dc=example,dc=org', '(objectClass=*)');
    // ok: jgates.php.ldap-injection
    ldap_search($link, 'dc=example,dc=org', '(objectClass=person)');
}

function xpath_cases($xml, $doc, $request) {
    // ruleid: jgates.php.xpath-injection
    $xml->xpath("//user[@name='" . $_GET['name'] . "']");
    // ruleid: jgates.php.xpath-injection
    $xml->xpath('//item[@id="' . $request->input('id') . '"]');
    $xp = new DOMXPath($doc);
    // ruleid: jgates.php.xpath-injection
    $xp->query("//user[name='" . $_POST['name'] . "']");
    // ruleid: jgates.php.xpath-injection
    $xp->evaluate("count(//order[customer='" . $_REQUEST['c'] . "'])");
    // ok: jgates.php.xpath-injection
    $xml->xpath('//user[@role="admin"]');
    // ok: jgates.php.xpath-injection
    $xp->query('//user/name');
    // ok: jgates.php.xpath-injection
    $xml->xpath('//item[@id=' . (int) $_GET['id'] . ']');
    // ok: jgates.php.xpath-injection
    $xp->evaluate('count(//order[position()=' . intval($_GET['n']) . '])');
}

function template_cases($twig, $smarty, $request) {
    // ruleid: jgates.php.template-from-request
    $twig->createTemplate($_POST['body']);
    // ruleid: jgates.php.template-from-request
    $twig->createTemplate("Hello " . $request->input('greeting'));
    // ruleid: jgates.php.template-from-request
    Blade::render($_GET['view'], ['user' => $user]);
    // ruleid: jgates.php.template-from-request
    Blade::compileString($request->input('tpl'));
    // ruleid: jgates.php.template-from-request
    $smarty->fetch("string:" . $_GET['tpl']);
    // ruleid: jgates.php.template-from-request
    $smarty->display("string:{$_POST['tpl']}");
    // ok: jgates.php.template-from-request
    $twig->createTemplate('Hello {{ name }}')->render(['name' => $_POST['name']]);
    // ok: jgates.php.template-from-request
    $twig->render('profile.html.twig', ['bio' => $_POST['bio']]);
    // ok: jgates.php.template-from-request
    Blade::render('Hello {{ $name }}', ['name' => $request->input('name')]);
    // ok: jgates.php.template-from-request
    $smarty->assign('name', $_GET['name']);
    // ok: jgates.php.template-from-request
    $smarty->fetch('profile.tpl');
}

function xxe_cases($dom, $reader, $data) {
    // ruleid: jgates.php.xml-external-entity
    $dom->loadXML($data, LIBXML_NOENT | LIBXML_DTDLOAD);
    // ruleid: jgates.php.xml-external-entity
    simplexml_load_string($data, 'SimpleXMLElement', LIBXML_NOENT);
    // ruleid: jgates.php.xml-external-entity
    libxml_disable_entity_loader(false);
    // ruleid: jgates.php.xml-external-entity
    $reader->setParserProperty(XMLReader::SUBST_ENTITIES, true);
    // ruleid: jgates.php.xml-external-entity
    $dom->load($data, LIBXML_DTDLOAD);
    // ok: jgates.php.xml-external-entity
    $dom->loadXML($data, LIBXML_NONET | LIBXML_NOBLANKS);
    // ok: jgates.php.xml-external-entity
    simplexml_load_string($data);
    // ok: jgates.php.xml-external-entity
    $reader->setParserProperty(XMLReader::SUBST_ENTITIES, false);
}

function xslt_cases($proc, $request) {
    $sheet = new DOMDocument();
    $sheet->loadXML($_POST['xsl']);
    // ruleid: jgates.php.xslt-from-request
    $proc->importStylesheet($sheet);
    $remote = new DOMDocument();
    $remote->load($request->input('sheet'));
    // ruleid: jgates.php.xslt-from-request
    $proc->importStylesheet($remote);
    $own = new DOMDocument();
    $own->load(__DIR__ . '/templates/report.xsl');
    // ok: jgates.php.xslt-from-request
    $proc->importStylesheet($own);
    // ok: jgates.php.xslt-from-request
    $proc->setParameter('', 'title', $_GET['title']);
}

function latex_cases($file) {
    // ruleid: jgates.php.latex-shell-escape
    exec('pdflatex -shell-escape ' . escapeshellarg($file));
    // ruleid: jgates.php.latex-shell-escape
    shell_exec("xelatex -enable-write18 report.tex");
    // ruleid: jgates.php.latex-shell-escape
    proc_open(['lualatex', '--shell-escape', $file], [], $pipes);
    // ok: jgates.php.latex-shell-escape
    exec('pdflatex -no-shell-escape ' . escapeshellarg($file));
    // ok: jgates.php.latex-shell-escape
    exec('pdflatex -interaction=nonstopmode ' . escapeshellarg($file));
    // ok: jgates.php.latex-shell-escape
    proc_open(['lualatex', '--no-shell-escape', $file], [], $pipes);
}

function mail_cases($body, $request) {
    // ruleid: jgates.php.mail-header-injection
    mail($_POST['email'], 'Welcome', $body);
    // ruleid: jgates.php.mail-header-injection
    mail('team@example.org', $request->input('subject'), $body);
    // ruleid: jgates.php.mail-header-injection
    mail('team@example.org', 'Contact', $body, "From: " . $_POST['from'] . "\r\n");
    // ok: jgates.php.mail-header-injection
    mail(filter_var($_POST['email'], FILTER_VALIDATE_EMAIL), 'Welcome', $body);
    // ok: jgates.php.mail-header-injection
    mail('team@example.org', str_replace(["\r", "\n"], '', $_POST['subject']), $body);
    // ok: jgates.php.mail-header-injection
    mail('team@example.org', 'Contact', $_POST['message'], 'From: noreply@example.org');
    // ok: jgates.php.mail-header-injection
    mail('team@example.org', preg_replace("/[\r\n]+/", '', $_GET['s']), $body);
}
