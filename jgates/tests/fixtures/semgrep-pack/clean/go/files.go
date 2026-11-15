package fixtures

import (
	"archive/zip"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func uploadAvatar(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 5<<20)
	file, header, err := r.FormFile("avatar")
	if err != nil {
		http.Error(w, "bad upload", http.StatusBadRequest)
		return
	}
	defer file.Close()
	sniff := make([]byte, 512)
	file.Read(sniff)
	if http.DetectContentType(sniff) != "image/png" {
		http.Error(w, "png only", http.StatusUnsupportedMediaType)
		return
	}
	out, _ := os.Create(filepath.Join("uploads", filepath.Base(header.Filename)))
	io.Copy(out, file)
}

func importBackup(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	data, _ := io.ReadAll(r.Body)
	_ = data
}

func unpackBundle(zr *zip.Reader, dest string) {
	for _, f := range zr.File {
		target := filepath.Join(dest, f.Name)
		if !strings.HasPrefix(target, filepath.Clean(dest)+string(os.PathSeparator)) {
			continue
		}
		os.MkdirAll(filepath.Dir(target), 0o750)
	}
}

func downloadReport(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
}

func isImage(name string) bool {
	return strings.HasSuffix(name, ".png")
}
