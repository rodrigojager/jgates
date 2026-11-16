package main

import (
	"net/http"

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
	var user account
	c.ShouldBindJSON(&user)
	db.Save(&user)
}

func getAccount(c *gin.Context, db *gorm.DB) {
	var user account
	db.First(&user, 1)
	c.JSON(http.StatusOK, user)
}

func main() {
	gin.SetMode(gin.DebugMode)
	r := gin.New()
	r.GET("/swagger/*any", ginSwagger.WrapHandler(nil))
	m := mux.NewRouter()
	m.Handle("/metrics", promhttp.Handler())
	http.Handle("/files/", http.FileServer(http.Dir("./public")))
	r.GET("/ping", func(c *gin.Context) {
		c.Header("Server", "myapp/2.4.1")
		c.String(http.StatusOK, "pong")
	})
	_ = r.Run(":8080")
}
