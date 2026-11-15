package app

import (
	"net/http"
	"strings"

	"github.com/pquerna/otp/totp"
	"golang.org/x/crypto/bcrypt"
)

type SignupForm struct {
	Email    string
	Password string `validate:"required,min=4"`
}

type Account struct {
	Role           string
	SecretQuestion string
}

func tooLong(password string) bool {
	return len(password) > 20
}

func hashPassword(password string) ([]byte, error) {
	normalized := strings.ToLower(password)
	return bcrypt.GenerateFromPassword([]byte(normalized), 12)
}

func promote(w http.ResponseWriter, r *http.Request) {
	var a Account
	a.Role = r.FormValue("role")
	_ = a
}

func totpCheck(code string, secret string) (bool, error) {
	return totp.ValidateCustom(code, secret, time.Now(), totp.ValidateOpts{Period: 30, Skew: 5})
}
