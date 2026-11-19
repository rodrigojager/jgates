package fixtures

import (
	"archive/zip"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func uploadAvatar(w http.ResponseWriter, r *http.Request) {
	file, header, err := r.FormFile("avatar")
	if err != nil {
		http.Error(w, "bad upload", http.StatusBadRequest)
		return
	}
	defer file.Close()
	if header.Header.Get("Content-Type") != "image/png" {
		http.Error(w, "png only", http.StatusUnsupportedMediaType)
		return
	}
	out, _ := os.Create(filepath.Join("uploads", header.Filename))
	io.Copy(out, file)
}

func importBackup(w http.ResponseWriter, r *http.Request) {
	data, _ := io.ReadAll(r.Body)
	_ = data
}

func unpackBundle(zr *zip.Reader, dest string) {
	for _, f := range zr.File {
		target := filepath.Join(dest, f.Name)
		os.MkdirAll(filepath.Dir(target), 0o750)
	}
}

func downloadReport(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	w.Header().Set("Content-Disposition", "attachment; filename="+name)
}

func isImage(name string) bool {
	return strings.HasSuffix(name, ".png")
}
