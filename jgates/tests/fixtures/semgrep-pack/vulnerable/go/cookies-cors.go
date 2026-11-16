package app

import (
	"fmt"
	"net/http"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
	"github.com/gorilla/csrf"
)

func login(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{Name: "session", Value: token, Path: "/"})
	http.SetCookie(w, &http.Cookie{Name: "__Host-legacy", Value: token, Path: "/", Secure: false, HttpOnly: false, SameSite: http.SameSiteLaxMode})
}

func corsConfig() cors.Config {
	return cors.Config{AllowOrigins: []string{"*"}, AllowCredentials: true}
}

func allowOrigin(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	w.Header().Set("Access-Control-Allow-Origin", origin)
}

var originPolicy = cors.Config{AllowOriginFunc: func(origin string) bool { return true }}

func skipForgeryCheck(r *http.Request) *http.Request {
	return csrf.UnsafeSkipCheck(r)
}

func feed(c *gin.Context) {
	c.JSONP(200, gin.H{"items": []string{}})
}

func reportURL(key string) string {
	return fmt.Sprintf("https://api.example.com/v1/report?api_key=%s", key)
}
