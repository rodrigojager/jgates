package main

import (
	"fmt"
	"html/template"
	"mime"
	"net/http"
	"os/exec"

	"github.com/antchfx/xmlquery"
	"github.com/go-ldap/ldap/v3"
)

func findUser(w http.ResponseWriter, r *http.Request) {
	user := r.FormValue("user")
	req := ldap.NewSearchRequest("dc=example,dc=com", ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 0, 0, false, "(uid="+ldap.EscapeFilter(user)+")", []string{"cn"}, nil)
	_ = req
}

func findNode(w http.ResponseWriter, r *http.Request) {
	doc, _ := xmlquery.Parse(r.Body)
	name := r.FormValue("name")
	for _, n := range xmlquery.Find(doc, "//user") {
		if n.SelectAttr("name") == name {
			_ = n
		}
	}
}

func page(w http.ResponseWriter, r *http.Request) {
	t, _ := template.New("page").Parse("<h1>{{.Title}}</h1>")
	t.Execute(w, map[string]string{"Title": r.FormValue("title")})
}

func report() {
	exec.Command("pdflatex", "-no-shell-escape", "report.tex")
}

func notify(w http.ResponseWriter, r *http.Request) {
	msg := fmt.Sprintf("Subject: %s\r\n", mime.QEncoding.Encode("utf-8", r.FormValue("subject")))
	_ = msg
}
