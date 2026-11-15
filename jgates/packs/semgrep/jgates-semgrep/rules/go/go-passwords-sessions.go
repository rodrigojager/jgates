package fixtures

import (
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/go-ozzo/ozzo-validation/v4"
	"github.com/pquerna/otp/totp"
	"golang.org/x/crypto/bcrypt"
)

type minShort struct {
	// ruleid: jgates.go.password-min-length-below-8
	Password string `validate:"required,min=4"`
}

type minShortBinding struct {
	// ruleid: jgates.go.password-min-length-below-8
	Senha string `binding:"required,min=6"`
}

type minOk struct {
	// ok: jgates.go.password-min-length-below-8
	Password string `validate:"required,min=12"`
}

type minOtherField struct {
	// ok: jgates.go.password-min-length-below-8
	Nickname string `validate:"required,min=2"`
}

func minLength(password string) bool {
	// ruleid: jgates.go.password-min-length-below-8
	if len(password) < 6 {
		return false
	}
	// ruleid: jgates.go.password-min-length-below-8
	if utf8.RuneCountInString(password) <= 4 {
		return false
	}
	// ok: jgates.go.password-min-length-below-8
	if len(password) < 8 {
		return false
	}
	// ok: jgates.go.password-min-length-below-8
	if len(username) < 3 {
		return false
	}
	return true
}

func ozzoMin(u *User) error {
	// ruleid: jgates.go.password-min-length-below-8
	return validation.ValidateStruct(u, validation.Field(&u.Password, validation.Length(5, 128)))
}

func ozzoMinOk(u *User) error {
	// ok: jgates.go.password-min-length-below-8
	return validation.ValidateStruct(u, validation.Field(&u.Password, validation.Length(12, 128)))
}

type maxShort struct {
	// ruleid: jgates.go.password-max-length-below-64
	Password string `validate:"required,min=12,max=20"`
}

type maxOk struct {
	// ok: jgates.go.password-max-length-below-64
	Password string `validate:"required,min=12,max=128"`
}

func maxLength(password string) bool {
	// ruleid: jgates.go.password-max-length-below-64
	if len(password) > 16 {
		return false
	}
	// ruleid: jgates.go.password-max-length-below-64
	if utf8.RuneCountInString(password) > 32 {
		return false
	}
	// ok: jgates.go.password-max-length-below-64
	if len(password) > 128 {
		return false
	}
	// ok: jgates.go.password-max-length-below-64
	if len(bio) > 16 {
		return false
	}
	return true
}

func ozzoMax(u *User) error {
	// ruleid: jgates.go.password-max-length-below-64
	return validation.ValidateStruct(u, validation.Field(&u.Password, validation.Length(12, 32)))
}

func ozzoMaxOk(u *User) error {
	// ok: jgates.go.password-max-length-below-64
	return validation.ValidateStruct(u, validation.Field(&u.Password, validation.Length(12, 128)))
}

func hashLowered(password string) ([]byte, error) {
	lowered := strings.ToLower(password)
	// ruleid: jgates.go.password-transformed-before-verify
	return bcrypt.GenerateFromPassword([]byte(lowered), 12)
}

func hashCut(password string) ([]byte, error) {
	// ruleid: jgates.go.password-transformed-before-verify
	return bcrypt.GenerateFromPassword([]byte(password[:20]), 12)
}

func compareUpper(hash []byte, password string) error {
	// ruleid: jgates.go.password-transformed-before-verify
	return bcrypt.CompareHashAndPassword(hash, []byte(strings.ToUpper(password)))
}

func hashExact(password string) ([]byte, error) {
	// ok: jgates.go.password-transformed-before-verify
	return bcrypt.GenerateFromPassword([]byte(password), 12)
}

func hashLowerUsername(username string, password string) ([]byte, error) {
	name := strings.ToLower(username)
	_ = name
	// ok: jgates.go.password-transformed-before-verify
	return bcrypt.GenerateFromPassword([]byte(password), 12)
}

func compareExact(hash []byte, password string) error {
	// ok: jgates.go.password-transformed-before-verify
	return bcrypt.CompareHashAndPassword(hash, []byte(password))
}

type Account struct {
	Role    string
	IsAdmin bool
	Name    string
}

func setRoleHTTP(w http.ResponseWriter, r *http.Request) {
	var a Account
	// ruleid: jgates.go.client-controlled-privilege
	a.Role = r.FormValue("role")
	// ruleid: jgates.go.client-controlled-privilege
	a.IsAdmin = r.URL.Query().Get("admin") == "true"
	// ok: jgates.go.client-controlled-privilege
	a.Name = r.FormValue("name")
	// ok: jgates.go.client-controlled-privilege
	a.Role = "member"
}

func setRoleGin(c *gin.Context) {
	// ruleid: jgates.go.client-controlled-privilege
	a := Account{Name: "x", Role: c.PostForm("role")}
	_ = a
	// ok: jgates.go.client-controlled-privilege
	b := Account{Name: c.PostForm("name"), Role: "member"}
	_ = b
}

func setRoleFromSession(c *gin.Context, claims Claims) {
	var a Account
	// ok: jgates.go.client-controlled-privilege
	a.Role = claims.Role
}

func totpOptions() {
	// ruleid: jgates.go.totp-window-too-wide
	_ = totp.ValidateOpts{Period: 120, Skew: 1}
	// ruleid: jgates.go.totp-window-too-wide
	_ = totp.ValidateOpts{Period: 30, Skew: 5}
	// ruleid: jgates.go.totp-window-too-wide
	_ = totp.GenerateOpts{Issuer: "app", AccountName: "a", Period: 300}
	// ok: jgates.go.totp-window-too-wide
	_ = totp.ValidateOpts{Period: 30, Skew: 1}
	// ok: jgates.go.totp-window-too-wide
	_ = totp.GenerateOpts{Issuer: "app", AccountName: "a", Period: 30}
}

type RecoveryByQuestion struct {
	// ruleid: jgates.go.secret-question-present
	SecretQuestion string
	// ruleid: jgates.go.secret-question-present
	SecurityAnswer string
}

type RecoveryByEmail struct {
	// ok: jgates.go.secret-question-present
	RecoveryEmail string
	// ok: jgates.go.secret-question-present
	ResetCodeHash string
}

func recoveryForm(r *http.Request) string {
	// ruleid: jgates.go.secret-question-present
	return r.FormValue("secret_question")
}

func recoveryFormOk(r *http.Request) string {
	// ok: jgates.go.secret-question-present
	return r.FormValue("email")
}
