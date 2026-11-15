import java.io.File;
import java.io.IOException;
import java.net.URLEncoder;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.springframework.http.ContentDisposition;
import org.springframework.web.multipart.MultipartFile;

class Files {
    private final File uploads = new File("/srv/uploads");

    void saveUpload(MultipartFile file) throws IOException {
        File target = new File(uploads, UUID.randomUUID().toString());
        file.transferTo(target);
    }

    void unpack(ZipInputStream zis, File dest) throws IOException {
        ZipEntry entry = zis.getNextEntry();
        while (entry != null) {
            File out = new File(dest, entry.getName());
            if (!out.getCanonicalPath().startsWith(dest.getCanonicalPath() + File.separator)) {
                throw new IOException("entry outside target");
            }
            entry = zis.getNextEntry();
        }
    }

    byte[] readBody(HttpServletRequest req) throws IOException {
        return req.getInputStream().readNBytes(1_000_000);
    }

    boolean isImage(MultipartFile file) throws IOException {
        byte[] head = file.getInputStream().readNBytes(8);
        return head.length == 8 && head[0] == (byte) 0x89 && head[1] == 'P';
    }

    void download(HttpServletRequest req, HttpServletResponse resp) {
        String name = req.getParameter("name");
        resp.setHeader("Content-Disposition", ContentDisposition.attachment().filename(name).build().toString());
    }
}
