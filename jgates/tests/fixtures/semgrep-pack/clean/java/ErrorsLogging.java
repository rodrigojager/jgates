import java.io.IOException;
import java.net.http.HttpClient;
import java.time.Duration;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class ErrorsLogging {
    private static final Logger log = LoggerFactory.getLogger(ErrorsLogging.class);
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    public void login(HttpServletRequest request, String username, String password) {
        log.info("login attempt for {}", username);
        log.debug("credential header present: {}", request.getHeader("Authorization") != null);
    }

    public void handle(HttpServletResponse response) throws IOException {
        try {
            run();
        } catch (IOException e) {
            log.error("request failed", e);
            response.sendError(500, "Internal error");
        }
        try {
            run();
        } catch (IllegalStateException e) {
            log.error("request failed", e);
            response.sendError(500, "Internal error");
        }
        try {
            run();
        } catch (RuntimeException ex) {
            log.error("request failed", ex);
            response.sendError(500, "Internal error");
        }
    }

    public void cleanup() {
        try {
            run();
        } catch (Exception e) {
            log.warn("cleanup failed", e);
        }
    }

    private void run() throws IOException {
    }
}
