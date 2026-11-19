import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.http.HttpClient;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.apache.commons.lang3.exception.ExceptionUtils;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class ErrorsLogging {
    private static final Logger log = LoggerFactory.getLogger(ErrorsLogging.class);
    private final HttpClient client = HttpClient.newHttpClient();

    public int fetch(HttpServletRequest request) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(validateUrl(request.getParameter("destination"))).openConnection();
        connection.setConnectTimeout(5000);
        connection.setReadTimeout(5000);
        return connection.getResponseCode();
    }

    private String validateUrl(String destination) throws IOException {
        URL url = new URL(destination);
        if (!"https".equals(url.getProtocol()) || !"downloads.example.com".equals(url.getHost())) {
            throw new IOException("Destination is not allowed");
        }
        return destination;
    }

    public void login(HttpServletRequest request, String username, String password) {
        log.info("login attempt for {} with {}", username, password);
        log.debug("credential header {}", request.getHeader("Authorization"));
    }

    public void handle(HttpServletResponse response) throws IOException {
        try {
            run();
        } catch (IOException e) {
            response.getWriter().println(ExceptionUtils.getStackTrace(e));
        }
        try {
            run();
        } catch (IllegalStateException e) {
            e.printStackTrace(response.getWriter());
        }
        try {
            run();
        } catch (RuntimeException ex) {
            response.sendError(500, ex.getMessage());
        }
    }

    public void cleanup() {
        try {
            run();
        } catch (Exception e) {
        }
    }

    private void run() throws IOException {
    }
}
