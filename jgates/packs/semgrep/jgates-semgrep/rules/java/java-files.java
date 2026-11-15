import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.URLEncoder;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import javax.servlet.annotation.MultipartConfig;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.servlet.http.Part;
import net.lingala.zip4j.ZipFile;
import org.apache.commons.compress.archivers.tar.TarArchiveEntry;
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream;
import org.apache.commons.fileupload.FileItem;
import org.apache.commons.fileupload.servlet.ServletFileUpload;
import org.apache.commons.io.FilenameUtils;
import org.apache.commons.io.IOUtils;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.multipart.MultipartFile;

class FilesFixture {
    static String sanitizeFileName(String value) { return value; }

    // ---- upload-client-filename-in-path ----
    void uploadSpring(MultipartFile file, File dir) throws IOException {
        // ruleid: jgates.java.upload-client-filename-in-path
        File target = new File(dir, file.getOriginalFilename());
        file.transferTo(target);
    }

    void uploadSpringNio(MultipartFile file, String root) throws IOException {
        String name = file.getOriginalFilename();
        // ruleid: jgates.java.upload-client-filename-in-path
        Path target = Paths.get(root, name);
        file.transferTo(target);
    }

    void uploadPart(Part part, Path base) throws IOException {
        String name = part.getSubmittedFileName();
        // ruleid: jgates.java.upload-client-filename-in-path
        FileOutputStream out = new FileOutputStream("/srv/uploads/" + name);
        out.close();
    }

    void uploadFileItem(FileItem item, Path base) throws IOException {
        // ruleid: jgates.java.upload-client-filename-in-path
        Path target = base.resolve(item.getName());
    }

    void uploadSafe(MultipartFile file, File dir, Path base) throws IOException {
        // ok: jgates.java.upload-client-filename-in-path
        File a = new File(dir, FilenameUtils.getName(file.getOriginalFilename()));
        // ok: jgates.java.upload-client-filename-in-path
        File b = new File(dir, UUID.randomUUID().toString());
        // ok: jgates.java.upload-client-filename-in-path
        Path c = base.resolve(sanitizeFileName(file.getOriginalFilename()));
        // ok: jgates.java.upload-client-filename-in-path
        String label = file.getOriginalFilename();
        file.transferTo(a);
    }

    // ---- archive-extraction-unchecked ----
    void unzip(ZipInputStream zis, File dest) throws IOException {
        ZipEntry entry = zis.getNextEntry();
        while (entry != null) {
            // ruleid: jgates.java.archive-extraction-unchecked
            File out = new File(dest, entry.getName());
            entry = zis.getNextEntry();
        }
    }

    void untar(TarArchiveInputStream tis, Path dest) throws IOException {
        TarArchiveEntry entry = tis.getNextTarEntry();
        // ruleid: jgates.java.archive-extraction-unchecked
        Path out = dest.resolve(entry.getName());
    }

    void unzipWhole(String archive, String dest) throws Exception {
        // ruleid: jgates.java.archive-extraction-unchecked
        new ZipFile(archive).extractAll(dest);
    }

    void unzipWholeVariable(ZipFile zip, String dest) throws Exception {
        // ruleid: jgates.java.archive-extraction-unchecked
        zip.extractAll(dest);
    }

    void unzipChecked(ZipInputStream zis, File dest) throws IOException {
        ZipEntry entry = zis.getNextEntry();
        while (entry != null) {
            // ok: jgates.java.archive-extraction-unchecked
            File out = new File(dest, entry.getName());
            if (!out.getCanonicalPath().startsWith(dest.getCanonicalPath() + File.separator)) {
                throw new IOException("entry outside target");
            }
            entry = zis.getNextEntry();
        }
    }

    void unzipWholeChecked(File archive, String dest) throws Exception {
        if (archive.length() > 50_000_000L) {
            throw new IOException("archive too large");
        }
        // ok: jgates.java.archive-extraction-unchecked
        new ZipFile(archive).extractAll(dest);
    }

    void unrelatedName(File file, File dest) {
        // ok: jgates.java.archive-extraction-unchecked
        File copy = new File(dest, file.getName());
    }

    // ---- request-body-without-size-limit ----
    // ruleid: jgates.java.request-body-without-size-limit
    @MultipartConfig
    class UnboundedUploadServlet {}

    // ruleid: jgates.java.request-body-without-size-limit
    @MultipartConfig(location = "/tmp", fileSizeThreshold = 1024)
    class UnboundedUploadServletTwo {}

    // ok: jgates.java.request-body-without-size-limit
    @MultipartConfig(maxFileSize = 5_000_000, maxRequestSize = 6_000_000)
    class BoundedUploadServlet {}

    void commonsUpload(ServletFileUpload upload) {
        // ruleid: jgates.java.request-body-without-size-limit
        upload.setFileSizeMax(-1);
        // ruleid: jgates.java.request-body-without-size-limit
        upload.setSizeMax(-1L);
        // ok: jgates.java.request-body-without-size-limit
        upload.setFileSizeMax(5_000_000L);
        // ok: jgates.java.request-body-without-size-limit
        upload.setSizeMax(6_000_000L);
    }

    byte[] readBody(HttpServletRequest req) throws IOException {
        // ruleid: jgates.java.request-body-without-size-limit
        return req.getInputStream().readAllBytes();
    }

    byte[] readBodyIo(HttpServletRequest req) throws IOException {
        // ruleid: jgates.java.request-body-without-size-limit
        return IOUtils.toByteArray(req.getInputStream());
    }

    byte[] readBodyBounded(HttpServletRequest req) throws IOException {
        // ok: jgates.java.request-body-without-size-limit
        return req.getInputStream().readNBytes(1_000_000);
    }

    byte[] readBodyChecked(HttpServletRequest req) throws IOException {
        if (req.getContentLengthLong() > 1_000_000L) {
            throw new IOException("body too large");
        }
        // ok: jgates.java.request-body-without-size-limit
        return req.getInputStream().readAllBytes();
    }

    // ---- upload-content-type-trusted ----
    boolean typeSpring(MultipartFile file) {
        // ruleid: jgates.java.upload-content-type-trusted
        return file.getContentType().equals("image/png");
    }

    boolean typeSpringList(MultipartFile file, List<String> allowed) {
        // ruleid: jgates.java.upload-content-type-trusted
        return allowed.contains(file.getContentType());
    }

    boolean typePart(Part part) {
        // ruleid: jgates.java.upload-content-type-trusted
        return "application/pdf".equals(part.getContentType());
    }

    boolean typeFileItem(FileItem item) {
        // ruleid: jgates.java.upload-content-type-trusted
        return item.getContentType().startsWith("image/");
    }

    boolean typeBySignature(MultipartFile file) throws IOException {
        byte[] head = file.getInputStream().readNBytes(8);
        // ok: jgates.java.upload-content-type-trusted
        return head.length == 8 && head[0] == (byte) 0x89 && head[1] == 'P';
    }

    String typeLabel(MultipartFile file) {
        // ok: jgates.java.upload-content-type-trusted
        String declared = file.getContentType();
        return declared;
    }

    // ---- content-disposition-from-request ----
    void downloadServlet(HttpServletRequest req, HttpServletResponse resp) {
        String name = req.getParameter("name");
        // ruleid: jgates.java.content-disposition-from-request
        resp.setHeader("Content-Disposition", "attachment; filename=\"" + name + "\"");
    }

    void downloadSpringHeaders(@RequestParam("file") String file, HttpHeaders headers) {
        // ruleid: jgates.java.content-disposition-from-request
        headers.add(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=" + file);
    }

    void downloadAddHeader(HttpServletRequest req, HttpServletResponse resp) {
        // ruleid: jgates.java.content-disposition-from-request
        resp.addHeader("Content-Disposition", "inline; filename=" + req.getParameter("f"));
    }

    void downloadSafe(HttpServletRequest req, HttpServletResponse resp, HttpHeaders headers) throws Exception {
        String name = req.getParameter("name");
        // ok: jgates.java.content-disposition-from-request
        resp.setHeader("Content-Disposition", ContentDisposition.attachment().filename(name).build().toString());
        // ok: jgates.java.content-disposition-from-request
        resp.setHeader("Content-Disposition", "attachment; filename=\"" + URLEncoder.encode(name, "UTF-8") + "\"");
        // ok: jgates.java.content-disposition-from-request
        headers.add(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"report.pdf\"");
        // ok: jgates.java.content-disposition-from-request
        resp.setHeader("X-Report-Name", name);
    }
}
