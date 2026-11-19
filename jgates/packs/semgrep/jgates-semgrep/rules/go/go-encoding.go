package fixtures

import (
	"encoding/base64"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"

	"github.com/bradfitz/gomemcache/memcache"
	"github.com/gin-gonic/gin"
	"github.com/labstack/echo/v4"
	"github.com/microcosm-cc/bluemonday"
	"github.com/russross/blackfriday/v2"
	"github.com/xuri/excelize/v2"
	"github.com/yuin/goldmark"
	ghtml "github.com/yuin/goldmark/renderer/html"
)

func sanitizeCSVField(v string) string {
	return "'" + v
}

func validateCacheKey(v string) string {
	return v
}

// regex-from-request

func searchHandler(w http.ResponseWriter, r *http.Request) {
	term := r.URL.Query().Get("q")
	// ruleid: jgates.go.regex-from-request
	re, _ := regexp.Compile(term)
	_ = re
	// ruleid: jgates.go.regex-from-request
	regexp.MustCompile("^" + r.FormValue("prefix"))
	// ruleid: jgates.go.regex-from-request
	regexp.MatchString(r.FormValue("pattern"), "some text")
	// ok: jgates.go.regex-from-request
	regexp.MustCompile("^" + regexp.QuoteMeta(term))
	// ok: jgates.go.regex-from-request
	regexp.MatchString(regexp.QuoteMeta(r.FormValue("pattern")), "some text")
	// ok: jgates.go.regex-from-request
	regexp.MustCompile(`^[a-z]+$`)
}

func searchGin(c *gin.Context) {
	// ruleid: jgates.go.regex-from-request
	regexp.MustCompilePOSIX(c.Query("expr"))
	// ok: jgates.go.regex-from-request
	regexp.MustCompilePOSIX(regexp.QuoteMeta(c.Query("expr")))
}

// format-string-from-request

func greetHandler(w http.ResponseWriter, r *http.Request) {
	name := r.FormValue("name")
	// ruleid: jgates.go.format-string-from-request
	fmt.Printf(r.FormValue("template"))
	// ruleid: jgates.go.format-string-from-request
	msg := fmt.Sprintf(name, 1)
	_ = msg
	// ruleid: jgates.go.format-string-from-request
	log.Printf(r.Header.Get("X-Trace"))
	// ruleid: jgates.go.format-string-from-request
	fmt.Fprintf(w, r.FormValue("line"))
	// ok: jgates.go.format-string-from-request
	fmt.Printf("%s", r.FormValue("template"))
	// ok: jgates.go.format-string-from-request
	fmt.Sprintf("hello %s", name)
	// ok: jgates.go.format-string-from-request
	log.Printf("trace %q", r.Header.Get("X-Trace"))
	// ok: jgates.go.format-string-from-request
	fmt.Fprintln(w, name)
}

func greetEcho(c echo.Context) error {
	// ruleid: jgates.go.format-string-from-request
	return fmt.Errorf(c.QueryParam("reason"))
}

func greetEchoSafe(c echo.Context) error {
	// ok: jgates.go.format-string-from-request
	return fmt.Errorf("failed: %s", c.QueryParam("reason"))
}

// csv-formula-injection

func exportHandler(w http.ResponseWriter, r *http.Request) {
	var cw *csv.Writer
	name := r.FormValue("name")
	// ruleid: jgates.go.csv-formula-injection
	cw.Write([]string{"name", name})
	// ruleid: jgates.go.csv-formula-injection
	cw.Write([]string{r.FormValue("note"), "x"})
	// ok: jgates.go.csv-formula-injection
	cw.Write([]string{"name", sanitizeCSVField(name)})
	// ok: jgates.go.csv-formula-injection
	cw.Write([]string{"name", "total"})
}

func exportSheet(c *gin.Context) {
	f := excelize.NewFile()
	// ruleid: jgates.go.csv-formula-injection
	f.SetCellValue("Sheet1", "A1", c.Query("title"))
	// ok: jgates.go.csv-formula-injection
	f.SetCellValue("Sheet1", "A2", sanitizeCSVField(c.Query("title")))
	// ok: jgates.go.csv-formula-injection
	f.SetCellValue("Sheet1", "A3", "Report")
}

// memcache-key-from-request

func cacheHandler(w http.ResponseWriter, r *http.Request) {
	var mc *memcache.Client
	// ruleid: jgates.go.memcache-key-from-request
	mc.Get(r.URL.Query().Get("key"))
	user := r.FormValue("user")
	// ruleid: jgates.go.memcache-key-from-request
	mc.Set(&memcache.Item{Key: "user:" + user, Value: []byte("x")})
	// ok: jgates.go.memcache-key-from-request
	mc.Get(hex.EncodeToString([]byte(user)))
	// ok: jgates.go.memcache-key-from-request
	mc.Set(&memcache.Item{Key: validateCacheKey(user), Value: []byte("x")})
	// ok: jgates.go.memcache-key-from-request
	mc.Get("homepage")
}

// double-decoding

func decodeTwice(raw string) {
	// ruleid: jgates.go.double-decoding
	first, _ := url.QueryUnescape(raw)
	second, _ := url.QueryUnescape(first)
	_ = second
}

func decodeTwiceHTML(raw string) string {
	// ruleid: jgates.go.double-decoding
	return html.UnescapeString(html.UnescapeString(raw))
}

func decodeTwiceBase64(raw string) {
	// ruleid: jgates.go.double-decoding
	a, _ := base64.StdEncoding.DecodeString(raw)
	b, _ := base64.StdEncoding.DecodeString(string(a))
	_ = b
}

func decodeOnce(raw, other string) {
	// ok: jgates.go.double-decoding
	first, _ := url.QueryUnescape(raw)
	_ = first
	second, _ := url.QueryUnescape(other)
	_ = second
	// ok: jgates.go.double-decoding
	h := html.UnescapeString(raw)
	_ = h
	// ok: jgates.go.double-decoding
	d, _ := base64.StdEncoding.DecodeString(raw)
	_ = d
}

// url-parameter-unencoded

func linkHandler(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	// ruleid: jgates.go.url-parameter-unencoded
	link := "https://search.example.com/find?term=" + q
	_ = link
	// ruleid: jgates.go.url-parameter-unencoded
	profile := fmt.Sprintf("https://example.com/users/%s", r.FormValue("id"))
	_ = profile
	// ok: jgates.go.url-parameter-unencoded
	safe := "https://search.example.com/find?term=" + url.QueryEscape(q)
	_ = safe
	// ok: jgates.go.url-parameter-unencoded
	safePath := "https://example.com/users/" + url.PathEscape(r.FormValue("id"))
	_ = safePath
	// ok: jgates.go.url-parameter-unencoded
	built := "https://search.example.com/find?" + url.Values{"term": {q}}.Encode()
	_ = built
}

// json-built-by-concatenation

func payloadHandler(w http.ResponseWriter, r *http.Request) {
	name := r.FormValue("name")
	// ruleid: jgates.go.json-built-by-concatenation
	body := "{\"name\":\"" + name + "\"}"
	_ = body
	// ruleid: jgates.go.json-built-by-concatenation
	raw := fmt.Sprintf(`{"user": "%s"}`, r.FormValue("user"))
	_ = raw
	// ruleid: jgates.go.json-built-by-concatenation
	script := fmt.Sprintf("<script>var user = '%s';</script>", name)
	_ = script
	b, _ := json.Marshal(name)
	// ok: jgates.go.json-built-by-concatenation
	safe := "{\"name\":" + string(b) + "}"
	_ = safe
	// ok: jgates.go.json-built-by-concatenation
	safeNum := "{\"count\":" + strconv.Itoa(3) + "}"
	_ = safeNum
	// ok: jgates.go.json-built-by-concatenation
	full, _ := json.Marshal(map[string]string{"name": name})
	_ = full
}

// markdown-raw-html-enabled

func renderMarkdown(src []byte) []byte {
	// ruleid: jgates.go.markdown-raw-html-enabled-by-default
	return blackfriday.Run(src)
}

func renderMarkdownBasic(src []byte) []byte {
	// ruleid: jgates.go.markdown-raw-html-enabled-by-default
	return blackfriday.MarkdownBasic(src)
}

func newRenderer() goldmark.Markdown {
	// ruleid: jgates.go.markdown-raw-html-enabled
	return goldmark.New(goldmark.WithRendererOptions(ghtml.WithUnsafe()))
}

func unsafeRendererOption() {
	// ruleid: jgates.go.markdown-raw-html-enabled
	option := ghtml.WithUnsafe()
	_ = goldmark.New(goldmark.WithRendererOptions(option))
}

func newRendererSafe() goldmark.Markdown {
	// ok: jgates.go.markdown-raw-html-enabled
	return goldmark.New(goldmark.WithRendererOptions(ghtml.WithHardWraps()))
}

func renderMarkdownSafe(src []byte) []byte {
	// ok: jgates.go.markdown-raw-html-enabled
	// ok: jgates.go.markdown-raw-html-enabled-by-default
	return bluemonday.UGCPolicy().SanitizeBytes(blackfriday.Run(src))
}

func renderMarkdownBasicSafe(src []byte) []byte {
	// ok: jgates.go.markdown-raw-html-enabled-by-default
	return bluemonday.UGCPolicy().SanitizeBytes(blackfriday.MarkdownBasic(src))
}
