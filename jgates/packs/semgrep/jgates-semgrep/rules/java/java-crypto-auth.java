import java.security.MessageDigest;
import javax.crypto.Cipher;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.X509TrustManager;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import org.apache.commons.codec.digest.DigestUtils;

class CryptoAuthFixture {
    void hash(byte[] data) throws Exception {
        // ruleid: jgates.java.weak-hash
        MessageDigest.getInstance("MD5");
        // ruleid: jgates.java.weak-hash
        MessageDigest.getInstance("SHA-1");
        // ruleid: jgates.java.weak-hash
        DigestUtils.md5Hex(data);
        // ok: jgates.java.weak-hash
        MessageDigest.getInstance("SHA-256");
        // ok: jgates.java.weak-hash
        DigestUtils.sha256Hex(data);
    }

    void cipher() throws Exception {
        // ruleid: jgates.java.weak-cipher
        Cipher.getInstance("DES/CBC/PKCS5Padding");
        // ruleid: jgates.java.weak-cipher
        Cipher.getInstance("AES/ECB/PKCS5Padding");
        // ruleid: jgates.java.weak-cipher
        Cipher.getInstance("AES");
        // ok: jgates.java.weak-cipher
        Cipher.getInstance("AES/GCM/NoPadding");
        // ok: jgates.java.weak-cipher
        Cipher.getInstance("ChaCha20-Poly1305");
    }

    void tls() {
        // ruleid: jgates.java.tls-verification-disabled
        X509TrustManager acceptAll = new X509TrustManager() {
            public void checkClientTrusted(X509Certificate[] chain, String authType) { }
            public void checkServerTrusted(X509Certificate[] chain, String authType) { }
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        // ruleid: jgates.java.tls-verification-disabled
        HttpsURLConnection.setDefaultHostnameVerifier((host, session) -> true);
        // ok: jgates.java.tls-verification-disabled
        HttpsURLConnection.setDefaultHostnameVerifier((host, session) -> host.equals("api.example.com"));
    }

    // ruleid: jgates.java.tls-verification-disabled
    static class TrustEveryone implements X509TrustManager {
        public void checkClientTrusted(X509Certificate[] chain, String authType) { }
        public void checkServerTrusted(X509Certificate[] chain, String authType) { }
        public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
    }

    // ok: jgates.java.tls-verification-disabled
    static class StrictTrust implements X509TrustManager {
        private final X509TrustManager delegate;

        StrictTrust(X509TrustManager delegate) { this.delegate = delegate; }

        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            delegate.checkClientTrusted(chain, authType);
        }

        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            delegate.checkServerTrusted(chain, authType);
        }

        public X509Certificate[] getAcceptedIssuers() { return delegate.getAcceptedIssuers(); }
    }

    void csrf(Object http) throws Exception {
        // ruleid: jgates.java.csrf-protection-disabled
        http.csrf().disable();
        // ruleid: jgates.java.csrf-protection-disabled
        http.csrf(c -> c.disable());
        // ok: jgates.java.csrf-protection-disabled
        http.csrf();
        // ok: jgates.java.csrf-protection-disabled
        http.authorizeRequests();
    }
}
