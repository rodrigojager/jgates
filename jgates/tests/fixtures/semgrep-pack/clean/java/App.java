import java.io.File;
import java.io.FileInputStream;
import java.net.URL;
import java.security.MessageDigest;
import java.sql.Connection;
import javax.crypto.Cipher;
import javax.net.ssl.X509TrustManager;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.xml.parsers.DocumentBuilderFactory;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import org.apache.commons.io.FilenameUtils;
import org.springframework.web.util.HtmlUtils;

public class App {
    static String validateUrl(String url) { return url; }

    void lookup(Connection conn, HttpServletRequest req, HttpServletResponse resp) throws Exception {
        String name = req.getParameter("name");
        conn.prepareStatement("SELECT * FROM users WHERE name = ?");
        Runtime.getRuntime().exec("uptime");
        new URL(validateUrl(req.getParameter("callback"))).openConnection();
        new FileInputStream(new File("/srv/data", FilenameUtils.getName(req.getParameter("file"))));
        resp.getWriter().println("<p>Hello " + HtmlUtils.htmlEscape(name) + "</p>");
    }

    void setup(X509TrustManager delegate) throws Exception {
        MessageDigest.getInstance("SHA-256");
        Cipher.getInstance("AES/GCM/NoPadding");
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        factory.newDocumentBuilder();
        X509TrustManager strict = new X509TrustManager() {
            public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                delegate.checkClientTrusted(chain, authType);
            }
            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                delegate.checkServerTrusted(chain, authType);
            }
            public X509Certificate[] getAcceptedIssuers() { return delegate.getAcceptedIssuers(); }
        };
    }

    void security(Object http) throws Exception {
        http.csrf();
    }
}
