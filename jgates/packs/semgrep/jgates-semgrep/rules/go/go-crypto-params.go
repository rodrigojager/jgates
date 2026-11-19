package fixtures

import (
	"bytes"
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"crypto/dsa"
	"crypto/hmac"
	"crypto/md5"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/hex"
	"io"
	mrand "math/rand"
	"net/http"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/bcrypt"
	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/crypto/pbkdf2"
	"golang.org/x/crypto/scrypt"
)

func keySizeCases() {
	// ruleid: jgates.go.weak-key-size
	rsa.GenerateKey(rand.Reader, 1024)
	// ruleid: jgates.go.weak-key-size
	rsa.GenerateKey(rand.Reader, 512)
	// ruleid: jgates.go.weak-key-size
	rsa.GenerateMultiPrimeKey(rand.Reader, 3, 1024)
	var params dsa.Parameters
	// ruleid: jgates.go.weak-key-size
	dsa.GenerateParameters(&params, rand.Reader, dsa.L1024N160)
	// ok: jgates.go.weak-key-size
	rsa.GenerateKey(rand.Reader, 3072)
	// ok: jgates.go.weak-key-size
	rsa.GenerateKey(rand.Reader, 4096)
	// ok: jgates.go.weak-key-size
	dsa.GenerateParameters(&params, rand.Reader, dsa.L2048N256)
}

func keyBelow3072Cases() {
	// ruleid: jgates.go.rsa-key-below-3072
	rsa.GenerateKey(rand.Reader, 2048)
	// ruleid: jgates.go.rsa-key-below-3072
	rsa.GenerateKey(rand.Reader, 3000)
	// ok: jgates.go.rsa-key-below-3072
	rsa.GenerateKey(rand.Reader, 3072)
	// ok: jgates.go.rsa-key-below-3072
	rsa.GenerateKey(rand.Reader, 4096)
}

func staticIvCases(block cipher.Block, gcm cipher.AEAD, plaintext []byte) {
	// ruleid: jgates.go.static-iv-or-nonce, jgates.go.cipher-mode-without-authentication
	cipher.NewCBCEncrypter(block, []byte("0123456789abcdef"))
	// ruleid: jgates.go.static-iv-or-nonce, jgates.go.cipher-mode-without-authentication
	cipher.NewCTR(block, make([]byte, 16))
	// ruleid: jgates.go.static-iv-or-nonce
	gcm.Seal(nil, []byte("fixed-nonce!"), plaintext, nil)
	// ruleid: jgates.go.static-iv-or-nonce
	gcm.Open(nil, []byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}, plaintext, nil)
}

func staticIvVariableCases(block cipher.Block) {
	iv := []byte("0123456789abcdef")
	// ruleid: jgates.go.static-iv-or-nonce, jgates.go.cipher-mode-without-authentication
	cipher.NewCFBEncrypter(block, iv)
}

func zeroNonceCases(gcm cipher.AEAD, plaintext []byte) {
	zeroNonce := make([]byte, gcm.NonceSize())
	// ruleid: jgates.go.static-iv-or-nonce
	gcm.Seal(nil, zeroNonce, plaintext, nil)
}

func freshNonceReadFull(gcm cipher.AEAD, plaintext []byte) {
	nonce := make([]byte, gcm.NonceSize())
	io.ReadFull(rand.Reader, nonce)
	// ok: jgates.go.static-iv-or-nonce
	gcm.Seal(nil, nonce, plaintext, nil)
	// ok: jgates.go.static-iv-or-nonce
	gcm.Open(nil, nonce, plaintext, nil)
}

func freshIvInIf(block cipher.Block) {
	iv2 := make([]byte, aes.BlockSize)
	if _, err := io.ReadFull(rand.Reader, iv2); err != nil {
		return
	}
	// ruleid: jgates.go.cipher-mode-without-authentication
	cipher.NewCBCEncrypter(block, iv2)
}

func freshIvSlice(block cipher.Block, plaintext []byte) {
	out := make([]byte, aes.BlockSize+len(plaintext))
	// ruleid: jgates.go.cipher-mode-without-authentication
	cipher.NewCTR(block, out[:aes.BlockSize])
}

func freshIvRandRead(block cipher.Block) {
	iv3 := make([]byte, aes.BlockSize)
	rand.Read(iv3)
	// ruleid: jgates.go.cipher-mode-without-authentication
	cipher.NewOFB(block, iv3)
}

func modeCases(block cipher.Block, iv []byte, gcm cipher.AEAD) {
	// ruleid: jgates.go.cipher-mode-without-authentication
	cipher.NewCBCEncrypter(block, iv)
	// ruleid: jgates.go.cipher-mode-without-authentication
	cipher.NewCTR(block, iv)
	// ruleid: jgates.go.cipher-mode-without-authentication
	cipher.NewCFBDecrypter(block, iv)
	// ok: jgates.go.cipher-mode-without-authentication
	cipher.NewGCM(block)
	// ok: jgates.go.cipher-mode-without-authentication
	chacha20poly1305.New(iv)
}

func weakModeCases(pub *rsa.PublicKey, priv *rsa.PrivateKey, msg []byte) {
	// ruleid: jgates.go.weak-cipher-mode
	rsa.EncryptPKCS1v15(rand.Reader, pub, msg)
	// ruleid: jgates.go.weak-cipher-mode
	rsa.DecryptPKCS1v15(rand.Reader, priv, msg)
	// ruleid: jgates.go.weak-cipher-mode
	rsa.DecryptPKCS1v15SessionKey(rand.Reader, priv, msg, msg)
	// ok: jgates.go.weak-cipher-mode
	rsa.EncryptOAEP(sha256.New(), rand.Reader, pub, msg, nil)
	// ok: jgates.go.weak-cipher-mode
	rsa.DecryptOAEP(sha256.New(), rand.Reader, priv, msg, nil)
}

func kdfCases(pw, salt []byte) {
	// ruleid: jgates.go.weak-kdf-parameters
	pbkdf2.Key(pw, salt, 1000, 32, sha256.New)
	// ruleid: jgates.go.weak-kdf-parameters
	pbkdf2.Key(sha256.New, pw, salt, 4096, 32)
	// ruleid: jgates.go.weak-kdf-parameters
	bcrypt.GenerateFromPassword(pw, 4)
	// ruleid: jgates.go.weak-kdf-parameters
	bcrypt.GenerateFromPassword(pw, bcrypt.MinCost)
	// ruleid: jgates.go.weak-kdf-parameters
	scrypt.Key(pw, salt, 1024, 8, 1, 32)
	// ruleid: jgates.go.weak-kdf-parameters
	argon2.IDKey(pw, salt, 1, 64*1024, 4, 32)
	// ruleid: jgates.go.weak-kdf-parameters
	argon2.IDKey(pw, salt, 3, 1024, 4, 32)
	// ok: jgates.go.weak-kdf-parameters
	pbkdf2.Key(pw, salt, 600000, 32, sha256.New)
	// ok: jgates.go.weak-kdf-parameters
	pbkdf2.Key(sha256.New, pw, salt, 600000, 32)
	// ok: jgates.go.weak-kdf-parameters
	bcrypt.GenerateFromPassword(pw, 12)
	// ok: jgates.go.weak-kdf-parameters
	bcrypt.GenerateFromPassword(pw, bcrypt.DefaultCost)
	// ok: jgates.go.weak-kdf-parameters
	scrypt.Key(pw, salt, 32768, 8, 1, 32)
	// ok: jgates.go.weak-kdf-parameters
	argon2.IDKey(pw, salt, 2, 64*1024, 4, 32)
}

func fastHashCases(password string, user struct{ Password string }) {
	// ruleid: jgates.go.password-hash-with-fast-hash
	sha256.Sum256([]byte(password))
	// ruleid: jgates.go.password-hash-with-fast-hash
	md5.Sum([]byte(user.Password))
	// ruleid: jgates.go.password-hash-with-fast-hash
	sha1.Sum([]byte(password + "pepper"))
	// ruleid: jgates.go.password-hash-with-fast-hash
	h := sha256.New()
	h.Write([]byte(password))
	// ok: jgates.go.password-hash-with-fast-hash
	bcrypt.GenerateFromPassword([]byte(password), 12)
	// ok: jgates.go.password-hash-with-fast-hash
	sha256.Sum256([]byte("a file body"))
}

func compareCases(mac, expectedMAC, sig []byte, r *http.Request, h hmacHasher) {
	// ruleid: jgates.go.timing-unsafe-comparison
	_ = bytes.Equal(mac, expectedMAC)
	// ruleid: jgates.go.timing-unsafe-comparison
	_ = hex.EncodeToString(h.Sum(nil)) == r.URL.Query().Get("sig")
	// ruleid: jgates.go.timing-unsafe-comparison
	_ = string(h.Sum(nil)) == r.FormValue("x")
	// ruleid: jgates.go.timing-unsafe-comparison
	_ = r.Header.Get("X-Hub-Signature-256") == expectedMAC
	// ruleid: jgates.go.timing-unsafe-comparison
	_ = bytes.Equal(h.Sum(nil), sig)
	// ok: jgates.go.timing-unsafe-comparison
	_ = hmac.Equal(mac, expectedMAC)
	// ok: jgates.go.timing-unsafe-comparison
	_ = subtle.ConstantTimeCompare(mac, expectedMAC) == 1
	// ok: jgates.go.timing-unsafe-comparison
	_ = len(mac) == 32
}

func weakSignatureCases(key []byte, priv *rsa.PrivateKey, pub *rsa.PublicKey, digest, sigBytes []byte) {
	// ruleid: jgates.go.weak-signature-hash
	hmac.New(md5.New, key)
	// ruleid: jgates.go.weak-signature-hash
	hmac.New(sha1.New, key)
	// ruleid: jgates.go.weak-signature-hash
	rsa.SignPKCS1v15(rand.Reader, priv, crypto.SHA1, digest)
	// ruleid: jgates.go.weak-signature-hash
	rsa.VerifyPKCS1v15(pub, crypto.MD5, digest, sigBytes)
	// ruleid: jgates.go.weak-signature-hash
	_ = x509.Certificate{SignatureAlgorithm: x509.SHA1WithRSA}
	// ok: jgates.go.weak-signature-hash
	hmac.New(sha256.New, key)
	// ok: jgates.go.weak-signature-hash
	rsa.SignPKCS1v15(rand.Reader, priv, crypto.SHA256, digest)
	// ok: jgates.go.weak-signature-hash
	_ = x509.Certificate{SignatureAlgorithm: x509.SHA256WithRSA}
}

func hardcodedKeyCases(token *jwt.Token, plaintext []byte) {
	// ruleid: jgates.go.hardcoded-encryption-key
	aes.NewCipher([]byte("0123456789abcdef"))
	// ruleid: jgates.go.hardcoded-encryption-key
	hmac.New(sha256.New, []byte("my-hmac-secret"))
	// ruleid: jgates.go.hardcoded-encryption-key
	token.SignedString([]byte("jwt-signing-secret"))
	// ruleid: jgates.go.hardcoded-encryption-key
	chacha20poly1305.New([]byte("0123456789abcdef0123456789abcdef"))
	// ruleid: jgates.go.hardcoded-encryption-key
	aesKey := []byte("0123456789abcdef")
	aes.NewCipher(aesKey)
	// ok: jgates.go.hardcoded-encryption-key
	aes.NewCipher(loadKey())
	// ok: jgates.go.hardcoded-encryption-key
	hmac.New(sha256.New, []byte(os.Getenv("HMAC_KEY")))
	// ok: jgates.go.hardcoded-encryption-key
	token.SignedString(signingKey)
}

func randomCases() {
	// ruleid: jgates.go.insecure-random-for-secret
	token := fmt.Sprintf("%d", mrand.Int63())
	// ruleid: jgates.go.insecure-random-for-secret
	resetCode := mrand.Intn(1000000)
	// ruleid: jgates.go.insecure-random-for-secret
	sessionID = strconv.Itoa(mrand.Int())
	// ruleid: jgates.go.insecure-random-for-secret
	_ = Account{Token: strconv.FormatInt(mrand.Int63(), 16)}
	// ok: jgates.go.insecure-random-for-secret
	buf := make([]byte, 32)
	rand.Read(buf)
	// ok: jgates.go.insecure-random-for-secret
	apiKey := hex.EncodeToString(buf)
	// ok: jgates.go.insecure-random-for-secret
	n, _ := rand.Int(rand.Reader, big.NewInt(1000000))
	// ok: jgates.go.insecure-random-for-secret
	delay := mrand.Intn(100)
	// ok: jgates.go.insecure-random-for-secret
	secretValue := rand.Int(rand.Reader, max)
}

func uuidCases() {
	// ruleid: jgates.go.uuid-as-secret-token
	resetToken := uuid.NewString()
	// ruleid: jgates.go.uuid-as-secret-token
	apiKey = uuid.New().String()
	// ruleid: jgates.go.uuid-as-secret-token
	_ = Account{SessionID: uuid.NewString()}
	// ok: jgates.go.uuid-as-secret-token
	requestID := uuid.NewString()
	// ok: jgates.go.uuid-as-secret-token
	orderID := uuid.New().String()
	// ok: jgates.go.uuid-as-secret-token
	buf := make([]byte, 32)
	rand.Read(buf)
}
