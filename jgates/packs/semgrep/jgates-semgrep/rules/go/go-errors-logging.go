package fixtures

import (
	"fmt"
	"io"
	"log"
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
	"go.uber.org/zap"
)

// --- sensitive-data-logged ---

func logCredentials(password string, apiToken string, user string, logger *zap.SugaredLogger) {
	// ruleid: jgates.go.sensitive-data-logged
	log.Printf("login with %s", password)
	// ruleid: jgates.go.sensitive-data-logged
	logger.Infof("token: %s", apiToken)
	// ruleid: jgates.go.sensitive-data-logged
	logrus.Println(fmt.Sprintf("secret %s", password))
	// ok: jgates.go.sensitive-data-logged
	log.Printf("login by %s", user)
	// ok: jgates.go.sensitive-data-logged
	logger.Infof("login by %s, password length %d", user, len(password))
}

// --- sensitive-data-logged-key ---

func logFields(pw string, sessionID string, user string) {
	// ruleid: jgates.go.sensitive-data-logged-key
	slog.Info("login", "user", user, "password", pw)
	// ruleid: jgates.go.sensitive-data-logged-key
	slog.Warn("session", zap.String("session_id", sessionID))
	// ruleid: jgates.go.sensitive-data-logged-key
	logrus.WithField("token", sessionID).Info("seen")
	// ok: jgates.go.sensitive-data-logged-key
	slog.Info("login", "user", user)
	// ok: jgates.go.sensitive-data-logged-key
	slog.Info("login", "password", "[redacted]")
}

// --- sensitive-data-logged-header ---

func logHeaders(w http.ResponseWriter, r *http.Request) {
	// ruleid: jgates.go.sensitive-data-logged-header
	log.Printf("auth header %s", r.Header.Get("Authorization"))
	// ruleid: jgates.go.sensitive-data-logged-header
	slog.Info("request", r.Header["Authorization"])
	// ok: jgates.go.sensitive-data-logged-header
	log.Printf("agent %s", r.Header.Get("User-Agent"))
	// ok: jgates.go.sensitive-data-logged-header
	log.Printf("path %s", r.URL.Path)
}

// --- stack-trace-in-response ---

func panicHandler(w http.ResponseWriter, r *http.Request) {
	trace := debug.Stack()
	// ruleid: jgates.go.stack-trace-in-response
	w.Write(trace)
}

func panicHandlerGin(c *gin.Context) {
	stack := string(debug.Stack())
	// ruleid: jgates.go.stack-trace-in-response
	c.String(500, stack)
}

func panicHandlerSafe(w http.ResponseWriter, r *http.Request) {
	log.Printf("panic: %s", debug.Stack())
	// ok: jgates.go.stack-trace-in-response
	http.Error(w, "internal error", 500)
	// ok: jgates.go.stack-trace-in-response
	io.WriteString(w, "internal error")
}

// --- error-detail-in-response ---

func detailHandler(w http.ResponseWriter, r *http.Request, c *gin.Context) {
	err := work()
	if err != nil {
		// ruleid: jgates.go.error-detail-in-response
		http.Error(w, err.Error(), 500)
		// ruleid: jgates.go.error-detail-in-response
		c.JSON(500, gin.H{"error": err.Error()})
		// ok: jgates.go.error-detail-in-response
		http.Error(w, "internal error", 500)
		// ok: jgates.go.error-detail-in-response
		c.JSON(500, gin.H{"error": "internal error"})
	}
}

// --- swallowed-exception ---

func swallow() error {
	err := work()
	// ruleid: jgates.go.swallowed-exception
	if err != nil {
	}
	err = work()
	// ruleid: jgates.go.swallowed-exception
	if err != nil {
		return nil
	}
	err = work()
	// ok: jgates.go.swallowed-exception
	if err != nil {
		log.Printf("work failed: %v", err)
	}
	// ok: jgates.go.swallowed-exception
	if err != nil {
		return err
	}
	return nil
}

// --- http-client-without-timeout ---

func outbound(u string) {
	// ruleid: jgates.go.http-client-without-timeout
	http.Get(u)
	// ruleid: jgates.go.http-client-without-timeout
	client := &http.Client{}
	_ = client
	// ruleid: jgates.go.http-client-without-timeout
	http.DefaultClient.Do(nil)
	// ok: jgates.go.http-client-without-timeout
	safe := &http.Client{Timeout: 10 * time.Second}
	_ = safe
	// ok: jgates.go.http-client-without-timeout
	other := http.Client{Timeout: 5 * time.Second}
	_ = other
}

func work() error { return nil }
