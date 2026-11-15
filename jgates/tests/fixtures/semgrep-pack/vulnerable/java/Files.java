import java.io.File;
import java.io.IOException;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.apache.commons.io.IOUtils;
import org.springframework.web.multipart.MultipartFile;

class Files {
    private final File uploads = new File("/srv/uploads");

    void saveUpload(MultipartFile file) throws IOException {
        File target = new File(uploads, file.getOriginalFilename());
        file.transferTo(target);
    }

    void unpack(ZipInputStream zis, File dest) throws IOException {
        ZipEntry entry = zis.getNextEntry();
        while (entry != null) {
            File out = new File(dest, entry.getName());
            entry = zis.getNextEntry();
        }
    }

    byte[] readBody(HttpServletRequest req) throws IOException {
        return IOUtils.toByteArray(req.getInputStream());
    }

    boolean isImage(MultipartFile file) {
        return file.getContentType().startsWith("image/");
    }

    void download(HttpServletRequest req, HttpServletResponse resp) {
        String name = req.getParameter("name");
        resp.setHeader("Content-Disposition", "attachment; filename=\"" + name + "\"");
    }
}
