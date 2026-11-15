import com.auth0.jwt.JWT;
import com.auth0.jwt.algorithms.Algorithm;
import com.nimbusds.jose.JWSHeader;
import io.jsonwebtoken.Jwts;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import java.net.URL;

class TokensTransport {
    Object readClaims(String token) {
        return JWT.decode(token);
    }

    Algorithm signingAlgorithm() {
        return Algorithm.none();
    }

    Object keyFor(JWSHeader header) {
        return header.getJWKURL();
    }

    void relaxExpiry(Object decoder) {
        decoder.setJwtValidator(jwt -> OAuth2TokenValidatorResult.success());
    }

    Object verifier(Algorithm alg) {
        return JWT.require(alg).withIssuer("https://issuer.example.com").build();
    }

    String loginUrl(String clientId) {
        String url = "https://idp.example.com/authorize?response_type=code&client_id=" + clientId;
        return url;
    }

    SSLContext context() throws Exception {
        return SSLContext.getInstance("TLSv1");
    }

    void ciphers(SSLEngine engine) {
        engine.setEnabledCipherSuites(new String[] {"TLS_RSA_WITH_RC4_128_SHA"});
    }

    URL profile() throws Exception {
        return new URL("http://api.example.com/profile");
    }

    void clientCertificates(Object sslHostConfig) {
        sslHostConfig.setCertificateVerification("optionalNoCA");
    }
}
