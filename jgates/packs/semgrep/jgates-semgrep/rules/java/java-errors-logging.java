import java.io.PrintWriter;
import java.io.StringWriter;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.http.HttpClient;
import java.time.Duration;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.apache.commons.lang3.exception.ExceptionUtils;
import org.apache.http.client.config.RequestConfig;
import org.apache.http.impl.client.HttpClientBuilder;
import org.apache.http.impl.client.HttpClients;
import org.slf4j.Logger;
import org.springframework.http.ResponseEntity;
import org.springframework.web.client.RestTemplate;

class ErrorsLoggingFixture {
    private static final Logger log = null;

    void sensitiveDataLogged(String password, String apiKey, String username, User user, Logger logger) {
        // ruleid: jgates.java.sensitive-data-logged
        log.info("login {}", password);
        // ruleid: jgates.java.sensitive-data-logged
        logger.debug("key " + apiKey);
        // ruleid: jgates.java.sensitive-data-logged
        System.out.println(user.getPassword());
        // ruleid: jgates.java.sensitive-data-logged
        log.warn("user {} token {}", username, user.getAccessToken());
        // ok: jgates.java.sensitive-data-logged
        log.info("login {}", username);
        // ok: jgates.java.sensitive-data-logged
        log.info("password was rejected for {}", username);
        // ok: jgates.java.sensitive-data-logged
        log.info("login {} with a password of {} characters", username, password.length());
        // ok: jgates.java.sensitive-data-logged
        process(password);
    }

    void sensitiveHeader(HttpServletRequest request, Logger logger) {
        // ruleid: jgates.java.sensitive-data-logged-header
        log.info("auth {}", request.getHeader("Authorization"));
        // ruleid: jgates.java.sensitive-data-logged-header
        logger.debug("header " + request.getHeader("Authorization"));
        // ok: jgates.java.sensitive-data-logged-header
        log.info("agent {}", request.getHeader("User-Agent"));
        // ok: jgates.java.sensitive-data-logged-header
        String auth = request.getHeader("Authorization");
    }

    void stackTrace(HttpServletResponse response) throws Exception {
        try {
            work();
        } catch (Exception e) {
            // ruleid: jgates.java.stack-trace-in-response
            response.getWriter().println(ExceptionUtils.getStackTrace(e));
            // ruleid: jgates.java.stack-trace-in-response
            response.getWriter().write(java.util.Arrays.toString(e.getStackTrace()));
            // ok: jgates.java.stack-trace-in-response
            log.error("request failed", e);
            // ok: jgates.java.stack-trace-in-response
            response.sendError(500, "Internal error");
        }
    }

    ResponseEntity<String> stackTraceEntity(Exception e) {
        StringWriter sw = new StringWriter();
        e.printStackTrace(new PrintWriter(sw));
        // ruleid: jgates.java.stack-trace-in-response
        return ResponseEntity.status(500).body(sw.toString());
    }

    ResponseEntity<String> stackTraceEntityClean(Exception e) {
        log.error("failed", e);
        // ok: jgates.java.stack-trace-in-response
        return ResponseEntity.status(500).body("Internal error");
    }

    void stackTracePrint(HttpServletResponse response, Exception e) throws Exception {
        // ruleid: jgates.java.stack-trace-in-response-print
        e.printStackTrace(response.getWriter());
        // ruleid: jgates.java.stack-trace-in-response-print
        e.printStackTrace(new PrintWriter(response.getWriter()));
        // ok: jgates.java.stack-trace-in-response-print
        log.error("failed", e);
        // ok: jgates.java.stack-trace-in-response-print
        e.printStackTrace(new PrintWriter(new StringWriter()));
    }

    void errorDetail(HttpServletResponse response, Exception e) throws Exception {
        // ruleid: jgates.java.error-detail-in-response
        response.getWriter().println("Error: " + e.getMessage());
        // ruleid: jgates.java.error-detail-in-response
        response.sendError(500, e.getMessage());
        // ok: jgates.java.error-detail-in-response
        response.sendError(500, "Internal error");
        // ok: jgates.java.error-detail-in-response
        log.error(e.getMessage(), e);
    }

    ResponseEntity<String> errorDetailEntity(IllegalStateException ex) {
        // ruleid: jgates.java.error-detail-in-response
        return ResponseEntity.badRequest().body(ex.getMessage());
    }

    ResponseEntity<String> errorDetailEntityClean(IllegalStateException ex) {
        log.warn("bad state", ex);
        // ok: jgates.java.error-detail-in-response
        return ResponseEntity.badRequest().body("Bad request");
    }

    void swallowed() {
        // ruleid: jgates.java.swallowed-exception
        try {
            work();
        } catch (Exception e) {
        }
        // ruleid: jgates.java.swallowed-exception
        try {
            work();
        } catch (java.io.IOException e) {
        }
        // ok: jgates.java.swallowed-exception
        try {
            work();
        } catch (Exception e) {
            log.error("work failed", e);
        }
        // ok: jgates.java.swallowed-exception
        try {
            work();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        // ok: jgates.java.swallowed-exception
        try {
            work();
        } catch (Exception ignored) {
        }
    }

    void clients(URL url) throws Exception {
        // ruleid: jgates.java.http-client-without-timeout
        HttpClient a = HttpClient.newHttpClient();
        // ruleid: jgates.java.http-client-without-timeout
        RestTemplate b = new RestTemplate();
        // ruleid: jgates.java.http-client-without-timeout
        var c = HttpClients.createDefault();
        // ruleid: jgates.java.http-client-without-timeout
        var d = HttpClientBuilder.create().build();
        // ruleid: jgates.java.http-client-without-timeout
        HttpClient e = HttpClient.newBuilder().build();
        // ok: jgates.java.http-client-without-timeout
        HttpClient f = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
        // ok: jgates.java.http-client-without-timeout
        var g = HttpClientBuilder.create().setDefaultRequestConfig(RequestConfig.custom().setSocketTimeout(5000).build()).build();
        // ok: jgates.java.http-client-without-timeout
        RestTemplate h = new RestTemplate(factory());
    }

    void connectionWithout(URL url) throws Exception {
        // ruleid: jgates.java.http-client-without-timeout
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.getResponseCode();
    }

    void connectionWith(URL url) throws Exception {
        // ok: jgates.java.http-client-without-timeout
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(5000);
        conn.setReadTimeout(5000);
        conn.getResponseCode();
    }
}
