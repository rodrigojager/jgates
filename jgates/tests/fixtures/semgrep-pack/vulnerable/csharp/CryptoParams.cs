using System;
using System.Security.Cryptography;
using System.Text;

public class CryptoParamsService
{
    public RSA NewWeakKey()
    {
        return RSA.Create(1024);
    }

    public RSA NewMidKey()
    {
        return RSA.Create(2048);
    }

    public byte[] EncryptWithFixedIv(byte[] key, byte[] plain)
    {
        using var aes = Aes.Create();
        aes.Key = key;
        aes.IV = new byte[16];
        aes.Mode = CipherMode.CBC;
        using var enc = aes.CreateEncryptor();
        return enc.TransformFinalBlock(plain, 0, plain.Length);
    }

    public void NewDhParameters()
    {
        var gen = new DHParametersGenerator();
        gen.Init(1024, 30, new SecureRandom());
    }

    public byte[] DeriveKey(string password, byte[] salt)
    {
        using var kdf = new Rfc2898DeriveBytes(password, salt, 1000);
        return kdf.GetBytes(32);
    }

    public byte[] DeriveKeyWithDefaults(string password, byte[] salt)
    {
        using var kdf = new Rfc2898DeriveBytes(password, salt);
        return kdf.GetBytes(32);
    }

    public byte[] StorePassword(string password)
    {
        return SHA256.HashData(Encoding.UTF8.GetBytes(password));
    }

    public bool CheckMac(byte[] computedMac, byte[] expectedMac)
    {
        return computedMac == expectedMac;
    }

    public byte[] Sign(RSA rsa, byte[] data)
    {
        return rsa.SignData(data, HashAlgorithmName.SHA1, RSASignaturePadding.Pkcs1);
    }

    public HMACSHA256 SigningMac()
    {
        return new HMACSHA256(Encoding.UTF8.GetBytes("my-hardcoded-signing-key-1234567"));
    }

    public string NewResetToken()
    {
        var rnd = new Random();
        var resetToken = rnd.Next().ToString();
        return resetToken;
    }

    public string NewApiKey()
    {
        var apiKey = Guid.NewGuid().ToString("N");
        return apiKey;
    }
}
