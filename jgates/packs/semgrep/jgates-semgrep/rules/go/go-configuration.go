package fixtures

import (
	"net/http"
	"os"

	"github.com/gin-contrib/pprof"
	"github.com/gin-gonic/gin"
	"github.com/gofiber/fiber/v2"
	"github.com/gorilla/mux"
	"github.com/labstack/echo/v4"
	"github.com/labstack/echo/v4/middleware"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	echoSwagger "github.com/swaggo/echo-swagger"
	ginSwagger "github.com/swaggo/gin-swagger"
	httpSwagger "github.com/swaggo/http-swagger"
)

// ruleid: jgates.go.docs-or-monitoring-endpoint-exposed
import _ "net/http/pprof"

// debug-mode-enabled
func debugModes() {
	// ruleid: jgates.go.debug-mode-enabled
	gin.SetMode(gin.DebugMode)
	// ruleid: jgates.go.debug-mode-enabled
	gin.SetMode("debug")
	e := echo.New()
	// ruleid: jgates.go.debug-mode-enabled
	e.Debug = true
	// ok: jgates.go.debug-mode-enabled
	gin.SetMode(gin.ReleaseMode)
	if os.Getenv("APP_ENV") == "development" {
		// ok: jgates.go.debug-mode-enabled
		gin.SetMode(gin.DebugMode)
	}
	e2 := echo.New()
	// ok: jgates.go.debug-mode-enabled
	e2.Debug = false
}

// docs-or-monitoring-endpoint-exposed
func endpoints(r *gin.Engine, e *echo.Echo, m *mux.Router, app *fiber.App) {
	// ruleid: jgates.go.docs-or-monitoring-endpoint-exposed
	r.GET("/swagger/*any", ginSwagger.WrapHandler(nil))
	// ruleid: jgates.go.docs-or-monitoring-endpoint-exposed
	e.GET("/swagger/*", echoSwagger.WrapHandler)
	// ruleid: jgates.go.docs-or-monitoring-endpoint-exposed
	m.Handle("/metrics", promhttp.Handler())
	// ruleid: jgates.go.docs-or-monitoring-endpoint-exposed
	pprof.Register(r)
	// ruleid: jgates.go.docs-or-monitoring-endpoint-exposed
	m.PathPrefix("/swagger/").Handler(httpSwagger.WrapHandler)
	if os.Getenv("APP_ENV") == "development" {
		// ok: jgates.go.docs-or-monitoring-endpoint-exposed
		r.GET("/swagger/*any", ginSwagger.WrapHandler(nil))
		// ok: jgates.go.docs-or-monitoring-endpoint-exposed
		m.Handle("/metrics", promhttp.Handler())
	}
	// ok: jgates.go.docs-or-monitoring-endpoint-exposed
	r.GET("/health", func(c *gin.Context) { c.Status(http.StatusOK) })
}

// directory-listing-enabled
type noListingFS struct{ fs http.FileSystem }

func (n noListingFS) Open(p string) (http.File, error) { return n.fs.Open(p) }

func staticFiles(r *gin.Engine, e *echo.Echo) {
	// ruleid: jgates.go.directory-listing-enabled
	http.Handle("/files/", http.StripPrefix("/files/", http.FileServer(http.Dir("./public"))))
	// ruleid: jgates.go.directory-listing-enabled
	r.StaticFS("/assets", gin.Dir("./assets", true))
	// ruleid: jgates.go.directory-listing-enabled
	e.Use(middleware.StaticWithConfig(middleware.StaticConfig{Root: "public", Browse: true}))
	// ruleid: jgates.go.directory-listing-enabled
	_ = fiber.Static{Browse: true}
	// ok: jgates.go.directory-listing-enabled
	http.Handle("/safe/", http.FileServer(noListingFS{http.Dir("./public")}))
	// ok: jgates.go.directory-listing-enabled
	r.StaticFS("/assets2", gin.Dir("./assets", false))
	// ok: jgates.go.directory-listing-enabled
	e.Use(middleware.StaticWithConfig(middleware.StaticConfig{Root: "public", Browse: false}))
}

// version-header-exposed
func versionHeaders(w http.ResponseWriter, c *gin.Context) {
	// ruleid: jgates.go.version-header-exposed
	w.Header().Set("Server", "myapp/2.4.1")
	// ruleid: jgates.go.version-header-exposed
	c.Header("X-Powered-By", "Gin 1.9")
	// ruleid: jgates.go.version-header-exposed
	_ = fiber.New(fiber.Config{ServerHeader: "Fiber 2.52"})
	// ok: jgates.go.version-header-exposed
	w.Header().Set("Server", "web")
	// ok: jgates.go.version-header-exposed
	w.Header().Set("Content-Type", "application/json")
	// ok: jgates.go.version-header-exposed
	_ = fiber.New(fiber.Config{ServerHeader: "web"})
}
