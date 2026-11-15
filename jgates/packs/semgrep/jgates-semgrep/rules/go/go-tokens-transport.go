package fixtures

import (
	"crypto/tls"
	"crypto/x509"
	"net/http"
)

func keyFromHeaderCases(token *jwt.Token, sig jose.Signature) {
	// ruleid: jgates.go.jwt-key-from-token-header
	_ = token.Header["jku"]
	// ruleid: jgates.go.jwt-key-from-token-header
	_ = token.Header["x5u"]
	// ruleid: jgates.go.jwt-key-from-token-header
	_ = token.Header["jwk"]
	// ruleid: jgates.go.jwt-key-from-token-header
	_ = sig.Header.JSONWebKey
	// ok: jgates.go.jwt-key-from-token-header
	_ = token.Header["kid"]
	// ok: jgates.go.jwt-key-from-token-header
	_ = token.Header["alg"]
}

func expiryCases(tokenString string, keyFunc jwt.Keyfunc) {
	// ruleid: jgates.go.jwt-expiry-not-validated
	jwt.NewParser(jwt.WithoutClaimsValidation())
	// ruleid: jgates.go.jwt-expiry-not-validated
	_ = &jwt.Parser{SkipClaimsValidation: true}
	p := &jwt.Parser{}
	// ruleid: jgates.go.jwt-expiry-not-validated
	p.SkipClaimsValidation = true
	// ok: jgates.go.jwt-expiry-not-validated
	jwt.NewParser(jwt.WithExpirationRequired())
	// ok: jgates.go.jwt-expiry-not-validated
	_ = &jwt.Parser{SkipClaimsValidation: false}
	// ok: jgates.go.jwt-expiry-not-validated
	jwt.Parse(tokenString, keyFunc, jwt.WithValidMethods([]string{"RS256"}))
}

func oauthStateCases(conf *oauth2.Config, state string, verifier string) {
	// ruleid: jgates.go.oauth-request-without-state
	_ = conf.AuthCodeURL("")
	// ruleid: jgates.go.oauth-request-without-state
	_ = conf.AuthCodeURL("state", oauth2.AccessTypeOffline)
	// ruleid: jgates.go.oauth-request-without-state
	_ = "https://idp.example.com/authorize?client_id=abc&response_type=code&redirect_uri=https%3A%2F%2Fapp.example.com%2Fcb"
	// ok: jgates.go.oauth-request-without-state
	_ = conf.AuthCodeURL(state)
	// ok: jgates.go.oauth-request-without-state
	_ = conf.AuthCodeURL("", oauth2.S256ChallengeOption(verifier))
	// ok: jgates.go.oauth-request-without-state
	_ = "https://idp.example.com/authorize?client_id=abc&response_type=code&state=xyz"
}

func tlsVersionCases() {
	// ruleid: jgates.go.tls-old-protocol-version
	_ = &tls.Config{MinVersion: tls.VersionTLS10}
	// ruleid: jgates.go.tls-old-protocol-version
	_ = &tls.Config{MinVersion: tls.VersionTLS12, MaxVersion: tls.VersionTLS11}
	cfg := &tls.Config{}
	// ruleid: jgates.go.tls-old-protocol-version
	cfg.MinVersion = tls.VersionSSL30
	// ok: jgates.go.tls-old-protocol-version
	_ = &tls.Config{MinVersion: tls.VersionTLS12}
	// ok: jgates.go.tls-old-protocol-version
	_ = &tls.Config{MinVersion: tls.VersionTLS13, MaxVersion: tls.VersionTLS13}
}

func tlsCipherCases() {
	// ruleid: jgates.go.tls-weak-cipher-suite
	_ = &tls.Config{CipherSuites: []uint16{tls.TLS_RSA_WITH_RC4_128_SHA}}
	// ruleid: jgates.go.tls-weak-cipher-suite
	_ = &tls.Config{CipherSuites: []uint16{tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256, tls.TLS_RSA_WITH_3DES_EDE_CBC_SHA}}
	// ruleid: jgates.go.tls-weak-cipher-suite
	_ = tls.InsecureCipherSuites()
	// ok: jgates.go.tls-weak-cipher-suite
	_ = &tls.Config{CipherSuites: []uint16{tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384, tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256}}
	// ok: jgates.go.tls-weak-cipher-suite
	_ = tls.CipherSuites()
}

func cleartextCases(client *http.Client) {
	// ruleid: jgates.go.cleartext-http-url
	http.Get("http://api.example.com/data")
	// ruleid: jgates.go.cleartext-http-url
	http.NewRequest("GET", "http://api.example.com/data", nil)
	// ruleid: jgates.go.cleartext-http-url
	client.Post("http://api.example.com/data", "text/plain", nil)
	// ok: jgates.go.cleartext-http-url
	http.Get("https://api.example.com/data")
	// ok: jgates.go.cleartext-http-url
	http.Get("http://localhost:8080/health")
	// ok: jgates.go.cleartext-http-url
	http.NewRequest("GET", "http://127.0.0.1:9000/ping", nil)
}

func mtlsCases(pool *x509.CertPool, verify func([][]byte, [][]*x509.Certificate) error) {
	// ruleid: jgates.go.mtls-client-certificate-not-verified
	_ = &tls.Config{ClientAuth: tls.RequestClientCert}
	// ruleid: jgates.go.mtls-client-certificate-not-verified
	_ = &tls.Config{MinVersion: tls.VersionTLS12, ClientAuth: tls.RequireAnyClientCert}
	// ok: jgates.go.mtls-client-certificate-not-verified
	_ = &tls.Config{ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: pool}
	// ok: jgates.go.mtls-client-certificate-not-verified
	_ = &tls.Config{ClientAuth: tls.RequireAnyClientCert, VerifyPeerCertificate: verify}
}
