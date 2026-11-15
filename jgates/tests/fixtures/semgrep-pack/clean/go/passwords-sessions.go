package app

import (
	"net/http"
	"time"

	"github.com/pquerna/otp/totp"
	"golang.org/x/crypto/bcrypt"
)

type SignupForm struct {
	Email    string
	Password string `validate:"required,min=12,max=128"`
}

type Account struct {
	Role          string
	RecoveryEmail string
}

func withinLimit(password string) bool {
	return len(password) <= 128
}

func hashPassword(password string) ([]byte, error) {
	return bcrypt.GenerateFromPassword([]byte(password), 12)
}

func promote(w http.ResponseWriter, r *http.Request) {
	var a Account
	a.Role = "member"
	_ = a
}

func totpCheck(code string, secret string) (bool, error) {
	return totp.ValidateCustom(code, secret, time.Now(), totp.ValidateOpts{Period: 30, Skew: 1})
}
