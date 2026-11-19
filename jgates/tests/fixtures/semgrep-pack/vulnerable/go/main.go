package main

import (
	"crypto/des"
	"crypto/md5"
	"crypto/tls"
	"database/sql"
	"encoding/gob"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"html/template"
	texttemplate "text/template"

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
	db.Query(fmt.Sprintf("SELECT * FROM users WHERE name = '%s'", name))
	sum := md5.Sum([]byte(name))
	_ = sum
	cipher, _ := des.NewCipher([]byte("12345678"))
	_ = cipher
}

func fetchHandler(w http.ResponseWriter, r *http.Request) {
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	client.Get("https://example.com")
	http.Get(r.URL.Query().Get("url"))
}

func fileHandler(w http.ResponseWriter, r *http.Request) {
	data, _ := os.ReadFile(r.URL.Query().Get("path"))
	w.Write(data)
}

func pingHandler(w http.ResponseWriter, r *http.Request) {
	host := r.FormValue("host")
	exec.Command("sh", "-c", "ping -c 1 "+host).Run()
}

func helloHandler(w http.ResponseWriter, r *http.Request) {
	w.Write([]byte(r.FormValue("name")))
	t := texttemplate.Must(texttemplate.New("page").Parse("<p>{{.}}</p>"))
	t.Execute(w, template.HTML(r.FormValue("bio")))
}

func tokenHandler(w http.ResponseWriter, r *http.Request) {
	claims := jwt.MapClaims{}
	jwt.NewParser().ParseUnverified(r.Header.Get("Authorization"), claims)
}

func importHandler(w http.ResponseWriter, r *http.Request) {
	var state map[string]string
	gob.NewDecoder(r.Body).Decode(&state)
}
