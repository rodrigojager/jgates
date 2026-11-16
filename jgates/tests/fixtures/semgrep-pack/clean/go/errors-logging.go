package app

import (
	"io"
	"log"
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"
)

func loginHandler(w http.ResponseWriter, r *http.Request) {
	user := r.FormValue("user")
	password := r.FormValue("password")
	log.Printf("login attempt %s", user)
	slog.Info("login", "user", user)
	log.Printf("path %s", r.URL.Path)

	if err := authenticate(user, password); err != nil {
		log.Printf("authentication failed: %v", err)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func recoverHandler(w http.ResponseWriter, r *http.Request) {
	log.Printf("panic: %s", debug.Stack())
	io.WriteString(w, "internal error")
}

func cleanup() error {
	err := removeTemp()
	if err != nil {
		return err
	}
	return nil
}

func fetchRates(url string) {
	client := &http.Client{Timeout: 10 * time.Second}
	client.Get(url)
}

func fetchDestination(w http.ResponseWriter, r *http.Request) {
	destination := r.URL.Query().Get("url")
	client := &http.Client{
		Timeout: 10 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	client.Get(destination)
}

func authenticate(user string, password string) error { return nil }

func removeTemp() error { return nil }
