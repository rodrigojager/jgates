<?php
function sql_cases($pdo, $connection, $request, $req, $builder) {
    $name = $_GET['name'];
    // ruleid: jgates.php.sql-string-building
    mysqli_query($connection, "SELECT * FROM users WHERE name = '" . $name . "'");
    // ruleid: jgates.php.sql-string-building
    $pdo->query("SELECT * FROM users WHERE name = '$name'");
    // ruleid: jgates.php.sql-string-building
    $pdo->exec("DELETE FROM users WHERE id = " . $_POST['id']);
    // ruleid: jgates.php.sql-string-building
    DB::raw("SELECT * FROM users WHERE id = " . $request->input('id'));
    // ruleid: jgates.php.sql-string-building
    DB::whereRaw("name = '" . $req->query->get('name') . "'");
    // ruleid: jgates.php.sql-string-building
    $builder->whereRaw("id = " . request()->input('id'));
    // ok: jgates.php.sql-string-building
    $statement = $pdo->prepare('SELECT * FROM users WHERE name = ?');
    // ok: jgates.php.sql-string-building
    $statement->execute([$name]);
    // ok: jgates.php.sql-string-building
    $builder->whereRaw('name = ?', [$name]);
    // ok: jgates.php.sql-string-building
    $pdo->query('SELECT * FROM users');
}
function command_cases() {
    $host = $_POST['host'];
    // ruleid: jgates.php.os-command-injection
    exec('ping ' . $host);
    // ruleid: jgates.php.os-command-injection
    system('ping ' . $_GET['host']);
    // ruleid: jgates.php.os-command-injection
    shell_exec($_REQUEST['command']);
    // ruleid: jgates.php.os-command-injection
    passthru($_COOKIE['command']);
    // ruleid: jgates.php.os-command-injection
    proc_open($_POST['command'], [], $pipes);
    // ruleid: jgates.php.os-command-injection
    $output = `ping $host`;
    // ok: jgates.php.os-command-injection
    exec('uptime');
    // ok: jgates.php.os-command-injection
    proc_open(['/usr/bin/ping', '-c', '1', $host], [], $pipes);
    // ok: jgates.php.os-command-injection
    $fixed = `uptime`;
}
function code_cases() {
    // ruleid: jgates.php.dynamic-code-execution
    eval($_POST['code']);
    // String assertions executed code on legacy PHP before PHP 8.
    // ruleid: jgates.php.dynamic-code-execution
    assert('return ' . $_REQUEST['expression'] . ';');
    // ok: jgates.php.dynamic-code-execution
    assert(is_string($_GET['value']));
    // ok: jgates.php.dynamic-code-execution
    eval('return 1 + 1;');
    // ruleid: jgates.php.preg-replace-eval
    preg_replace('/name/e', 'strtoupper("name")', 'name');
    // ruleid: jgates.php.preg-replace-eval
    preg_replace('#name#ie', 'strtoupper("name")', 'name');
    // ok: jgates.php.preg-replace-eval
    preg_replace('/name/i', 'value', 'name');
    // ok: jgates.php.preg-replace-eval
    preg_replace_callback('/name/', function ($match) { return strtoupper($match[0]); }, 'name');
}
