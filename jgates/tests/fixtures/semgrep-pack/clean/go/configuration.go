package main

import (
	"net/http"
	"os"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/mux"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	ginSwagger "github.com/swaggo/gin-swagger"
	"gorm.io/gorm"
)

type account struct {
	Name string
	Admin bool
}

func updateAccount(c *gin.Context, db *gorm.DB) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1048576)
	var input struct { Name string }
	c.ShouldBindJSON(&input)
	user := account{Name: input.Name}
	db.Save(&user)
}

func getAccount(c *gin.Context, db *gorm.DB) {
	var user account
	db.First(&user, 1)
	c.JSON(http.StatusOK, gin.H{"name": user.Name})
}

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
