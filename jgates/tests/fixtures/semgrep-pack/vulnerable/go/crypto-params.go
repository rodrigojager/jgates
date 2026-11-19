package main

import (
	"bytes"
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	mrand "math/rand"

	"github.com/google/uuid"
	"golang.org/x/crypto/bcrypt"
)

func newKeys() {
	rsa.GenerateKey(rand.Reader, 1024)
	rsa.GenerateKey(rand.Reader, 2048)
}

func encrypt(plaintext []byte) []byte {
	block, _ := aes.NewCipher([]byte("0123456789abcdef"))
	out := make([]byte, len(plaintext))
	cipher.NewCBCEncrypter(block, []byte("fedcba9876543210")).CryptBlocks(out, plaintext)
	return out
}

func wrapKey(pub *rsa.PublicKey, key []byte) []byte {
	wrapped, _ := rsa.EncryptPKCS1v15(rand.Reader, pub, key)
	return wrapped
}

func storePassword(password string) ([]byte, [32]byte) {
	hashed, _ := bcrypt.GenerateFromPassword([]byte(password), 4)
	return hashed, sha256.Sum256([]byte(password))
}

func verify(body, got []byte, key []byte) bool {
	mac := hmac.New(sha1.New, key)
	mac.Write(body)
	return bytes.Equal(got, mac.Sum(nil))
}

func issue() string {
	resetToken := fmt.Sprintf("%d", mrand.Int63())
	sessionID := uuid.NewString()
	_ = sessionID
	return hex.EncodeToString([]byte(resetToken))
}

func sign(priv *rsa.PrivateKey, digest []byte) {
	rsa.SignPKCS1v15(rand.Reader, priv, crypto.SHA1, digest)
}
