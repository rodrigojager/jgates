package fixtures

import (
	"fmt"
	"html/template"
	"mime"
	"net/http"
	"os/exec"

	"github.com/antchfx/xmlquery"
	"github.com/antchfx/xpath"
	"github.com/gin-gonic/gin"
	"github.com/go-ldap/ldap/v3"
)

func validateXPathValue(v string) string {
	return v
}

func loadApprovedTemplate(name string) string {
	return name
}

func ldapSearch(w http.ResponseWriter, r *http.Request) {
	user := r.FormValue("user")
	// ruleid: jgates.go.ldap-injection
	req := ldap.NewSearchRequest("dc=example,dc=com", ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 0, 0, false, "(uid="+user+")", []string{"cn"}, nil)
	_ = req
	// ruleid: jgates.go.ldap-injection
	req2 := ldap.NewSearchRequest(fmt.Sprintf("ou=%s,dc=example,dc=com", r.URL.Query().Get("unit")), ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 0, 0, false, "(objectClass=*)", []string{"cn"}, nil)
	_ = req2
	// ok: jgates.go.ldap-injection
	req3 := ldap.NewSearchRequest("dc=example,dc=com", ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 0, 0, false, "(uid="+ldap.EscapeFilter(user)+")", []string{"cn"}, nil)
	_ = req3
	// ok: jgates.go.ldap-injection
	req4 := ldap.NewSearchRequest("ou="+ldap.EscapeDN(r.FormValue("unit"))+",dc=example,dc=com", ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 0, 0, false, "(objectClass=*)", []string{"cn"}, nil)
	_ = req4
	// ok: jgates.go.ldap-injection
	req5 := ldap.NewSearchRequest("dc=example,dc=com", ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 0, 0, false, "(objectClass=person)", []string{"cn"}, nil)
	_ = req5
}

func ldapGin(c *gin.Context) {
	// ruleid: jgates.go.ldap-injection
	req := ldap.NewSearchRequest("dc=example,dc=com", ldap.ScopeWholeSubtree, ldap.NeverDerefAliases, 0, 0, false, "(mail="+c.Query("mail")+")", nil, nil)
	_ = req
}

func xpathLookup(w http.ResponseWriter, r *http.Request) {
	doc, _ := xmlquery.Parse(r.Body)
	name := r.FormValue("name")
	// ruleid: jgates.go.xpath-injection
	xmlquery.Find(doc, "//user[@name='"+name+"']")
	// ruleid: jgates.go.xpath-injection
	xpath.Compile(fmt.Sprintf("//item[id=%s]", r.URL.Query().Get("id")))
	// ok: jgates.go.xpath-injection
	xmlquery.Find(doc, "//user[@name='admin']")
	// ok: jgates.go.xpath-injection
	xmlquery.Find(doc, "//user[@name='"+validateXPathValue(name)+"']")
	// ok: jgates.go.xpath-injection
	for _, n := range xmlquery.Find(doc, "//user") {
		if n.SelectAttr("name") == name {
			_ = n
		}
	}
}

func templateHandler(w http.ResponseWriter, r *http.Request) {
	// ruleid: jgates.go.template-from-request
	t, _ := template.New("page").Parse(r.FormValue("tpl"))
	t.Execute(w, nil)
	body := r.URL.Query().Get("layout")
	// ruleid: jgates.go.template-from-request
	t2 := template.Must(template.New("page").Parse("<h1>" + body + "</h1>"))
	t2.Execute(w, nil)
	// ok: jgates.go.template-from-request
	t3, _ := template.New("page").Parse("<h1>{{.Title}}</h1>")
	t3.Execute(w, map[string]string{"Title": r.FormValue("title")})
	// ok: jgates.go.template-from-request
	t4, _ := template.New("page").Parse(loadApprovedTemplate(r.FormValue("name")))
	t4.Execute(w, nil)
}

func renderLatex(w http.ResponseWriter, r *http.Request) {
	// ruleid: jgates.go.latex-shell-escape
	exec.Command("pdflatex", "-shell-escape", "report.tex")
	// ruleid: jgates.go.latex-shell-escape
	exec.Command("xelatex", "-interaction=nonstopmode", "--enable-write18", "report.tex")
	// ruleid: jgates.go.latex-shell-escape
	exec.CommandContext(r.Context(), "latexmk", "-pdf", "-shell-escape", "report.tex")
	// ok: jgates.go.latex-shell-escape
	exec.Command("pdflatex", "-no-shell-escape", "report.tex")
	// ok: jgates.go.latex-shell-escape
	exec.Command("pdflatex", "-interaction=nonstopmode", "report.tex")
	// ok: jgates.go.latex-shell-escape
	exec.Command("tar", "-czf", "-shell-escape", "out.tgz")
}

func buildMail(w http.ResponseWriter, r *http.Request) {
	to := r.FormValue("to")
	subject := r.FormValue("subject")
	// ruleid: jgates.go.mail-header-injection
	msg := []byte("To: " + to + "\r\nSubject: hello\r\n\r\nbody")
	_ = msg
	// ruleid: jgates.go.mail-header-injection
	msg2 := fmt.Sprintf("Subject: %s\r\n", subject)
	_ = msg2
	// ruleid: jgates.go.mail-header-injection
	msg3 := "From: noreply@example.com\r\nSubject: " + r.URL.Query().Get("s") + "\r\n\r\nbody"
	_ = msg3
	// ok: jgates.go.mail-header-injection
	msg4 := "Subject: " + mime.QEncoding.Encode("utf-8", subject) + "\r\n\r\nbody"
	_ = msg4
	// ok: jgates.go.mail-header-injection
	msg5 := "To: user@example.com\r\nSubject: hello\r\n\r\n" + r.FormValue("body")
	_ = msg5
	// ok: jgates.go.mail-header-injection
	msg6 := fmt.Sprintf("Subject: welcome\r\n\r\n%s", r.FormValue("body"))
	_ = msg6
	// ok: jgates.go.mail-header-injection
	msg7 := fmt.Sprintf("To: %s\r\n", mime.BEncoding.Encode("utf-8", to))
	_ = msg7
}
