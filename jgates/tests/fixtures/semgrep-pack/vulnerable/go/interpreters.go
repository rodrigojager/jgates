package main

import (
	"fmt"
	"html/template"
	"net/http"
	"os/exec"

	"github.com/antchfx/xmlquery"
	"github.com/go-ldap/ldap/v3"
)

func findUser(w http.ResponseWriter, r *http.Request) {
	user := r.FormValue("user")
	req := ldap.NewSearchRequest("dc=example,dc=com", ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 0, 0, false, "(uid="+user+")", []string{"cn"}, nil)
	_ = req
}

func findNode(w http.ResponseWriter, r *http.Request) {
	doc, _ := xmlquery.Parse(r.Body)
	xmlquery.Find(doc, "//user[@name='"+r.FormValue("name")+"']")
}

func page(w http.ResponseWriter, r *http.Request) {
	t, _ := template.New("page").Parse(r.FormValue("tpl"))
	t.Execute(w, nil)
}

func report() {
	exec.Command("pdflatex", "-shell-escape", "report.tex")
}

func notify(w http.ResponseWriter, r *http.Request) {
	msg := fmt.Sprintf("Subject: %s\r\n", r.FormValue("subject"))
	_ = msg
}
