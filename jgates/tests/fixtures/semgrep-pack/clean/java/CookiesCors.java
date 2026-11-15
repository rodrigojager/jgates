import java.util.Set;
import javax.servlet.http.Cookie;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.springframework.http.converter.json.MappingJacksonValue;
import org.springframework.web.cors.CorsConfiguration;

class CookiesCors {
    private static final Set<String> ALLOWED = Set.of("https://app.example.com");

    void login(HttpServletRequest req, HttpServletResponse resp, String token) {
        Cookie session = new Cookie("__Host-sid", token);
        session.setSecure(true);
        session.setHttpOnly(true);
        session.setAttribute("SameSite", "Lax");
        session.setPath("/");
        resp.addCookie(session);
    }

    void allowCaller(HttpServletRequest req, HttpServletResponse resp) {
        String origin = req.getHeader("Origin");
        if (ALLOWED.contains(origin)) {
            resp.setHeader("Access-Control-Allow-Origin", origin);
        }
    }

    CorsConfiguration corsConfig() {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowCredentials(true);
        config.addAllowedOrigin("https://app.example.com");
        return config;
    }

    MappingJacksonValue wrap(Object body) {
        MappingJacksonValue value = new MappingJacksonValue(body);
        return value;
    }

    void respond(HttpServletRequest req, HttpServletResponse resp, String json) throws Exception {
        resp.setContentType("application/json");
        resp.getWriter().write(json);
    }

    String reportUrl(String key) {
        return "https://api.example.com/v1/report?page=1";
    }
}
