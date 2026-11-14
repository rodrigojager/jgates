package fixtures

import (
	"crypto/des"
	"crypto/md5"
	"crypto/rc4"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"net/http"
)

func hashCases(data []byte) {
	// ruleid: jgates.go.weak-hash
	md5.Sum(data)
	// ruleid: jgates.go.weak-hash
	h := sha1.New()
	// ruleid: jgates.go.weak-hash
	sha1.Sum(data)
	// ok: jgates.go.weak-hash
	sha256.Sum256(data)
	// ok: jgates.go.weak-hash
	sha256.New()
	_ = h
}

func cipherCases(key []byte) {
	// ruleid: jgates.go.weak-cipher
	des.NewCipher(key)
	// ruleid: jgates.go.weak-cipher
	rc4.NewCipher(key)
	// ruleid: jgates.go.weak-cipher
	des.NewTripleDESCipher(key)
	// ok: jgates.go.weak-cipher
	aes.NewCipher(key)
	// ok: jgates.go.weak-cipher
	chacha20poly1305.New(key)
}

func tlsCases(pool *x509.CertPool) {
	// ruleid: jgates.go.tls-verification-disabled
	_ = &tls.Config{InsecureSkipVerify: true}
	// ruleid: jgates.go.tls-verification-disabled
	_ = &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true}}
	cfg := &tls.Config{}
	// ruleid: jgates.go.tls-verification-disabled
	cfg.InsecureSkipVerify = true
	// ok: jgates.go.tls-verification-disabled
	_ = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	// ok: jgates.go.tls-verification-disabled
	_ = &tls.Config{InsecureSkipVerify: false}
}

func jwtCases(tokenString string, claims jwt.MapClaims, keyFunc jwt.Keyfunc) {
	parser := jwt.NewParser()
	// ruleid: jgates.go.jwt-signature-not-verified
	parser.ParseUnverified(tokenString, claims)
	// ruleid: jgates.go.jwt-signature-not-verified
	jwt.NewParser().ParseUnverified(tokenString, claims)
	// ruleid: jgates.go.jwt-signature-not-verified
	token.SignedString(jwt.UnsafeAllowNoneSignatureType)
	// ok: jgates.go.jwt-signature-not-verified
	jwt.Parse(tokenString, keyFunc)
	// ok: jgates.go.jwt-signature-not-verified
	jwt.ParseWithClaims(tokenString, claims, keyFunc)
}
