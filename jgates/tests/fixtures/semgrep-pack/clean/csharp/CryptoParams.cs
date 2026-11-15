using System;
using System.Security.Cryptography;
using System.Text;

public class CryptoParamsService
{
    public RSA NewWeakKey()
    {
        return RSA.Create(3072);
    }

    public RSA NewMidKey()
    {
        return RSA.Create(4096);
    }

    public byte[] EncryptWithFreshNonce(byte[] key, byte[] plain)
    {
        using var gcm = new AesGcm(key);
        var nonce = RandomNumberGenerator.GetBytes(12);
        var cipher = new byte[plain.Length];
        var tag = new byte[16];
        gcm.Encrypt(nonce, plain, cipher, tag);
        return cipher;
    }

    public void NewDhParameters()
    {
        var gen = new DHParametersGenerator();
        gen.Init(3072, 30, new SecureRandom());
    }

    public byte[] DeriveKey(string password, byte[] salt)
    {
        return Rfc2898DeriveBytes.Pbkdf2(password, salt, 600000, HashAlgorithmName.SHA256, 32);
    }

    public byte[] StorePassword(string password, byte[] salt)
    {
        return Rfc2898DeriveBytes.Pbkdf2(password, salt, 600000, HashAlgorithmName.SHA256, 32);
    }

    public bool CheckMac(byte[] computedMac, byte[] expectedMac)
    {
        return CryptographicOperations.FixedTimeEquals(computedMac, expectedMac);
    }

    public byte[] Sign(RSA rsa, byte[] data)
    {
        return rsa.SignData(data, HashAlgorithmName.SHA256, RSASignaturePadding.Pss);
    }

    public HMACSHA256 SigningMac()
    {
        var key = Convert.FromBase64String(Environment.GetEnvironmentVariable("SIGNING_KEY"));
        return new HMACSHA256(key);
    }

    public string NewResetToken()
    {
        var resetToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        return resetToken;
    }

    public string NewApiKey()
    {
        var apiKey = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        return apiKey;
    }
}
