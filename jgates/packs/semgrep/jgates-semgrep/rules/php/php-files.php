<?php

// ---- upload-client-filename-in-path ----
function upload_name_cases($request, $dir)
{
    // ruleid: jgates.php.upload-client-filename-in-path
    move_uploaded_file($_FILES['doc']['tmp_name'], $dir . '/' . $_FILES['doc']['name']);

    $name = $_FILES['doc']['name'];
    // ruleid: jgates.php.upload-client-filename-in-path
    move_uploaded_file($_FILES['doc']['tmp_name'], "/srv/uploads/" . $name);

    $file = $request->file('avatar');
    // ruleid: jgates.php.upload-client-filename-in-path
    $file->move($dir, $file->getClientOriginalName());

    // ruleid: jgates.php.upload-client-filename-in-path
    $file->storeAs('avatars', $file->getClientOriginalName());

    // ruleid: jgates.php.upload-client-filename-in-path
    file_put_contents($dir . '/' . $_FILES['doc']['name'], 'x');

    // ok: jgates.php.upload-client-filename-in-path
    move_uploaded_file($_FILES['doc']['tmp_name'], $dir . '/' . bin2hex(random_bytes(16)) . '.pdf');
    // ok: jgates.php.upload-client-filename-in-path
    $file->move($dir, bin2hex(random_bytes(16)) . '.png');
    // ok: jgates.php.upload-client-filename-in-path
    $file->storeAs('avatars', uniqid('', true) . '.png');
    // ok: jgates.php.upload-client-filename-in-path
    $label = $_FILES['doc']['name'];
    echo htmlspecialchars($label);
}

// ---- archive-extraction-unchecked ----
function archive_cases($path, $dir)
{
    $zip = new ZipArchive();
    $zip->open($path);
    // ruleid: jgates.php.archive-extraction-unchecked
    $zip->extractTo($dir);

    $phar = new PharData($path);
    // ruleid: jgates.php.archive-extraction-unchecked
    $phar->extractTo($dir);

    for ($i = 0; $i < $zip->numFiles; $i++) {
        $entry = $zip->getNameIndex($i);
        // ruleid: jgates.php.archive-extraction-unchecked
        file_put_contents($dir . '/' . $entry, $zip->getFromIndex($i));
    }

    // ok: jgates.php.archive-extraction-unchecked
    $zip->extractTo($dir, ['report.csv', 'summary.csv']);
    for ($i = 0; $i < $zip->numFiles; $i++) {
        // ok: jgates.php.archive-extraction-unchecked
        file_put_contents($dir . '/' . $i . '.bin', $zip->getFromIndex($i));
    }
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $entry = $zip->getNameIndex($i);
        if (preg_match('/\A[a-zA-Z0-9_-]+\.csv\z/', $entry) === 1) {
            // ok: jgates.php.archive-extraction-unchecked
            file_put_contents($dir . '/' . $entry, $zip->getFromIndex($i));
        }
    }
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $name = $zip->getNameIndex($i);
        if (preg_match('/\A[a-zA-Z0-9_-]+\.csv\z/', $name) === 1) {
            // ok: jgates.php.archive-extraction-unchecked
            $output = fopen($dir . '/' . $name, 'wb');
        }
    }
}

// ---- request-body-without-size-limit ----
function body_limit_cases()
{
    // ruleid: jgates.php.request-body-without-size-limit
    ini_set('post_max_size', '0');
    // ruleid: jgates.php.request-body-without-size-limit
    ini_set('post_max_size', 0);
    // ruleid: jgates.php.request-body-without-size-limit
    ini_set('post_max_size', '0M');
    // ok: jgates.php.request-body-without-size-limit
    ini_set('post_max_size', '8M');
    // ok: jgates.php.request-body-without-size-limit
    ini_set('upload_max_filesize', '2M');
}

// ---- upload-content-type-trusted ----
function content_type_cases($request)
{
    // ruleid: jgates.php.upload-content-type-trusted
    if ($_FILES['img']['type'] === 'image/png') {
        echo 'png';
    }
    // ruleid: jgates.php.upload-content-type-trusted
    if (in_array($_FILES['img']['type'], ['image/png', 'image/jpeg'], true)) {
        echo 'image';
    }
    $file = $request->file('img');
    // ruleid: jgates.php.upload-content-type-trusted
    if ($file->getClientMimeType() == 'application/pdf') {
        echo 'pdf';
    }
    // ruleid: jgates.php.upload-content-type-trusted
    if ('image/gif' !== $file->getClientMimeType()) {
        echo 'not gif';
    }

    $finfo = new finfo(FILEINFO_MIME_TYPE);
    // ok: jgates.php.upload-content-type-trusted
    if ($finfo->file($_FILES['img']['tmp_name']) === 'image/png') {
        echo 'png';
    }
    // ok: jgates.php.upload-content-type-trusted
    if (in_array(mime_content_type($_FILES['img']['tmp_name']), ['image/png', 'image/jpeg'], true)) {
        echo 'image';
    }
    // ok: jgates.php.upload-content-type-trusted
    if ($file->getMimeType() === 'application/pdf') {
        echo 'pdf';
    }
}

// ---- content-disposition-from-request ----
function disposition_cases($request, $response)
{
    // ruleid: jgates.php.content-disposition-from-request
    header('Content-Disposition: attachment; filename="' . $_GET['name'] . '"');

    $wanted = $request->input('name');
    // ruleid: jgates.php.content-disposition-from-request
    header("Content-Disposition: attachment; filename=" . $wanted);

    // ruleid: jgates.php.content-disposition-from-request
    $response->header('Content-Disposition', 'attachment; filename=' . $request->query('f'));

    // ruleid: jgates.php.content-disposition-from-request
    $response->headers->set('Content-Disposition', 'attachment; filename=' . $request->get('f'));

    // ok: jgates.php.content-disposition-from-request
    header('Content-Disposition: attachment; filename="report.pdf"');
    // ok: jgates.php.content-disposition-from-request
    header("Content-Disposition: attachment; filename*=UTF-8''" . rawurlencode($_GET['name']));
    // ok: jgates.php.content-disposition-from-request
    $response->header('Content-Disposition', 'attachment; filename=' . rawurlencode($wanted));
    // ok: jgates.php.content-disposition-from-request
    header('X-Request-Name: ' . $_GET['name']);
}
