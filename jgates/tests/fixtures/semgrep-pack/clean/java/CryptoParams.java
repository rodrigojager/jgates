import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.Cipher;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

public class CryptoParams {
    private final SecureRandom random = new SecureRandom();

    public void generateKeys() throws Exception {
        KeyPairGenerator strongRsa = KeyPairGenerator.getInstance("RSA");
        strongRsa.initialize(3072);
        KeyPairGenerator ecKey = KeyPairGenerator.getInstance("EC");
        ecKey.initialize(256);
        KeyPairGenerator strongDh = KeyPairGenerator.getInstance("DH");
        strongDh.initialize(3072);
    }

    public byte[] encrypt(byte[] data) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        SecretKeySpec key = new SecretKeySpec(System.getenv("APP_KEY").getBytes(), "AES");
        byte[] iv = new byte[12];
        random.nextBytes(iv);
        cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
        return cipher.doFinal(data);
    }

    public Object deriveKey(char[] secretPhrase, byte[] salt) throws Exception {
        PBEKeySpec spec = new PBEKeySpec(secretPhrase, salt, 600000, 256);
        return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec);
    }

    public byte[] storePassword(char[] password, byte[] salt) throws Exception {
        PBEKeySpec spec = new PBEKeySpec(password, salt, 600000, 256);
        return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
    }

    public boolean checkTag(byte[] computedMac, byte[] receivedMac) {
        return MessageDigest.isEqual(computedMac, receivedMac);
    }

    public Signature signer() throws Exception {
        return Signature.getInstance("SHA256withRSA");
    }

    public String issueTokens() {
        byte[] raw = new byte[32];
        random.nextBytes(raw);
        String resetToken = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        return resetToken;
    }
}
