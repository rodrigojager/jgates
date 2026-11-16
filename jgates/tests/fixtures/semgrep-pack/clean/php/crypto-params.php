<?php

use Ramsey\Uuid\Uuid;

class VaultCrypto
{
    public function newExchangeKey()
    {
        return openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_DH, 'private_key_bits' => 3072]);
    }

    public function newSigningKey()
    {
        return openssl_pkey_new(['private_key_bits' => 4096, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
    }

    public function newArchiveKey()
    {
        return openssl_pkey_new(['private_key_bits' => 3072, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
    }

    public function sealRecord(string $record, string $key): string
    {
        $nonce = random_bytes(12);
        return $nonce . openssl_encrypt($record, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $nonce, $tag) . $tag;
    }

    public function sealLegacy(string $record, string $key, string $iv): string
    {
        return openssl_encrypt($record, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
    }

    public function storePassword(string $password): string
    {
        return password_hash($password, PASSWORD_BCRYPT, ['cost' => 12]);
    }

    public function fingerprintPassword(string $password): string
    {
        return password_hash($password, PASSWORD_DEFAULT);
    }

    public function isAuthentic(string $payload, string $secret, string $signature): bool
    {
        $expected = hash_hmac('sha256', $payload, $secret);
        return hash_equals($expected, $signature);
    }

    public function legacyTag(string $payload, string $secret): string
    {
        return hash_hmac('sha256', $payload, $secret);
    }

    public function encryptWithBuiltInKey(string $record, string $iv): string
    {
        return openssl_encrypt($record, 'aes-256-gcm', getenv('VAULT_KEY'), OPENSSL_RAW_DATA, $iv, $tag);
    }

    public function newResetToken(): string
    {
        $token = bin2hex(random_bytes(32));
        return $token;
    }

    public function newInviteToken(): string
    {
        $inviteToken = bin2hex(random_bytes(32));
        return $inviteToken;
    }
}
