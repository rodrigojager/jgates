package main

import (
	"net/http"
	"os"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/mux"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	ginSwagger "github.com/swaggo/gin-swagger"
)

type noListingFS struct{ fs http.FileSystem }

func (n noListingFS) Open(p string) (http.File, error) { return n.fs.Open(p) }

func main() {
	dev := os.Getenv("APP_ENV") == "development"
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	m := mux.NewRouter()
	if dev {
		r.GET("/swagger/*any", ginSwagger.WrapHandler(nil))
		m.Handle("/metrics", promhttp.Handler())
	}
	http.Handle("/files/", http.FileServer(noListingFS{http.Dir("./public")}))
	r.GET("/ping", func(c *gin.Context) {
		c.Header("Server", "web")
		c.String(http.StatusOK, "pong")
	})
	_ = r.Run(":8080")
}
