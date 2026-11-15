package app

import (
	"log"
	"log/slog"
	"net/http"
	"runtime/debug"
)

func loginHandler(w http.ResponseWriter, r *http.Request) {
	user := r.FormValue("user")
	password := r.FormValue("password")
	log.Printf("login attempt %s %s", user, password)
	slog.Info("login", "user", user, "password", password)
	log.Printf("auth %s", r.Header.Get("Authorization"))

	if err := authenticate(user, password); err != nil {
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func recoverHandler(w http.ResponseWriter, r *http.Request) {
	trace := debug.Stack()
	w.Write(trace)
}

func cleanup() error {
	err := removeTemp()
	if err != nil {
	}
	return nil
}

func fetchRates(url string) {
	http.Get(url)
}

func authenticate(user string, password string) error { return nil }

func removeTemp() error { return nil }
