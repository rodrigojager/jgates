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
        if ($zip->numFiles > 100) {
            throw new RuntimeException('Too many archive entries');
        }
        $totalSize = 0;
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $stat = $zip->statIndex($i);
            $totalSize += $stat['size'];
            if ($totalSize > 10485760) {
                throw new RuntimeException('Archive exceeds expanded size limit');
            }
        }
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $entry = $zip->getNameIndex($i);
            if (preg_match('/\A[a-zA-Z0-9_-]+\.csv\z/', $entry) === 1) {
                file_put_contents($dir . '/' . $entry, $zip->getFromIndex($i));
            }
        }
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
