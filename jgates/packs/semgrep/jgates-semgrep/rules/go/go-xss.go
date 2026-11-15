package fixtures

import (
	"fmt"
	"html"
	htmltemplate "html/template"
	"io"
	"net/http"
	"os"
	tt "text/template"
	"html/template"
)

var reportTemplate = tt.Must(tt.New("report").Parse("{{.}}\n"))

func textTemplatePage(w http.ResponseWriter, r *http.Request) {
	page := tt.Must(tt.New("page").Parse("<p>{{.}}</p>"))
	// ruleid: jgates.go.text-template-for-html
	page.Execute(w, r.FormValue("name"))
	// ruleid: jgates.go.text-template-for-html
	reportTemplate.Execute(w, r.FormValue("name"))
	// ruleid: jgates.go.text-template-for-html
	tt.Must(tt.New("x").Parse("<p>{{.}}</p>")).ExecuteTemplate(w, "x", r.FormValue("name"))
	// ok: jgates.go.text-template-for-html
	page.Execute(os.Stdout, "report")
	safe := template.Must(template.New("page").Parse("<p>{{.}}</p>"))
	// ok: jgates.go.text-template-for-html
	safe.Execute(w, r.FormValue("name"))
}

func typedHTML(name string, safe string) {
	// ruleid: jgates.go.unsafe-html-type
	_ = template.HTML(name)
	// ruleid: jgates.go.unsafe-html-type
	_ = template.JS("var user = '" + name + "';")
	// ruleid: jgates.go.unsafe-html-type
	_ = template.URL(safe)
	// ok: jgates.go.unsafe-html-type
	_ = template.HTML("<b>fixed markup</b>")
	// ok: jgates.go.unsafe-html-type
	_ = template.HTML(policy.Sanitize(name))
	// ok: jgates.go.unsafe-html-type
	_ = template.HTML(html.EscapeString(name))
	// ok: jgates.go.unsafe-html-type
	_ = htmltemplate.HTMLEscapeString(name)
}

func echoHandler(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query().Get("q")
	// ruleid: jgates.go.request-written-to-response
	w.Write([]byte(query))
	// ruleid: jgates.go.request-written-to-response
	fmt.Fprintf(w, "<p>Hello %s</p>", r.FormValue("name"))
	// ruleid: jgates.go.request-written-to-response
	io.WriteString(w, r.Header.Get("X-Greeting"))
	// ok: jgates.go.request-written-to-response
	w.Write([]byte(html.EscapeString(query)))
	// ok: jgates.go.request-written-to-response
	fmt.Fprintf(w, "<p>Hello %s</p>", htmltemplate.HTMLEscapeString(r.FormValue("name")))
	// ok: jgates.go.request-written-to-response
	fmt.Fprint(w, "<p>fixed page</p>")
}

var echoLiteral = func(w http.ResponseWriter, r *http.Request) {
	// ruleid: jgates.go.request-written-to-response
	fmt.Fprintln(w, r.URL.Path)
	// ok: jgates.go.request-written-to-response
	io.WriteString(w, "done")
}
