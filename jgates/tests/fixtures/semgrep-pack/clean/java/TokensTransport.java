import com.auth0.jwt.JWT;
import com.auth0.jwt.algorithms.Algorithm;
import com.auth0.jwt.interfaces.DecodedJWT;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import java.net.URL;

class TokensTransport {
    DecodedJWT readClaims(String token, Algorithm alg) {
        return JWT.require(alg).withIssuer("https://issuer.example.com").withAudience("api").build().verify(token);
    }

    Algorithm signingAlgorithm(String secret) {
        return Algorithm.HMAC256(secret);
    }

    String keyFor(DecodedJWT decoded) {
        return decoded.getKeyId();
    }

    void keepExpiry(Object decoder) {
        decoder.setJwtValidator(JwtValidators.createDefaultWithIssuer("https://issuer.example.com"));
    }

    Object verifier(Algorithm alg) {
        return JWT.require(alg).withIssuer("https://issuer.example.com").withAudience("api").build();
    }

    String loginUrl(String clientId, String state, String challenge) {
        String url = "https://idp.example.com/authorize?response_type=code&client_id=" + clientId
            + "&state=" + state + "&code_challenge=" + challenge;
        return url;
    }

    SSLContext context() throws Exception {
        return SSLContext.getInstance("TLSv1.3");
    }

    void ciphers(SSLEngine engine) {
        engine.setEnabledCipherSuites(new String[] {"TLS_AES_256_GCM_SHA384"});
    }

    URL profile() throws Exception {
        return new URL("https://api.example.com/profile");
    }

    void clientCertificates(Object sslHostConfig) {
        sslHostConfig.setCertificateVerification("required");
    }
}
