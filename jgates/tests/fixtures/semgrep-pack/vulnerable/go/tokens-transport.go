package app

import (
	"crypto/tls"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/oauth2"
)

func keyFor(token *jwt.Token) (interface{}, error) {
	return fetchKey(token.Header["jku"].(string))
}

func newTokenParser() *jwt.Parser {
	return jwt.NewParser(jwt.WithoutClaimsValidation())
}

func loginURL(conf *oauth2.Config) string {
	return conf.AuthCodeURL("state")
}

func serverTLS() *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS10}
}

func cipherTLS() *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS12, CipherSuites: []uint16{tls.TLS_RSA_WITH_RC4_128_SHA}}
}

func fetchProfile() (*http.Response, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	return client.Get("http://api.example.com/profile")
}

func mutualTLS() *tls.Config {
	return &tls.Config{MinVersion: tls.VersionTLS12, ClientAuth: tls.RequireAnyClientCert}
}
