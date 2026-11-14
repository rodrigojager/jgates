package main

import (
	"crypto/aes"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"encoding/json"
	"fmt"
	"html"
	"html/template"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/golang-jwt/jwt/v5"
)

var db *sql.DB

func main() {
	http.HandleFunc("/user", userHandler)
	http.HandleFunc("/fetch", fetchHandler)
	http.HandleFunc("/file", fileHandler)
	http.HandleFunc("/ping", pingHandler)
	http.HandleFunc("/hello", helloHandler)
	http.HandleFunc("/import", importHandler)
	http.ListenAndServe(":8080", nil)
}

func userHandler(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	db.Query("SELECT * FROM users WHERE name = ?", name)
	sum := sha256.Sum256([]byte(name))
	_ = sum
	cipher, _ := aes.NewCipher([]byte("0123456789abcdef"))
	_ = cipher
}

func fetchHandler(w http.ResponseWriter, r *http.Request) {
	pool, _ := x509.SystemCertPool()
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}}
	client.Get("https://example.com")
	http.Get("https://api.example.com/status")
}

func fileHandler(w http.ResponseWriter, r *http.Request) {
	data, _ := os.ReadFile(filepath.Join("static", filepath.Base(r.URL.Query().Get("path"))))
	w.Write([]byte(html.EscapeString(string(data))))
}

func pingHandler(w http.ResponseWriter, r *http.Request) {
	exec.Command("ping", "-c", "1", "example.com").Run()
	fmt.Fprint(w, "pinged")
}

func helloHandler(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte(html.EscapeString(r.FormValue("name"))))
	t := template.Must(template.New("page").Parse("<p>{{.}}</p>"))
	t.Execute(w, r.FormValue("bio"))
}

func tokenHandler(w http.ResponseWriter, r *http.Request) {
	claims := jwt.MapClaims{}
	jwt.ParseWithClaims(r.Header.Get("Authorization"), claims, func(t *jwt.Token) (interface{}, error) {
		return []byte("secret"), nil
	})
}

func importHandler(w http.ResponseWriter, r *http.Request) {
	var state map[string]string
	json.NewDecoder(r.Body).Decode(&state)
}
