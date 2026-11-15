<?php

use Ramsey\Uuid\Uuid;

class VaultCrypto
{
    public function newSigningKey()
    {
        return openssl_pkey_new(['private_key_bits' => 1024, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
    }

    public function newArchiveKey()
    {
        return openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
    }

    public function sealRecord(string $record, string $key): string
    {
        return openssl_encrypt($record, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, '0123456789ab', $tag);
    }

    public function sealLegacy(string $record, string $key, string $iv): string
    {
        return openssl_encrypt($record, 'aes-256-cbc', $key, OPENSSL_RAW_DATA, $iv);
    }

    public function storePassword(string $password): string
    {
        return password_hash($password, PASSWORD_BCRYPT, ['cost' => 4]);
    }

    public function fingerprintPassword(string $password): string
    {
        return hash('sha256', $password);
    }

    public function isAuthentic(string $payload, string $secret, string $signature): bool
    {
        $expected = hash_hmac('sha256', $payload, $secret);
        return $expected === $signature;
    }

    public function legacyTag(string $payload, string $secret): string
    {
        return hash_hmac('sha1', $payload, $secret);
    }

    public function encryptWithBuiltInKey(string $record, string $iv): string
    {
        return openssl_encrypt($record, 'aes-256-gcm', 'vault-key-0123456789-abcdefghij', OPENSSL_RAW_DATA, $iv, $tag);
    }

    public function newResetToken(): string
    {
        $token = md5(uniqid(mt_rand(), true));
        return $token;
    }

    public function newInviteToken(): string
    {
        $inviteToken = Uuid::uuid4()->toString();
        return $inviteToken;
    }
}
