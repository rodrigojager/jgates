<?php

class DocumentController
{
    public function store(string $dir): void
    {
        move_uploaded_file($_FILES['doc']['tmp_name'], $dir . '/' . bin2hex(random_bytes(16)) . '.pdf');
    }

    public function unpack(string $archive, string $dir): void
    {
        $zip = new ZipArchive();
        $zip->open($archive);
        $zip->extractTo($dir, ['report.csv', 'summary.csv']);
    }

    public function configure(): void
    {
        ini_set('post_max_size', '8M');
    }

    public function isPng(): bool
    {
        $finfo = new finfo(FILEINFO_MIME_TYPE);
        return $finfo->file($_FILES['img']['tmp_name']) === 'image/png';
    }

    public function download(): void
    {
        header("Content-Disposition: attachment; filename*=UTF-8''" . rawurlencode($_GET['name']));
    }
}
