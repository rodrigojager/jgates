package fixtures

import (
	"fmt"
	"net"
	"net/http"
	"net/url"

	"github.com/99designs/gqlgen/graphql/handler"
	"github.com/99designs/gqlgen/graphql/handler/extension"
	"github.com/gin-gonic/gin"
	"github.com/gofiber/fiber/v2"
	"github.com/gorilla/websocket"
	graphql "github.com/graph-gophers/graphql-go"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/unrolled/secure"
	nhooyr "nhooyr.io/websocket"
	xws "golang.org/x/net/websocket"
)

// security-headers-disabled
func headerMiddleware() {
	// ruleid: jgates.go.security-headers-disabled
	_ = secure.New(secure.Options{FrameDeny: false, ContentTypeNosniff: true})
	// ruleid: jgates.go.security-headers-disabled
	_ = secure.New(secure.Options{STSSeconds: 3600, FrameDeny: true})
	// ruleid: jgates.go.security-headers-disabled
	_ = middleware.SecureWithConfig(middleware.SecureConfig{ContentTypeNosniff: ""})
	// ok: jgates.go.security-headers-disabled
	_ = secure.New(secure.Options{FrameDeny: true, ContentTypeNosniff: true, STSSeconds: 31536000})
	// ok: jgates.go.security-headers-disabled
	_ = middleware.SecureWithConfig(middleware.SecureConfig{ContentTypeNosniff: "nosniff", XFrameOptions: "DENY", HSTSMaxAge: 63072000})
}

// csp-unsafe-directive
func cspHandler(w http.ResponseWriter, r *http.Request, c *gin.Context) {
	// ruleid: jgates.go.csp-unsafe-directive
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'")
	// ruleid: jgates.go.csp-unsafe-directive
	c.Header("Content-Security-Policy", "script-src * ; object-src 'none'")
	// ruleid: jgates.go.csp-unsafe-directive
	_ = secure.Options{ContentSecurityPolicy: "default-src 'self' 'unsafe-eval'"}
	// ok: jgates.go.csp-unsafe-directive
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'nonce-abc123'; object-src 'none'")
	// ok: jgates.go.csp-unsafe-directive
	c.Header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'")
	// ok: jgates.go.csp-unsafe-directive
	w.Header().Set("X-Frame-Options", "script-src 'unsafe-inline'")
}

// websocket-without-tls
func dialSockets(ctx_ interface{}) {
	// ruleid: jgates.go.websocket-without-tls
	websocket.DefaultDialer.Dial("ws://chat.example.com/feed", nil)
	// ruleid: jgates.go.websocket-without-tls
	xws.Dial("ws://10.0.0.5:8080/ws", "", "http://example.com")
	// ruleid: jgates.go.websocket-without-tls
	nhooyr.Dial(ctx_, "ws://feed.example.com/live", nil)
	// ok: jgates.go.websocket-without-tls
	websocket.DefaultDialer.Dial("wss://chat.example.com/feed", nil)
	// ok: jgates.go.websocket-without-tls
	websocket.DefaultDialer.Dial("ws://localhost:8080/feed", nil)
	// ok: jgates.go.websocket-without-tls
	xws.Dial("ws://127.0.0.1:9000/ws", "", "http://127.0.0.1")
}

// websocket-origin-not-checked
// ruleid: jgates.go.websocket-origin-not-checked
var openUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func originShapes(w http.ResponseWriter, r *http.Request) {
	var up websocket.Upgrader
	// ruleid: jgates.go.websocket-origin-not-checked
	up.CheckOrigin = func(r *http.Request) bool { return true }
	// ruleid: jgates.go.websocket-origin-not-checked
	nhooyr.Accept(w, r, &nhooyr.AcceptOptions{InsecureSkipVerify: true})
	// ok: jgates.go.websocket-origin-not-checked
	nhooyr.Accept(w, r, &nhooyr.AcceptOptions{OriginPatterns: []string{"app.example.com"}})
}

// ok: jgates.go.websocket-origin-not-checked
var strictUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return r.Header.Get("Origin") == "https://app.example.com" },
}

// ok: jgates.go.websocket-origin-not-checked
var defaultUpgrader = websocket.Upgrader{ReadBufferSize: 1024}

// graphql-introspection-enabled
func introspection() {
	var srv *handler.Server
	// ruleid: jgates.go.graphql-introspection-enabled
	srv.Use(extension.Introspection{})
	var other *handler.Server
	// ruleid: jgates.go.graphql-introspection-enabled
	other.Use(&extension.Introspection{})
	// ok: jgates.go.graphql-introspection-enabled
	srv.Use(extension.FixedComplexityLimit(200))
	// ok: jgates.go.graphql-introspection-enabled
	srv.Use(extension.AutomaticPersistedQuery{})
}

// graphql-without-depth-limit
func graphqlServers(es interface{}, schema string, resolver interface{}) {
	// ruleid: jgates.go.graphql-without-depth-limit
	http.Handle("/query", handler.NewDefaultServer(nil))
	// ruleid: jgates.go.graphql-without-depth-limit
	_ = graphql.MustParseSchema(schema, resolver)
	// ruleid: jgates.go.graphql-without-depth-limit
	plain := handler.NewDefaultServer(nil)
	_ = plain
	// ok: jgates.go.graphql-without-depth-limit
	_ = graphql.MustParseSchema(schema, resolver, graphql.MaxDepth(10))
	// ok: jgates.go.graphql-without-depth-limit
	limited := handler.NewDefaultServer(nil)
	limited.Use(extension.FixedComplexityLimit(300))
}

// open-redirect
func redirectHandler(w http.ResponseWriter, r *http.Request) {
	// ruleid: jgates.go.open-redirect
	http.Redirect(w, r, r.URL.Query().Get("next"), http.StatusFound)
	dest := r.FormValue("return_to")
	// ruleid: jgates.go.open-redirect
	http.Redirect(w, r, dest, http.StatusSeeOther)
	// ok: jgates.go.open-redirect
	http.Redirect(w, r, "/dashboard", http.StatusFound)
	// ok: jgates.go.open-redirect
	http.Redirect(w, r, "/login?from="+url.QueryEscape(r.URL.Path), http.StatusFound)
}

func redirectGin(c *gin.Context) {
	// ruleid: jgates.go.open-redirect
	c.Redirect(302, c.Query("next"))
	// ok: jgates.go.open-redirect
	c.Redirect(302, "/home")
}

func redirectEcho(c echo.Context) error {
	// ruleid: jgates.go.open-redirect
	return c.Redirect(302, c.QueryParam("to"))
}

func redirectFiber(c *fiber.Ctx) error {
	// ruleid: jgates.go.open-redirect
	return c.Redirect(c.Query("to"))
}

// client-ip-from-forwarded-header
func clientIP(r *http.Request, c *gin.Context, f *fiber.Ctx) {
	// ruleid: jgates.go.client-ip-from-forwarded-header
	ip := r.Header.Get("X-Forwarded-For")
	_ = ip
	// ruleid: jgates.go.client-ip-from-forwarded-header
	_ = c.GetHeader("X-Real-IP")
	// ruleid: jgates.go.client-ip-from-forwarded-header
	_ = f.Get("X-Forwarded-For")
	// ok: jgates.go.client-ip-from-forwarded-header
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	_ = host
	// ok: jgates.go.client-ip-from-forwarded-header
	_ = c.ClientIP()
	// ok: jgates.go.client-ip-from-forwarded-header
	_ = r.Header.Get("User-Agent")
}

// host-header-in-url
func hostLinks(w http.ResponseWriter, r *http.Request) {
	// ruleid: jgates.go.host-header-in-url
	link := fmt.Sprintf("https://%s/reset?token=abc", r.Host)
	_ = link
	// ruleid: jgates.go.host-header-in-url
	base := "https://" + r.Host + "/verify"
	_ = base
	// ruleid: jgates.go.host-header-in-url
	u := url.URL{Scheme: "https", Host: r.Host, Path: "/cb"}
	_ = u
	// ok: jgates.go.host-header-in-url
	fixed := fmt.Sprintf("https://%s/reset?token=abc", "app.example.com")
	_ = fixed
	// ok: jgates.go.host-header-in-url
	log := fmt.Sprintf("request for host %s", r.Host)
	_ = log
}
