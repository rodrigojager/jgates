package fixtures

import (
	"io/ioutil"
	"net/http"
	"os"
	"path/filepath"

	"github.com/gin-gonic/gin"
	"github.com/go-chi/chi/v5"
	"github.com/gofiber/fiber/v2"
	"github.com/labstack/echo/v4"
)

func validateURL(raw string) string {
	return raw
}

func fetchHandler(w http.ResponseWriter, r *http.Request) {
	// ruleid: jgates.go.ssrf
	http.Get(r.URL.Query().Get("url"))
	target := r.FormValue("callback")
	// ruleid: jgates.go.ssrf
	http.Post(target, "application/json", nil)
	// ok: jgates.go.ssrf
	http.Get("https://api.example.com/status")
	// ok: jgates.go.ssrf
	http.Get(validateURL(r.FormValue("url")))
}

func fetchGin(c *gin.Context) {
	// ruleid: jgates.go.ssrf
	http.Get(c.Query("url"))
	// ok: jgates.go.ssrf
	http.Get("https://api.example.com/health")
}

func fetchEcho(c echo.Context) error {
	target := c.QueryParam("url")
	// ruleid: jgates.go.ssrf
	req, _ := http.NewRequest("GET", target, nil)
	_ = req
	return nil
}

func fetchChi(w http.ResponseWriter, r *http.Request) {
	// ruleid: jgates.go.ssrf
	http.Head(chi.URLParam(r, "host"))
}

var fetchFiber = func(c *fiber.Ctx) error {
	// ruleid: jgates.go.ssrf
	http.Get(c.Query("url"))
	return nil
}

func downloadHandler(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	// ruleid: jgates.go.path-traversal
	os.ReadFile(name)
	// ruleid: jgates.go.path-traversal
	os.Open(filepath.Join("/srv/files", r.FormValue("path")))
	// ruleid: jgates.go.path-traversal
	http.ServeFile(w, r, name)
	// ok: jgates.go.path-traversal
	os.ReadFile(filepath.Base(name))
	// ok: jgates.go.path-traversal
	os.Open(filepath.Join("/srv/files", filepath.Base(r.FormValue("path"))))
	// ok: jgates.go.path-traversal
	ioutil.ReadFile("static/readme.txt")
}

func uploadGin(c *gin.Context) {
	// ruleid: jgates.go.path-traversal
	os.Remove(c.Param("file"))
	// ok: jgates.go.path-traversal
	os.Remove("/tmp/fixed.tmp")
}
