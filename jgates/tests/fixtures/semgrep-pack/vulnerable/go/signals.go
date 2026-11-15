package main

import (
	"archive/zip"
	"encoding/xml"
	"html/template"
	"mime/multipart"
	"net/http"
	"net/smtp"
	"syscall/js"

	"github.com/99designs/gqlgen/graphql"
	"github.com/bradfitz/gomemcache/memcache"
	"github.com/crewjam/saml/samlsp"
	"github.com/go-ldap/ldap/v3"
	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
	"github.com/ory/fosite"
	"github.com/pion/webrtc/v3"
	"github.com/pquerna/otp/totp"
	"golang.org/x/oauth2"
)

// A service that touches every technology of the signal list that Go can show.
func Serve(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20)
	_ = graphql.NewExecutableSchema
	_ = websocket.Upgrader{}
	_ = webrtc.Configuration{}
	_ = oauth2.Config{}
	_ = fosite.Config{}
	_ = jwt.New
	_ = samlsp.Options{}
	_, _ = totp.Generate(totp.GenerateOpts{})
	_, _ = ldap.DialURL("ldap://directory.example")
	_ = xml.Unmarshal
	_ = memcache.New("cache.example:11211")
	_ = smtp.SendMail
	_ = template.Must
	_ = multipart.FileHeader{}
	_ = zip.NewReader
	_ = js.Global()
	_, _, _ = r.FormFile("avatar")
}
