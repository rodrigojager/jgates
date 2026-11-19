package app

import (
	"fmt"
	"net"
	"net/http"

	"github.com/99designs/gqlgen/graphql/handler"
	"github.com/99designs/gqlgen/graphql/handler/extension"
	"github.com/gorilla/websocket"
	"github.com/unrolled/secure"
	nhooyr "nhooyr.io/websocket"
)

func acceptSocket(w http.ResponseWriter, r *http.Request) {
	nhooyr.Accept(w, r, &nhooyr.AcceptOptions{OriginPatterns: []string{"app.example.com"}})
}

func securityMiddleware() *secure.Secure {
	return secure.New(secure.Options{FrameDeny: true, ContentTypeNosniff: true, STSSeconds: 31536000})
}

func policy(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'nonce-r4nd0m'; object-src 'none'")
}

func connectFeed() error {
	_, _, err := websocket.DefaultDialer.Dial("wss://feed.example.com/live", nil)
	return err
}

func graphqlEndpoint() {
	srv := handler.NewDefaultServer(nil)
	srv.Use(extension.FixedComplexityLimit(300))
	http.Handle("/query", srv)
}

func login(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/dashboard", http.StatusFound)
}

func audit(r *http.Request) string {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	return host
}

func resetLink(r *http.Request) string {
	return fmt.Sprintf("https://%s/reset?token=abc", "app.example.com")
}
