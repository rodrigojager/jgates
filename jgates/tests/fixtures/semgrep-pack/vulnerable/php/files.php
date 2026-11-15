<?php

class DocumentController
{
    public function store(string $dir): void
    {
        move_uploaded_file($_FILES['doc']['tmp_name'], $dir . '/' . $_FILES['doc']['name']);
    }

    public function unpack(string $archive, string $dir): void
    {
        $zip = new ZipArchive();
        $zip->open($archive);
        $zip->extractTo($dir);
    }

    public function configure(): void
    {
        ini_set('post_max_size', '0');
    }

    public function isPng(): bool
    {
        return $_FILES['img']['type'] === 'image/png';
    }

    public function download(): void
    {
        header('Content-Disposition: attachment; filename="' . $_GET['name'] . '"');
    }
}
