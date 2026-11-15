package main

import (
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"

	"golang.org/x/crypto/bcrypt"
)

func newKeys() {
	rsa.GenerateKey(rand.Reader, 3072)
	rsa.GenerateKey(rand.Reader, 4096)
}

func encrypt(plaintext []byte) []byte {
	block, _ := aes.NewCipher([]byte(os.Getenv("DATA_KEY")))
	gcm, _ := cipher.NewGCM(block)
	nonce := make([]byte, gcm.NonceSize())
	io.ReadFull(rand.Reader, nonce)
	return gcm.Seal(nonce, nonce, plaintext, nil)
}

func wrapKey(pub *rsa.PublicKey, key []byte) []byte {
	wrapped, _ := rsa.EncryptOAEP(sha256.New(), rand.Reader, pub, key, nil)
	return wrapped
}

func storePassword(password string) ([]byte, [32]byte) {
	hashed, _ := bcrypt.GenerateFromPassword([]byte(password), 12)
	return hashed, sha256.Sum256([]byte("a file body"))
}

func verify(body, got []byte, key []byte) bool {
	mac := hmac.New(sha256.New, key)
	mac.Write(body)
	expected := mac.Sum(nil)
	return hmac.Equal(got, expected)
}

func issue() string {
	buf := make([]byte, 32)
	rand.Read(buf)
	resetToken := hex.EncodeToString(buf)
	return resetToken
}

func sign(priv *rsa.PrivateKey, digest []byte) {
	rsa.SignPKCS1v15(rand.Reader, priv, crypto.SHA256, digest)
}
