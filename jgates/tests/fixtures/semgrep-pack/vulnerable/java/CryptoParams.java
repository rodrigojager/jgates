import java.security.KeyPairGenerator;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Random;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

public class CryptoParams {
    public void generateKeys() throws Exception {
        KeyPairGenerator weakRsa = KeyPairGenerator.getInstance("RSA");
        weakRsa.initialize(1024);
        KeyPairGenerator midRsa = KeyPairGenerator.getInstance("RSA");
        midRsa.initialize(2048);
        KeyPairGenerator weakDh = KeyPairGenerator.getInstance("DH");
        weakDh.initialize(1024);
    }

    public byte[] encrypt(byte[] data) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
        SecretKeySpec key = new SecretKeySpec("0123456789abcdef".getBytes(), "AES");
        cipher.init(Cipher.ENCRYPT_MODE, key, new IvParameterSpec(new byte[16]));
        return cipher.doFinal(data);
    }

    public Object deriveKey(char[] secretPhrase, byte[] salt) {
        return new PBEKeySpec(secretPhrase, salt, 1000, 256);
    }

    public byte[] storePassword(String password) throws Exception {
        return MessageDigest.getInstance("SHA-256").digest(password.getBytes());
    }

    public boolean checkTag(byte[] computedMac, byte[] receivedMac) {
        return Arrays.equals(computedMac, receivedMac);
    }

    public Signature signer() throws Exception {
        return Signature.getInstance("SHA1withRSA");
    }

    public String issueTokens() {
        String resetToken = Long.toHexString(new Random().nextLong());
        String apiKey = "k-" + UUID.randomUUID();
        return resetToken + apiKey;
    }
}
