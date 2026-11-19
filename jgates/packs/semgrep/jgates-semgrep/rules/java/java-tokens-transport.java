import com.auth0.jwt.JWT;
import com.auth0.jwt.algorithms.Algorithm;
import com.nimbusds.jwt.PlainJWT;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.SignatureAlgorithm;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import java.net.URI;
import java.net.URL;
import java.net.http.HttpRequest;

class TokensTransportFixture {
    void signature(String token, java.security.Key key) throws Exception {
        // ruleid: jgates.java.jwt-signature-not-verified
        Object a = Jwts.parser().requireAudience("api").build().parseClaimsJwt(token);
        // ruleid: jgates.java.jwt-signature-not-verified
        Object b = JWT.decode(token);
        // ruleid: jgates.java.jwt-signature-not-verified
        Object c = PlainJWT.parse(token);
        // ruleid: jgates.java.jwt-signature-not-verified
        Object d = Jwts.parser().requireAudience("api").build().parseUnsecuredClaims(token);
        // ok: jgates.java.jwt-signature-not-verified
        Object e = Jwts.parser().verifyWith(key).requireAudience("api").build().parseSignedClaims(token);
        // ok: jgates.java.jwt-signature-not-verified
        Object f = JWT.require(Algorithm.HMAC256("secret")).withAudience("api").build().verify(token);
    }

    void algorithm(String token, java.security.Key key) {
        // ruleid: jgates.java.jwt-algorithm-not-restricted
        Algorithm a = Algorithm.none();
        // ruleid: jgates.java.jwt-algorithm-not-restricted
        SignatureAlgorithm b = SignatureAlgorithm.NONE;
        // ruleid: jgates.java.jwt-algorithm-not-restricted
        SignatureAlgorithm c = SignatureAlgorithm.forName(header.getAlgorithm());
        // ok: jgates.java.jwt-algorithm-not-restricted
        Algorithm d = Algorithm.HMAC256("secret");
        // ok: jgates.java.jwt-algorithm-not-restricted
        SignatureAlgorithm e = SignatureAlgorithm.forName("RS256");
        // ok: jgates.java.jwt-algorithm-not-restricted
        SignatureAlgorithm f = SignatureAlgorithm.HS256;
    }

    void keySource(com.nimbusds.jose.JWSHeader header, com.auth0.jwt.interfaces.DecodedJWT decoded) throws Exception {
        // ruleid: jgates.java.jwt-key-from-token-header
        Object a = header.getJWKURL();
        // ruleid: jgates.java.jwt-key-from-token-header
        Object b = decoded.getHeaderClaim("jku");
        // ruleid: jgates.java.jwt-key-from-token-header
        Object c = header.getJWK();
        // ok: jgates.java.jwt-key-from-token-header
        String kid = decoded.getKeyId();
        // ok: jgates.java.jwt-key-from-token-header
        Object d = new com.nimbusds.jose.jwk.source.RemoteJWKSet<>(new URL("https://issuer.example.com/jwks.json"));
    }

    void expiry(Object processor, Object decoder, Object parser) {
        // ruleid: jgates.java.jwt-expiry-not-validated
        processor.setJWTClaimsSetVerifier((claims, ctx) -> {});
        // ruleid: jgates.java.jwt-expiry-not-validated
        decoder.setJwtValidator(jwt -> OAuth2TokenValidatorResult.success());
        // ruleid: jgates.java.jwt-expiry-not-validated
        parser.setAllowedClockSkewSeconds(Long.MAX_VALUE);
        // ok: jgates.java.jwt-expiry-not-validated
        decoder.setJwtValidator(JwtValidators.createDefaultWithIssuer("https://issuer.example.com"));
        // ok: jgates.java.jwt-expiry-not-validated
        parser.setAllowedClockSkewSeconds(30);
        // ok: jgates.java.jwt-expiry-not-validated
        processor.setJWTClaimsSetVerifier(new DefaultJWTClaimsVerifier<>(null, null));
    }

    void audience(String token, Algorithm alg, java.security.Key key) {
        // ruleid: jgates.java.jwt-audience-not-validated
        Object a = JWT.require(alg).withIssuer("https://issuer.example.com").build();
        // ruleid: jgates.java.jwt-audience-not-validated
        Object b = Jwts.parser().verifyWith(key).build();
        // ok: jgates.java.jwt-audience-not-validated
        Object c = JWT.require(alg).withIssuer("https://issuer.example.com").withAudience("api").build();
        // ok: jgates.java.jwt-audience-not-validated
        Object d = Jwts.parser().verifyWith(key).requireAudience("api").build();
    }

    String oauth(String clientId, String state, String challenge) {
        // ruleid: jgates.java.oauth-request-without-state
        String a = "https://idp.example.com/authorize?response_type=code&client_id=" + clientId;
        // ruleid: jgates.java.oauth-request-without-state
        String b = String.format("https://idp.example.com/authorize?client_id=%s&response_type=code", clientId);
        // ok: jgates.java.oauth-request-without-state
        String c = "https://idp.example.com/authorize?response_type=code&client_id=" + clientId + "&state=" + state;
        // ok: jgates.java.oauth-request-without-state
        String d = "https://idp.example.com/authorize?response_type=code&client_id=" + clientId + "&code_challenge=" + challenge;
        return a + b + c + d;
    }

    void tlsVersion(SSLEngine engine, Object factory) throws Exception {
        // ruleid: jgates.java.tls-old-protocol-version
        SSLContext a = SSLContext.getInstance("TLSv1");
        // ruleid: jgates.java.tls-old-protocol-version
        engine.setEnabledProtocols(new String[] {"TLSv1.2", "TLSv1.1"});
        // ruleid: jgates.java.tls-old-protocol-version
        Object b = TlsVersion.TLS_1_0;
        // ruleid: jgates.java.tls-old-protocol-version
        System.setProperty("jdk.tls.client.protocols", "TLSv1,TLSv1.2");
        // ok: jgates.java.tls-old-protocol-version
        SSLContext c = SSLContext.getInstance("TLSv1.3");
        // ok: jgates.java.tls-old-protocol-version
        engine.setEnabledProtocols(new String[] {"TLSv1.2", "TLSv1.3"});
        // ok: jgates.java.tls-old-protocol-version
        System.setProperty("jdk.tls.client.protocols", "TLSv1.2,TLSv1.3");
    }

    void ciphers(SSLEngine engine, Object params) {
        // ruleid: jgates.java.tls-weak-cipher-suite
        engine.setEnabledCipherSuites(new String[] {"TLS_RSA_WITH_RC4_128_SHA"});
        // ruleid: jgates.java.tls-weak-cipher-suite
        params.setCipherSuites(new String[] {"TLS_AES_128_GCM_SHA256", "TLS_RSA_WITH_3DES_EDE_CBC_SHA"});
        // ok: jgates.java.tls-weak-cipher-suite
        engine.setEnabledCipherSuites(new String[] {"TLS_AES_256_GCM_SHA384", "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256"});
        // ok: jgates.java.tls-weak-cipher-suite
        params.setCipherSuites(new String[] {"TLS_AES_128_GCM_SHA256"});
    }

    void cleartext(Object restTemplate) throws Exception {
        // ruleid: jgates.java.cleartext-http-url
        URL a = new URL("http://api.example.com/profile");
        // ruleid: jgates.java.cleartext-http-url
        HttpRequest b = HttpRequest.newBuilder(URI.create("http://api.example.com/items")).build();
        // ruleid: jgates.java.cleartext-http-url
        Object c = restTemplate.getForObject("ftp://files.example.com/report", String.class);
        // ok: jgates.java.cleartext-http-url
        URL d = new URL("https://api.example.com/profile");
        // ok: jgates.java.cleartext-http-url
        URL e = new URL("http://localhost:8080/health");
        // ok: jgates.java.cleartext-http-url
        HttpRequest f = HttpRequest.newBuilder(URI.create("http://127.0.0.1:9000/ping")).build();
    }

    void clientCertificate(Object sslHostConfig, Object connector) {
        // ruleid: jgates.java.mtls-client-certificate-not-verified
        sslHostConfig.setCertificateVerification("optionalNoCA");
        // ruleid: jgates.java.mtls-client-certificate-not-verified
        connector.setProperty("certificateVerification", "optionalNoCA");
        // ruleid: jgates.java.mtls-client-certificate-not-verified
        new SslContextFactory.Server().setTrustAll(true);
        // ok: jgates.java.mtls-client-certificate-not-verified
        sslHostConfig.setCertificateVerification("required");
        // ok: jgates.java.mtls-client-certificate-not-verified
        connector.setProperty("certificateVerification", "required");
        // ok: jgates.java.mtls-client-certificate-not-verified
        new SslContextFactory.Server().setTrustAll(false);
    }
}
