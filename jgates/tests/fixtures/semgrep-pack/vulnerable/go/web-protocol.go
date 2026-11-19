package app

import (
	"fmt"
	"net/http"

	"github.com/99designs/gqlgen/graphql/handler"
	"github.com/99designs/gqlgen/graphql/handler/extension"
	"github.com/gorilla/websocket"
	"github.com/unrolled/secure"
	nhooyr "nhooyr.io/websocket"
)

func acceptSocket(w http.ResponseWriter, r *http.Request) {
	nhooyr.Accept(w, r, &nhooyr.AcceptOptions{InsecureSkipVerify: true})
}

func securityMiddleware() *secure.Secure {
	return secure.New(secure.Options{FrameDeny: false, ContentTypeNosniff: true})
}

func policy(w http.ResponseWriter) {
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'")
}

func connectFeed() error {
	_, _, err := websocket.DefaultDialer.Dial("ws://feed.example.com/live", nil)
	return err
}

func graphqlEndpoint() {
	srv := handler.NewDefaultServer(nil)
	srv.Use(extension.Introspection{})
	http.Handle("/query", srv)
}

func login(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, r.URL.Query().Get("next"), http.StatusFound)
}

func audit(r *http.Request) string {
	return r.Header.Get("X-Forwarded-For")
}

func resetLink(r *http.Request) string {
	return fmt.Sprintf("https://%s/reset?token=abc", r.Host)
}
