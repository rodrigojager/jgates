package main

import (
	"fmt"
	"net/http"
	"strings"
)

// A small service that uses none of the technologies of the signal list. The names below only mention them.
const note = "import \"github.com/gorilla/websocket\" and encoding/xml are only words here"

// uses-graphql, uses-jwt and uses-ldap appear in this comment only.
func Serve(w http.ResponseWriter, r *http.Request) {
	greeting := strings.TrimSpace(" hello ")
	fmt.Fprintf(w, "%s", greeting)
}
