package main

import (
	"encoding/csv"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"regexp"

	"github.com/bradfitz/gomemcache/memcache"
	"github.com/russross/blackfriday/v2"
	"github.com/yuin/goldmark"
	ghtml "github.com/yuin/goldmark/renderer/html"
)

var cache *memcache.Client

func searchLogs(w http.ResponseWriter, r *http.Request) {
	re := regexp.MustCompile("^" + r.URL.Query().Get("q"))
	_ = re
}

func auditLine(w http.ResponseWriter, r *http.Request) {
	fmt.Printf(r.FormValue("template"))
}

func exportRow(w http.ResponseWriter, r *http.Request) {
	cw := csv.NewWriter(w)
	var typed *csv.Writer = cw
	typed.Write([]string{"customer", r.FormValue("customer")})
}

func lookup(w http.ResponseWriter, r *http.Request) {
	cache.Get(r.URL.Query().Get("key"))
}

func normalize(raw string) string {
	once := html.UnescapeString(raw)
	twice := html.UnescapeString(once)
	return twice
}

func buildLink(w http.ResponseWriter, r *http.Request) {
	link := "https://search.example.com/find?term=" + r.URL.Query().Get("term")
	_ = link
}

func buildPayload(w http.ResponseWriter, r *http.Request) {
	body := "{\"name\":\"" + r.FormValue("name") + "\"}"
	_ = body
}

func renderNote(src []byte) []byte {
	return blackfriday.Run(src)
}

func noteRenderer() goldmark.Markdown {
	return goldmark.New(goldmark.WithRendererOptions(ghtml.WithUnsafe()))
}

var _ = url.QueryEscape
