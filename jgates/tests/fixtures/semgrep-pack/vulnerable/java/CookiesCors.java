import javax.servlet.http.Cookie;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.json.MappingJacksonValue;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.cors.CorsConfiguration;

class CookiesCors {
    void login(HttpServletRequest req, HttpServletResponse resp, String token) {
        Cookie session = new Cookie("sid", token);
        resp.addCookie(session);
    }

    void allowCaller(HttpServletRequest req, HttpServletResponse resp) {
        String origin = req.getHeader("Origin");
        resp.setHeader("Access-Control-Allow-Origin", origin);
    }

    CorsConfiguration corsConfig() {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowCredentials(true);
        config.addAllowedOrigin("*");
        return config;
    }

    MappingJacksonValue wrap(Object body) {
        MappingJacksonValue value = new MappingJacksonValue(body);
        value.setJsonpFunction("handle");
        return value;
    }

    ResponseEntity<String> callback(@RequestParam("callback") String callback, String json) {
        return ResponseEntity.ok(callback + "(" + json + ")");
    }

    String reportUrl(String key) {
        return "https://api.example.com/v1/report?api_key=" + key;
    }
}
