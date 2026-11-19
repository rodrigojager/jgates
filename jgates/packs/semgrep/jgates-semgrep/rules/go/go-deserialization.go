package fixtures

import (
	"bytes"
	"encoding/gob"
	"encoding/json"
	"io"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"
)

type payload struct {
	Name string
}

func validateBlob(blob []byte) []byte {
	return blob
}

func importHandler(w http.ResponseWriter, r *http.Request) {
	var p payload
	// ruleid: jgates.go.unsafe-deserialization
	gob.NewDecoder(r.Body).Decode(&p)
	raw, _ := io.ReadAll(r.Body)
	// ruleid: jgates.go.unsafe-deserialization
	gob.NewDecoder(bytes.NewReader(raw)).Decode(&p)
	// ok: jgates.go.unsafe-deserialization
	json.NewDecoder(r.Body).Decode(&p)
	// ok: jgates.go.unsafe-deserialization
	gob.NewDecoder(bytes.NewReader(validateBlob(raw))).Decode(&p)
}

func importGin(c *gin.Context) {
	var p payload
	// ruleid: jgates.go.unsafe-deserialization
	gob.NewDecoder(c.Request.Body).Decode(&p)
	file, _ := os.Open("cache.gob")
	// ok: jgates.go.unsafe-deserialization
	gob.NewDecoder(file).Decode(&p)
}
