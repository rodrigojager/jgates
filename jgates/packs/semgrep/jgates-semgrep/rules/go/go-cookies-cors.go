package fixtures

import (
	"fmt"
	"net/http"

	"github.com/gin-contrib/cors"
	"github.com/gofiber/fiber/v2"
	"github.com/gorilla/csrf"
	"github.com/gorilla/sessions"
	"github.com/gorilla/websocket"
)

func secureCases(w http.ResponseWriter) {
	// ruleid: jgates.go.cookie-without-secure
	http.SetCookie(w, &http.Cookie{Name: "__Host-a", Value: "v", HttpOnly: true, SameSite: http.SameSiteLaxMode})
	// ruleid: jgates.go.cookie-without-secure
	http.SetCookie(w, &http.Cookie{Name: "__Host-a", Value: "v", Secure: false, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	// ruleid: jgates.go.cookie-without-secure
	_ = fiber.Cookie{Name: "__Host-a", Value: "v", HTTPOnly: true, SameSite: "Lax"}
	// ruleid: jgates.go.cookie-without-secure
	_ = sessions.Options{Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode}
	// ok: jgates.go.cookie-without-secure
	http.SetCookie(w, &http.Cookie{Name: "__Host-a", Value: "v", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	// ok: jgates.go.cookie-without-secure
	_ = fiber.Cookie{Name: "__Host-a", Value: "v", Secure: true, HTTPOnly: true, SameSite: "Lax"}
}

func ginSecureCases(c *gin.Context) {
	// ruleid: jgates.go.cookie-without-secure
	c.SetCookie("__Host-a", "v", 3600, "/", "", false, true)
	// ok: jgates.go.cookie-without-secure
	c.SetCookie("__Host-a", "v", 3600, "/", "", true, true)
}

func httpOnlyCases(w http.ResponseWriter) {
	// ruleid: jgates.go.cookie-without-httponly
	http.SetCookie(w, &http.Cookie{Name: "__Host-a", Value: "v", Secure: true, SameSite: http.SameSiteLaxMode})
	// ruleid: jgates.go.cookie-without-httponly
	http.SetCookie(w, &http.Cookie{Name: "__Host-a", Value: "v", Secure: true, HttpOnly: false, SameSite: http.SameSiteLaxMode})
	// ruleid: jgates.go.cookie-without-httponly
	_ = fiber.Cookie{Name: "__Host-a", Value: "v", Secure: true, SameSite: "Lax"}
	// ruleid: jgates.go.cookie-without-httponly
	_ = sessions.Options{Path: "/", Secure: true, SameSite: http.SameSiteLaxMode}
	// ok: jgates.go.cookie-without-httponly
	http.SetCookie(w, &http.Cookie{Name: "__Host-a", Value: "v", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	// ok: jgates.go.cookie-without-httponly
	_ = sessions.Options{Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode}
}

func ginHttpOnlyCases(c *gin.Context) {
	// ruleid: jgates.go.cookie-without-httponly
	c.SetCookie("__Host-a", "v", 3600, "/", "", true, false)
	// ok: jgates.go.cookie-without-httponly
	c.SetCookie("__Host-a", "v", 3600, "/", "", true, true)
}

func sameSiteCases(w http.ResponseWriter, c *gin.Context) {
	// ruleid: jgates.go.cookie-without-samesite
	http.SetCookie(w, &http.Cookie{Name: "__Host-a", Value: "v", Secure: true, HttpOnly: true})
	// ruleid: jgates.go.cookie-without-samesite
	http.SetCookie(w, &http.Cookie{Name: "__Host-a", Value: "v", Secure: true, HttpOnly: true, SameSite: http.SameSiteNoneMode})
	// ruleid: jgates.go.cookie-without-samesite
	_ = fiber.Cookie{Name: "__Host-a", Value: "v", Secure: true, HTTPOnly: true, SameSite: "None"}
	// ruleid: jgates.go.cookie-without-samesite
	c.SetSameSite(http.SameSiteNoneMode)
	// ok: jgates.go.cookie-without-samesite
	http.SetCookie(w, &http.Cookie{Name: "__Host-a", Value: "v", Secure: true, HttpOnly: true, SameSite: http.SameSiteStrictMode})
	// ok: jgates.go.cookie-without-samesite
	c.SetSameSite(http.SameSiteLaxMode)
}

func prefixCases(w http.ResponseWriter, c *gin.Context) {
	// ruleid: jgates.go.cookie-name-without-prefix
	http.SetCookie(w, &http.Cookie{Name: "session", Value: "v", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	// ruleid: jgates.go.cookie-name-without-prefix
	c.SetCookie("sid", "v", 3600, "/", "", true, true)
	// ok: jgates.go.cookie-name-without-prefix
	http.SetCookie(w, &http.Cookie{Name: "__Host-session", Value: "v", Secure: true, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	// ok: jgates.go.cookie-name-without-prefix
	c.SetCookie("__Secure-sid", "v", 3600, "/", "", true, true)
}

func corsWildcardCases(w http.ResponseWriter) {
	// ruleid: jgates.go.cors-any-origin-with-credentials
	_ = cors.Config{AllowOrigins: []string{"*"}, AllowCredentials: true}
	// ruleid: jgates.go.cors-any-origin-with-credentials
	_ = cors.Config{AllowAllOrigins: true, AllowCredentials: true}
	// ok: jgates.go.cors-any-origin-with-credentials
	_ = cors.Config{AllowOrigins: []string{"https://app.example.com"}, AllowCredentials: true}
	// ok: jgates.go.cors-any-origin-with-credentials
	_ = cors.Config{AllowOrigins: []string{"*"}, AllowCredentials: false}
}

func corsHeaderWildcard(w http.ResponseWriter, r *http.Request) {
	// ruleid: jgates.go.cors-any-origin-with-credentials
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Credentials", "true")
}

func corsHeaderPublic(w http.ResponseWriter, r *http.Request) {
	// ok: jgates.go.cors-any-origin-with-credentials
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "application/json")
}

func corsReflectedCases(w http.ResponseWriter, r *http.Request, c *gin.Context, allowed map[string]bool) {
	origin := r.Header.Get("Origin")
	// ruleid: jgates.go.cors-origin-reflected
	w.Header().Set("Access-Control-Allow-Origin", origin)
	// ruleid: jgates.go.cors-origin-reflected
	w.Header().Set("Access-Control-Allow-Origin", r.Header.Get("Origin"))
	// ruleid: jgates.go.cors-origin-reflected
	c.Header("Access-Control-Allow-Origin", c.GetHeader("Origin"))
	if allowed[origin] {
		// ok: jgates.go.cors-origin-reflected
		w.Header().Set("Access-Control-Allow-Origin", origin)
	}
	// ok: jgates.go.cors-origin-reflected
	w.Header().Set("Access-Control-Allow-Origin", "https://app.example.com")
}

func corsAllowAllCases() {
	// ruleid: jgates.go.cors-origin-reflected-allow-all
	_ = cors.Config{AllowOriginFunc: func(origin string) bool { return true }}
	// ruleid: jgates.go.cors-origin-reflected-allow-all
	_ = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	// ok: jgates.go.cors-origin-reflected-allow-all
	_ = cors.Config{AllowOriginFunc: func(origin string) bool { return origin == "https://app.example.com" }}
	// ok: jgates.go.cors-origin-reflected-allow-all
	_ = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "https://app.example.com" }}
}

func csrfCases(r *http.Request) {
	// ruleid: jgates.go.csrf-protection-disabled
	r = csrf.UnsafeSkipCheck(r)
	// ruleid: jgates.go.csrf-protection-disabled
	_ = middleware.CSRFConfig{Skipper: func(c echo.Context) bool { return true }}
	// ok: jgates.go.csrf-protection-disabled
	_ = middleware.CSRFConfig{Skipper: func(c echo.Context) bool { return c.Path() == "/webhooks/payments" }}
	// ok: jgates.go.csrf-protection-disabled
	_ = csrf.Protect([]byte("0123456789abcdef0123456789abcdef"))
}

func jsonpCases(w http.ResponseWriter, r *http.Request, c *gin.Context, data string) {
	// ruleid: jgates.go.jsonp-enabled
	c.JSONP(200, data)
	// ruleid: jgates.go.jsonp-enabled
	fmt.Fprintf(w, "%s(%s)", r.URL.Query().Get("callback"), data)
	// ok: jgates.go.jsonp-enabled
	c.JSON(200, data)
	// ok: jgates.go.jsonp-enabled
	fmt.Fprintf(w, "%s", data)
}

func queryCases(u *url.URL, key string) {
	// ruleid: jgates.go.sensitive-query-parameter
	_ = fmt.Sprintf("https://api.example.com/v1/items?api_key=%s", key)
	// ruleid: jgates.go.sensitive-query-parameter
	_ = "https://example.com/login?user=ana&password=hunter2"
	q := u.Query()
	// ruleid: jgates.go.sensitive-query-parameter
	q.Set("client_secret", key)
	// ok: jgates.go.sensitive-query-parameter
	q.Set("page", "2")
	// ok: jgates.go.sensitive-query-parameter
	_ = fmt.Sprintf("https://api.example.com/v1/items?page=%d", 2)
	// ok: jgates.go.sensitive-query-parameter
	_ = "https://example.com/login?user=ana"
}
