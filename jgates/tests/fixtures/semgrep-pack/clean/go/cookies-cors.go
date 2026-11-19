package app

import (
	"fmt"
	"net/http"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/csrf"
)

func login(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "__Host-session",
		Value:    token,
		Path:     "/",
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	http.SetCookie(w, &http.Cookie{Name: "__Host-legacy", Value: token, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
}

func corsConfig() cors.Config {
	return cors.Config{AllowOrigins: []string{"https://app.example.com"}, AllowCredentials: true}
}

var trusted = map[string]bool{"https://app.example.com": true}

func allowOrigin(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if trusted[origin] {
		w.Header().Set("Access-Control-Allow-Origin", origin)
	}
}

var originPolicy = cors.Config{AllowOriginFunc: func(origin string) bool { return origin == "https://app.example.com" }}

func protect(h http.Handler) http.Handler {
	return csrf.Protect([]byte("0123456789abcdef0123456789abcdef"))(h)
}

func feed(c *gin.Context) {
	c.JSON(200, gin.H{"items": []string{}})
}

func reportURL(key string) (*http.Request, error) {
	req, err := http.NewRequest("GET", "https://api.example.com/v1/report", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Api-Key", key)
	return req, fmt.Errorf("unused")
}
