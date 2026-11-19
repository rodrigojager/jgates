import java.io.File;
import java.io.FileInputStream;
import java.io.ObjectInputStream;
import java.net.URL;
import java.security.MessageDigest;
import java.sql.Statement;
import javax.crypto.Cipher;
import javax.net.ssl.X509TrustManager;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.xml.parsers.DocumentBuilderFactory;
import java.security.cert.X509Certificate;

public class App {
    void lookup(Statement stmt, HttpServletRequest req, HttpServletResponse resp) throws Exception {
        String name = req.getParameter("name");
        stmt.executeQuery("SELECT * FROM users WHERE name = '" + name + "'");
        Runtime.getRuntime().exec("ping " + name);
        new URL(req.getParameter("callback")).openConnection();
        new FileInputStream(new File("/srv/data", req.getParameter("file")));
        resp.getWriter().println("<p>Hello " + name + "</p>");
        Object restored = new ObjectInputStream(req.getInputStream()).readObject();
    }

    void setup() throws Exception {
        MessageDigest.getInstance("MD5");
        Cipher.getInstance("AES/ECB/PKCS5Padding");
        DocumentBuilderFactory.newInstance().newDocumentBuilder();
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        X509TrustManager acceptAll = new X509TrustManager() {
            public void checkClientTrusted(X509Certificate[] chain, String authType) { }
            public void checkServerTrusted(X509Certificate[] chain, String authType) { }
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
    }

    void security(Object http) throws Exception {
        http.csrf().disable();
    }
}
