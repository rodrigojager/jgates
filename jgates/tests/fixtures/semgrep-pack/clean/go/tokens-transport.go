package app

import (
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/oauth2"
)

func keyFor(token *jwt.Token) (interface{}, error) {
	return trustedKeys.Lookup(token.Header["kid"].(string))
}

func newTokenParser() *jwt.Parser {
	return jwt.NewParser(jwt.WithExpirationRequired(), jwt.WithValidMethods([]string{"RS256"}))
}

func parseToken(raw string, keyFunc jwt.Keyfunc) (*jwt.Token, error) {
	return jwt.Parse(raw, keyFunc, jwt.WithValidMethods([]string{"RS256"}), jwt.WithAudience("profile-service"))
}

func loginURL(conf *oauth2.Config, state string, verifier string) string {
	return conf.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier))
}

func serverTLS() *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS12}
}

func cipherTLS() *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS12, CipherSuites: []uint16{tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384}}
}

func fetchProfile() (*http.Response, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	return client.Get("https://api.example.com/profile")
}

func mutualTLS(pool *x509.CertPool) *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS12, ClientAuth: tls.RequireAndVerifyClientCert, ClientCAs: pool}
}
