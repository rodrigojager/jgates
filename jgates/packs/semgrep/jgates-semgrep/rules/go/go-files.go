package fixtures

import (
	"archive/tar"
	"archive/zip"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

// --- upload-client-filename-in-path ---

func uploadHandler(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20)
	file, header, err := r.FormFile("upload")
	if err != nil {
		return
	}
	defer file.Close()
	// ruleid: jgates.go.upload-client-filename-in-path
	out, _ := os.Create(filepath.Join("uploads", header.Filename))
	// ruleid: jgates.go.upload-client-filename-in-path
	os.WriteFile("uploads/"+header.Filename, nil, 0o600)
	// ok: jgates.go.upload-client-filename-in-path
	os.Create(filepath.Join("uploads", filepath.Base(header.Filename)))
	// ok: jgates.go.upload-client-filename-in-path
	os.Create(filepath.Join("uploads", "generated-name.bin"))
	_ = out
}

func uploadGin(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 10<<20)
	fh, _ := c.FormFile("upload")
	// ruleid: jgates.go.upload-client-filename-in-path
	c.SaveUploadedFile(fh, "uploads/"+fh.Filename)
	// ok: jgates.go.upload-client-filename-in-path
	c.SaveUploadedFile(fh, filepath.Join("uploads", filepath.Base(fh.Filename)))
}

func storeMany(form *multipart.Form) {
	for _, part := range form.File["files"] {
		// ruleid: jgates.go.upload-client-filename-in-path
		os.Create(filepath.Join("uploads", part.Filename))
	}
	for _, part := range form.File["files"] {
		// ok: jgates.go.upload-client-filename-in-path
		os.Create(filepath.Join("uploads", filepath.Base(part.Filename)))
	}
}

func storeHeader(h *multipart.FileHeader) {
	// ruleid: jgates.go.upload-client-filename-in-path
	os.Create("uploads/" + h.Filename)
	// ok: jgates.go.upload-client-filename-in-path
	os.Create("uploads/" + filepath.Base(h.Filename))
}

// --- archive-extraction-unchecked ---

func unzipUnchecked(src, dest string) {
	zr, _ := zip.OpenReader(src)
	for _, f := range zr.File {
		// ruleid: jgates.go.archive-extraction-unchecked
		target := filepath.Join(dest, f.Name)
		os.MkdirAll(filepath.Dir(target), 0o750)
	}
}

func unzipDirect(zr *zip.Reader) {
	for _, entry := range zr.File {
		// ruleid: jgates.go.archive-extraction-unchecked
		os.Create(entry.Name)
	}
}

func untarUnchecked(tr *tar.Reader, dest string) {
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		// ruleid: jgates.go.archive-extraction-unchecked
		out, _ := os.OpenFile(filepath.Join(dest, hdr.Name), os.O_CREATE|os.O_WRONLY, 0o600)
		io.Copy(out, tr)
	}
}

func untarCreate(tr *tar.Reader) {
	for {
		hdr, err := tr.Next()
		if err != nil {
			break
		}
		// ruleid: jgates.go.archive-extraction-unchecked
		os.Create(hdr.Name)
	}
}

func unzipChecked(src, dest string) {
	zr, _ := zip.OpenReader(src)
	for _, f := range zr.File {
		// ok: jgates.go.archive-extraction-unchecked
		target := filepath.Join(dest, f.Name)
		if !strings.HasPrefix(target, filepath.Clean(dest)+string(os.PathSeparator)) {
			continue
		}
		os.MkdirAll(filepath.Dir(target), 0o750)
	}
}

func unzipLocal(zr *zip.Reader, dest string) {
	for _, f := range zr.File {
		if !filepath.IsLocal(f.Name) {
			continue
		}
		// ok: jgates.go.archive-extraction-unchecked
		os.Create(filepath.Join(dest, f.Name))
	}
}

func untarChecked(tr *tar.Reader, dest string) {
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if strings.Contains(hdr.Name, "..") {
			continue
		}
		// ok: jgates.go.archive-extraction-unchecked
		os.OpenFile(filepath.Join(dest, hdr.Name), os.O_CREATE|os.O_WRONLY, 0o600)
	}
}

func joinOutsideArchive(dest, name string) {
	// ok: jgates.go.archive-extraction-unchecked
	os.Create(filepath.Join(dest, name))
}

// --- request-body-without-size-limit ---

func readBodyUnbounded(w http.ResponseWriter, r *http.Request) {
	// ruleid: jgates.go.request-body-without-size-limit
	data, _ := io.ReadAll(r.Body)
	_ = data
}

func decodeBodyUnbounded(w http.ResponseWriter, r *http.Request) {
	var payload map[string]any
	// ruleid: jgates.go.request-body-without-size-limit
	json.NewDecoder(r.Body).Decode(&payload)
}

func parseFormUnbounded(w http.ResponseWriter, r *http.Request) {
	// ruleid: jgates.go.request-body-without-size-limit
	r.ParseMultipartForm(32 << 20)
}

func ginBodyUnbounded(c *gin.Context) {
	// ruleid: jgates.go.request-body-without-size-limit
	raw, _ := c.GetRawData()
	_ = raw
	// ruleid: jgates.go.request-body-without-size-limit
	io.ReadAll(c.Request.Body)
}

func readBodyBounded(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	// ok: jgates.go.request-body-without-size-limit
	data, _ := io.ReadAll(r.Body)
	_ = data
}

func parseFormBounded(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20)
	// ok: jgates.go.request-body-without-size-limit
	r.ParseMultipartForm(32 << 20)
}

func ginBodyBounded(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20)
	// ok: jgates.go.request-body-without-size-limit
	raw, _ := c.GetRawData()
	_ = raw
}

func readUpstreamResponse(resp *http.Response) {
	// ok: jgates.go.request-body-without-size-limit
	io.ReadAll(resp.Body)
}

// --- upload-content-type-trusted ---

func contentTypeTrusted(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20)
	file, header, _ := r.FormFile("image")
	// ruleid: jgates.go.upload-content-type-trusted
	if header.Header.Get("Content-Type") != "image/png" {
		return
	}
	_ = file
}

func contentTypePrefix(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20)
	_, header, _ := r.FormFile("image")
	// ruleid: jgates.go.upload-content-type-trusted
	if !strings.HasPrefix(header.Header.Get("Content-Type"), "image/") {
		return
	}
}

func contentTypeDetected(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20)
	file, _, _ := r.FormFile("image")
	buf := make([]byte, 512)
	file.Read(buf)
	// ok: jgates.go.upload-content-type-trusted
	if http.DetectContentType(buf) != "image/png" {
		return
	}
}

func requestContentType(w http.ResponseWriter, r *http.Request) {
	// ok: jgates.go.upload-content-type-trusted
	if r.Header.Get("Content-Type") != "application/json" {
		return
	}
}

// --- content-disposition-from-request ---

func downloadConcat(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	// ruleid: jgates.go.content-disposition-from-request
	w.Header().Set("Content-Disposition", "attachment; filename="+name)
}

func downloadSprintf(w http.ResponseWriter, r *http.Request) {
	// ruleid: jgates.go.content-disposition-from-request
	w.Header().Set("Content-Disposition", "attachment; filename=\""+r.FormValue("file")+"\"")
}

func downloadGin(c *gin.Context) {
	// ruleid: jgates.go.content-disposition-from-request
	c.Header("Content-Disposition", "attachment; filename="+c.Query("file"))
}

func downloadFormatted(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	// ok: jgates.go.content-disposition-from-request
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": name}))
}

func downloadEscaped(w http.ResponseWriter, r *http.Request) {
	// ok: jgates.go.content-disposition-from-request
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(r.FormValue("file")))
}

func downloadFixedName(w http.ResponseWriter, r *http.Request) {
	// ok: jgates.go.content-disposition-from-request
	w.Header().Set("Content-Disposition", "attachment; filename=report.pdf")
}
