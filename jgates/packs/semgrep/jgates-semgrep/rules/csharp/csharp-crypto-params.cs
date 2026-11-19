using System;
using System.Security.Cryptography;
using System.Text;
using System.Linq;
using Microsoft.IdentityModel.Tokens;

public class CryptoParamsSamples
{
    public void KeySizeSamples()
    {
        // ruleid: jgates.csharp.weak-key-size
        var a = RSA.Create(1024);
        // ruleid: jgates.csharp.weak-key-size
        var b = new RSACryptoServiceProvider(512);
        // ruleid: jgates.csharp.weak-key-size
        var c = DSA.Create(1024);
        // ruleid: jgates.csharp.weak-key-size
        var d = ECCurve.CreateFromFriendlyName("secp160r1");
        // ruleid: jgates.csharp.weak-key-size
        var e = ECCurve.NamedCurves.brainpoolP160r1;
        // ok: jgates.csharp.weak-key-size
        var f = RSA.Create(3072);
        // ok: jgates.csharp.weak-key-size
        var g = ECCurve.NamedCurves.nistP256;
        // ok: jgates.csharp.weak-key-size
        var h = new RSACryptoServiceProvider(4096);
    }

    public void Rsa2048Samples()
    {
        // ruleid: jgates.csharp.rsa-key-below-3072
        var a = RSA.Create(2048);
        // ruleid: jgates.csharp.rsa-key-below-3072
        var b = new RSACryptoServiceProvider(2048);
        // ok: jgates.csharp.rsa-key-below-3072
        var c = RSA.Create(3072);
        // ok: jgates.csharp.rsa-key-below-3072
        var d = RSA.Create(4096);
    }

    public void IvSamples(Aes aes, byte[] key, byte[] plain)
    {
        // ruleid: jgates.csharp.static-iv-or-nonce
        aes.IV = new byte[16];
        // ruleid: jgates.csharp.static-iv-or-nonce
        aes.IV = new byte[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 };
        // ruleid: jgates.csharp.static-iv-or-nonce
        aes.IV = Encoding.UTF8.GetBytes("0123456789abcdef");
        // ruleid: jgates.csharp.static-iv-or-nonce
        var enc = aes.CreateEncryptor(key, new byte[16]);
        using var gcm = new AesGcm(key);
        // ruleid: jgates.csharp.static-iv-or-nonce
        gcm.Encrypt(new byte[12], plain, plain, new byte[16]);
        // ok: jgates.csharp.static-iv-or-nonce
        aes.GenerateIV();
        // ok: jgates.csharp.static-iv-or-nonce
        var nonce = RandomNumberGenerator.GetBytes(12);
        // ok: jgates.csharp.static-iv-or-nonce
        gcm.Encrypt(nonce, plain, plain, new byte[16]);
    }

    public void ModeSamples(Aes aes, byte[] data, byte[] iv)
    {
        // ruleid: jgates.csharp.cipher-mode-without-authentication
        aes.Mode = CipherMode.CBC;
        // ruleid: jgates.csharp.cipher-mode-without-authentication
        aes.Mode = CipherMode.CFB;
        // ruleid: jgates.csharp.cipher-mode-without-authentication
        var c = aes.EncryptCbc(data, iv);
        // ok: jgates.csharp.cipher-mode-without-authentication
        var gcm = new AesGcm(RandomNumberGenerator.GetBytes(32));
        // ok: jgates.csharp.cipher-mode-without-authentication
        var cha = new ChaCha20Poly1305(RandomNumberGenerator.GetBytes(32));
    }

    public void KdfSamples(string password, byte[] salt)
    {
        // ruleid: jgates.csharp.weak-kdf-parameters
        var a = new Rfc2898DeriveBytes(password, salt, 1000);
        // ruleid: jgates.csharp.weak-kdf-parameters
        var b = Rfc2898DeriveBytes.Pbkdf2(password, salt, 10000, HashAlgorithmName.SHA256, 32);
        // ruleid: jgates.csharp.weak-kdf-parameters-by-default
        var c = new Rfc2898DeriveBytes(password, salt);
        // ruleid: jgates.csharp.weak-kdf-parameters
        var d = BCrypt.Net.BCrypt.HashPassword(password, 4);
        // ruleid: jgates.csharp.weak-kdf-parameters
        var e = new ScryptEncoder(1024, 8, 1);
        // ruleid: jgates.csharp.weak-kdf-parameters
        var f = new Argon2id(salt) { Iterations = 1, MemorySize = 65536 };
        // ok: jgates.csharp.weak-kdf-parameters
        var g = Rfc2898DeriveBytes.Pbkdf2(password, salt, 600000, HashAlgorithmName.SHA256, 32);
        // ok: jgates.csharp.weak-kdf-parameters
        var h = BCrypt.Net.BCrypt.HashPassword(password, 12);
        // ok: jgates.csharp.weak-kdf-parameters
        var i = new Rfc2898DeriveBytes(password, salt, 600000, HashAlgorithmName.SHA256);
    }

    public void DefaultKdfSamples(string password, byte[] salt)
    {
        // ruleid: jgates.csharp.weak-kdf-parameters-by-default
        using var omittedIterations = new Rfc2898DeriveBytes(password, salt);
        // ruleid: jgates.csharp.weak-kdf-parameters
        using var explicitWeakIterations = new Rfc2898DeriveBytes(password, salt, 1000);
        // ok: jgates.csharp.weak-kdf-parameters-by-default
        using var explicitIterations = new Rfc2898DeriveBytes(password, salt, 600000);
        // ok: jgates.csharp.weak-kdf-parameters-by-default
        using var explicitHash = new Rfc2898DeriveBytes(password, salt, 600000, HashAlgorithmName.SHA256);
    }

    public void PasswordHashSamples(string password, string userPassword, byte[] salt)
    {
        // ruleid: jgates.csharp.password-hash-with-fast-hash
        var a = SHA256.HashData(Encoding.UTF8.GetBytes(password));
        // ruleid: jgates.csharp.password-hash-with-fast-hash
        var b = MD5.HashData(Encoding.UTF8.GetBytes(userPassword));
        using var sha = SHA512.Create();
        // ruleid: jgates.csharp.password-hash-with-fast-hash
        var c = sha.ComputeHash(Encoding.UTF8.GetBytes(password));
        // ok: jgates.csharp.password-hash-with-fast-hash
        var d = Rfc2898DeriveBytes.Pbkdf2(password, salt, 600000, HashAlgorithmName.SHA256, 32);
        // ok: jgates.csharp.password-hash-with-fast-hash
        var e = SHA256.HashData(Encoding.UTF8.GetBytes("fixed file content"));
        // ok: jgates.csharp.password-hash-with-fast-hash
        var f = BCrypt.Net.BCrypt.HashPassword(password, 12);
    }

    public bool CompareSamples(byte[] computedHmac, byte[] expectedHmac, string signature, string provided, byte[] digest, byte[] other, string name)
    {
        // ruleid: jgates.csharp.timing-unsafe-comparison
        if (computedHmac == expectedHmac) return true;
        // ruleid: jgates.csharp.timing-unsafe-comparison
        if (signature == provided) return true;
        // ruleid: jgates.csharp.timing-unsafe-comparison
        if (digest.SequenceEqual(other)) return true;
        // ok: jgates.csharp.timing-unsafe-comparison
        if (CryptographicOperations.FixedTimeEquals(computedHmac, expectedHmac)) return true;
        // ok: jgates.csharp.timing-unsafe-comparison
        if (signature == null) return false;
        // ok: jgates.csharp.timing-unsafe-comparison
        return name == "admin";
    }

    public void SignatureSamples(RSA rsa, byte[] data, byte[] key)
    {
        // ruleid: jgates.csharp.weak-signature-hash
        var a = rsa.SignData(data, HashAlgorithmName.SHA1, RSASignaturePadding.Pkcs1);
        // ruleid: jgates.csharp.weak-signature-hash
        var b = new HMACSHA1(key);
        // ruleid: jgates.csharp.weak-signature-hash
        var c = new SigningCredentials(new SymmetricSecurityKey(key), SecurityAlgorithms.HmacSha1);
        // ruleid: jgates.csharp.weak-signature-hash
        var d = rsa.VerifyData(data, data, HashAlgorithmName.MD5, RSASignaturePadding.Pkcs1);
        // ok: jgates.csharp.weak-signature-hash
        var e = rsa.SignData(data, HashAlgorithmName.SHA256, RSASignaturePadding.Pss);
        // ok: jgates.csharp.weak-signature-hash
        var f = new HMACSHA256(key);
        // ok: jgates.csharp.weak-signature-hash
        var g = new SigningCredentials(new SymmetricSecurityKey(key), SecurityAlgorithms.HmacSha256);
    }

    public void DhSamples()
    {
        // ruleid: jgates.csharp.weak-dh-parameters
        var weak = new DHParametersGenerator();
        weak.Init(1024, 30, new SecureRandom());
        // ruleid: jgates.csharp.weak-dh-parameters
        DHParametersGenerator weaker = new DHParametersGenerator();
        weaker.Init(768, 30, new SecureRandom());
        // ok: jgates.csharp.weak-dh-parameters
        var strong = new DHParametersGenerator();
        strong.Init(2048, 30, new SecureRandom());
        // ok: jgates.csharp.weak-dh-parameters
        var stronger = new DHParametersGenerator();
        stronger.Init(3072, 30, new SecureRandom());
    }

    public void KeySamples(Aes aes, byte[] data)
    {
        // ruleid: jgates.csharp.hardcoded-encryption-key
        aes.Key = Encoding.UTF8.GetBytes("0123456789abcdef0123456789abcdef");
        // ruleid: jgates.csharp.hardcoded-encryption-key
        var a = new HMACSHA256(Encoding.UTF8.GetBytes("super-secret-signing-key"));
        // ruleid: jgates.csharp.hardcoded-encryption-key
        var b = new SymmetricSecurityKey(Convert.FromBase64String("c3VwZXItc2VjcmV0LWtleS1ieXRlcy0xMjM0NTY3OA=="));
        // ruleid: jgates.csharp.hardcoded-encryption-key
        var c = new AesGcm(new byte[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16 });
        // ok: jgates.csharp.hardcoded-encryption-key
        aes.Key = Convert.FromBase64String(Environment.GetEnvironmentVariable("APP_KEY"));
        // ok: jgates.csharp.hardcoded-encryption-key
        var d = new HMACSHA256(RandomNumberGenerator.GetBytes(32));
        // ok: jgates.csharp.hardcoded-encryption-key
        var e = new SymmetricSecurityKey(Convert.FromBase64String(Environment.GetEnvironmentVariable("JWT_KEY")));
    }

    public void RandomSamples(Random rnd)
    {
        // ruleid: jgates.csharp.insecure-random-for-secret
        var resetToken = new Random().Next().ToString();
        // ruleid: jgates.csharp.insecure-random-for-secret
        var password = rnd.Next(100000, 999999).ToString();
        // ruleid: jgates.csharp.insecure-random-for-secret
        string sessionId = Random.Shared.Next().ToString("x");
        var saltBytes = new byte[16];
        // ruleid: jgates.csharp.insecure-random-for-secret
        rnd.NextBytes(saltBytes);
        // ok: jgates.csharp.insecure-random-for-secret
        var token = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        // ok: jgates.csharp.insecure-random-for-secret
        var pageIndex = rnd.Next(10);
        // ok: jgates.csharp.insecure-random-for-secret
        RandomNumberGenerator.Fill(saltBytes);
    }

    public void GuidSamples()
    {
        // ruleid: jgates.csharp.uuid-as-secret-token
        var resetToken = Guid.NewGuid().ToString("N");
        // ruleid: jgates.csharp.uuid-as-secret-token
        var apiKey = Guid.NewGuid().ToString();
        // ok: jgates.csharp.uuid-as-secret-token
        var requestId = Guid.NewGuid().ToString();
        // ok: jgates.csharp.uuid-as-secret-token
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    }
}
