import java.security.KeyPairGenerator;
import java.security.SecureRandom;
import java.security.MessageDigest;
import java.security.Signature;
import java.security.AlgorithmParameterGenerator;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.RSAKeyGenParameterSpec;
import java.util.Arrays;
import java.util.Random;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

class CryptoParamsFixture {
    // weak-key-size
    void keySizes() throws Exception {
        // ruleid: jgates.java.weak-key-size
        KeyPairGenerator weakRsa = KeyPairGenerator.getInstance("RSA");
        weakRsa.initialize(1024);
        // ruleid: jgates.java.weak-key-size
        KeyPairGenerator weakDsa = KeyPairGenerator.getInstance("DSA");
        weakDsa.initialize(1024, new SecureRandom());
        // ruleid: jgates.java.weak-key-size
        KeyPairGenerator weakEc = KeyPairGenerator.getInstance("EC");
        weakEc.initialize(192);
        // ruleid: jgates.java.weak-key-size
        new RSAKeyGenParameterSpec(1024, RSAKeyGenParameterSpec.F4);
        // ruleid: jgates.java.weak-key-size
        new ECGenParameterSpec("secp192r1");
        // ok: jgates.java.weak-key-size
        KeyPairGenerator strongRsa = KeyPairGenerator.getInstance("RSA");
        strongRsa.initialize(3072);
        // ok: jgates.java.weak-key-size
        KeyPairGenerator strongEc = KeyPairGenerator.getInstance("EC");
        strongEc.initialize(256);
        // ok: jgates.java.weak-key-size
        new ECGenParameterSpec("secp256r1");
        // ok: jgates.java.weak-key-size
        new RSAKeyGenParameterSpec(4096, RSAKeyGenParameterSpec.F4);
    }

    // rsa-key-below-3072
    void rsaSizes() throws Exception {
        // ruleid: jgates.java.rsa-key-below-3072
        KeyPairGenerator mid = KeyPairGenerator.getInstance("RSA");
        mid.initialize(2048);
        // ruleid: jgates.java.rsa-key-below-3072
        new RSAKeyGenParameterSpec(2048, RSAKeyGenParameterSpec.F4);
        // ok: jgates.java.rsa-key-below-3072
        KeyPairGenerator big = KeyPairGenerator.getInstance("RSA");
        big.initialize(3072);
        // ok: jgates.java.rsa-key-below-3072
        KeyPairGenerator ec = KeyPairGenerator.getInstance("EC");
        ec.initialize(256);
        // ok: jgates.java.rsa-key-below-3072
        new RSAKeyGenParameterSpec(4096, RSAKeyGenParameterSpec.F4);
    }

    // static-iv-or-nonce
    void ivs(Cipher cipher, SecretKeySpec key) throws Exception {
        // ruleid: jgates.java.static-iv-or-nonce
        cipher.init(Cipher.ENCRYPT_MODE, key, new IvParameterSpec(new byte[16]));
        // ruleid: jgates.java.static-iv-or-nonce
        cipher.init(Cipher.ENCRYPT_MODE, key, new IvParameterSpec("0123456789abcdef".getBytes()));
        // ruleid: jgates.java.static-iv-or-nonce
        cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, new byte[12]));
        // ruleid: jgates.java.static-iv-or-nonce
        cipher.init(Cipher.ENCRYPT_MODE, key, new IvParameterSpec(new byte[] {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}));
        byte[] iv = new byte[12];
        new SecureRandom().nextBytes(iv);
        // ok: jgates.java.static-iv-or-nonce
        cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
        // ok: jgates.java.static-iv-or-nonce
        cipher.init(Cipher.ENCRYPT_MODE, key, new IvParameterSpec(iv));
    }

    // cipher-mode-without-authentication
    void modes() throws Exception {
        // ruleid: jgates.java.cipher-mode-without-authentication
        Cipher.getInstance("AES/CBC/PKCS5Padding");
        // ruleid: jgates.java.cipher-mode-without-authentication
        Cipher.getInstance("AES/CTR/NoPadding");
        // ruleid: jgates.java.cipher-mode-without-authentication
        Cipher.getInstance("AES/CFB8/NoPadding");
        // ok: jgates.java.cipher-mode-without-authentication
        Cipher.getInstance("AES/GCM/NoPadding");
        // ok: jgates.java.cipher-mode-without-authentication
        Cipher.getInstance("ChaCha20-Poly1305");
    }

    // weak-kdf-parameters
    void kdf(char[] pw, byte[] salt) throws Exception {
        // ruleid: jgates.java.weak-kdf-parameters
        new PBEKeySpec(pw, salt, 1000, 256);
        // ruleid: jgates.java.weak-kdf-parameters
        BCrypt.gensalt(4);
        // ruleid: jgates.java.weak-kdf-parameters
        new BCryptPasswordEncoder(6);
        // ruleid: jgates.java.weak-kdf-parameters
        new SCryptPasswordEncoder(1024, 8, 1, 32, 16);
        // ruleid: jgates.java.weak-kdf-parameters
        new Argon2PasswordEncoder(16, 32, 1, 1024, 3);
        // ruleid: jgates.java.weak-kdf-parameters
        new Argon2PasswordEncoder(16, 32, 1, 65536, 1);
        // ok: jgates.java.weak-kdf-parameters
        new PBEKeySpec(pw, salt, 600000, 256);
        // ok: jgates.java.weak-kdf-parameters
        BCrypt.gensalt(12);
        // ok: jgates.java.weak-kdf-parameters
        new BCryptPasswordEncoder(12);
        // ok: jgates.java.weak-kdf-parameters
        new SCryptPasswordEncoder(32768, 8, 1, 32, 16);
        // ok: jgates.java.weak-kdf-parameters
        new Argon2PasswordEncoder(16, 32, 1, 65536, 3);
    }

    // password-hash-with-fast-hash
    void passwordHashes(String password, String salt) throws Exception {
        // ruleid: jgates.java.password-hash-with-fast-hash
        MessageDigest.getInstance("SHA-256").digest(password.getBytes());
        // ruleid: jgates.java.password-hash-with-fast-hash
        DigestUtils.sha256Hex(password + salt);
        // ruleid: jgates.java.password-hash-with-fast-hash
        Hashing.sha256().hashString(password, StandardCharsets.UTF_8);
        // ok: jgates.java.password-hash-with-fast-hash
        MessageDigest.getInstance("SHA-256").digest(fileBytes);
        // ok: jgates.java.password-hash-with-fast-hash
        DigestUtils.sha256Hex(payload);
        // ok: jgates.java.password-hash-with-fast-hash
        SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(new PBEKeySpec(password.toCharArray(), salt.getBytes(), 600000, 256));
    }

    // timing-unsafe-comparison
    boolean compare(String expectedSignature, String providedSignature, byte[] computedMac, byte[] receivedMac, String algorithm) {
        // ruleid: jgates.java.timing-unsafe-comparison
        boolean a = expectedSignature.equals(providedSignature);
        // ruleid: jgates.java.timing-unsafe-comparison
        boolean b = Arrays.equals(computedMac, receivedMac);
        // ruleid: jgates.java.timing-unsafe-comparison
        boolean c = providedSignature.equalsIgnoreCase(expectedSignature);
        // ok: jgates.java.timing-unsafe-comparison
        boolean d = MessageDigest.isEqual(computedMac, receivedMac);
        // ok: jgates.java.timing-unsafe-comparison
        boolean e = algorithm.equals("HmacSHA256");
        // ok: jgates.java.timing-unsafe-comparison
        boolean f = "signature".equals(algorithm);
        return a && b && c && d && e && f;
    }

    // weak-signature-hash
    void signatures() throws Exception {
        // ruleid: jgates.java.weak-signature-hash
        Signature.getInstance("SHA1withRSA");
        // ruleid: jgates.java.weak-signature-hash
        Signature.getInstance("MD5withRSA");
        // ruleid: jgates.java.weak-signature-hash
        Mac.getInstance("HmacSHA1");
        // ruleid: jgates.java.weak-signature-hash
        Mac.getInstance("HmacMD5");
        // ruleid: jgates.java.weak-signature-hash
        HmacUtils.hmacSha1Hex(keyBytes, dataBytes);
        // ok: jgates.java.weak-signature-hash
        Signature.getInstance("SHA256withRSA");
        // ok: jgates.java.weak-signature-hash
        Mac.getInstance("HmacSHA256");
        // ok: jgates.java.weak-signature-hash
        HmacUtils.hmacSha256Hex(keyBytes, dataBytes);
    }

    // weak-dh-parameters
    void dh() throws Exception {
        // ruleid: jgates.java.weak-dh-parameters
        KeyPairGenerator weak = KeyPairGenerator.getInstance("DH");
        weak.initialize(1024);
        // ruleid: jgates.java.weak-dh-parameters
        AlgorithmParameterGenerator paramGen = AlgorithmParameterGenerator.getInstance("DH");
        paramGen.init(512);
        // ruleid: jgates.java.weak-dh-parameters
        new DHGenParameterSpec(1024, 160);
        // ok: jgates.java.weak-dh-parameters
        KeyPairGenerator strong = KeyPairGenerator.getInstance("DH");
        strong.initialize(2048);
        // ok: jgates.java.weak-dh-parameters
        AlgorithmParameterGenerator okGen = AlgorithmParameterGenerator.getInstance("DH");
        okGen.init(3072);
        // ok: jgates.java.weak-dh-parameters
        new DHGenParameterSpec(2048, 256);
    }

    // hardcoded-encryption-key
    void keys(String fromEnv) throws Exception {
        // ruleid: jgates.java.hardcoded-encryption-key
        new SecretKeySpec("0123456789abcdef".getBytes(), "AES");
        // ruleid: jgates.java.hardcoded-encryption-key
        new SecretKeySpec(new byte[16], "AES");
        // ruleid: jgates.java.hardcoded-encryption-key
        Keys.hmacShaKeyFor(Decoders.BASE64.decode("c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0"));
        // ruleid: jgates.java.hardcoded-encryption-key
        Algorithm.HMAC256("my-signing-secret");
        // ruleid: jgates.java.hardcoded-encryption-key
        Jwts.builder().signWith(SignatureAlgorithm.HS256, "my-signing-secret");
        // ok: jgates.java.hardcoded-encryption-key
        new SecretKeySpec(System.getenv("APP_KEY").getBytes(), "AES");
        // ok: jgates.java.hardcoded-encryption-key
        new SecretKeySpec(fromEnv.getBytes(), "AES");
        // ok: jgates.java.hardcoded-encryption-key
        Algorithm.HMAC256(loadedSecret);
        // ok: jgates.java.hardcoded-encryption-key
        KeyGenerator.getInstance("AES").generateKey();
    }

    // insecure-random-for-secret
    void randoms() throws Exception {
        Random rnd = new Random();
        SecureRandom random = new SecureRandom();
        byte[] salt = new byte[16];
        byte[] goodSalt = new byte[16];
        // ruleid: jgates.java.insecure-random-for-secret
        String resetToken = Long.toHexString(new Random().nextLong());
        // ruleid: jgates.java.insecure-random-for-secret
        String sessionId = "s" + Math.random();
        // ruleid: jgates.java.insecure-random-for-secret
        int otp = ThreadLocalRandom.current().nextInt(100000, 999999);
        // ruleid: jgates.java.insecure-random-for-secret
        rnd.nextBytes(salt);
        // ruleid: jgates.java.insecure-random-for-secret
        String apiKey = RandomStringUtils.randomAlphanumeric(32);
        // ok: jgates.java.insecure-random-for-secret
        random.nextBytes(goodSalt);
        // ok: jgates.java.insecure-random-for-secret
        int pageNumber = rnd.nextInt(10);
        // ok: jgates.java.insecure-random-for-secret
        long otpValue = new SecureRandom().nextLong();
        // ok: jgates.java.insecure-random-for-secret
        double jitter = Math.random();
    }

    // uuid-as-secret-token
    void uuids() {
        // ruleid: jgates.java.uuid-as-secret-token
        String resetToken = UUID.randomUUID().toString();
        // ruleid: jgates.java.uuid-as-secret-token
        String apiKey = "k-" + UUID.randomUUID();
        // ok: jgates.java.uuid-as-secret-token
        String requestId = UUID.randomUUID().toString();
        // ok: jgates.java.uuid-as-secret-token
        String orderToken = encode(secureBytes());
    }
}
